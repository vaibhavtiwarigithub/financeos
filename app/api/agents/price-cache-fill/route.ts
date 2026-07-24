import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { shouldSkipFill } from "@/lib/markets/price-cache-universe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Daily ETF price-cache fill (display data only — NEVER on the money path).
//
// WHY THIS EXISTS
// The Markets page renders ~30 ETF tiles (regime proxies, the 11 sector XLs and
// the leveraged sentiment pairs). Each tile route used to fire its own burst of
// concurrent per-symbol Massive `/prev` calls on page load. Massive's free tier
// rate-limits at ~5 requests/minute, so most of a burst 429s and the tiles show
// "—" (and, worse, the synthesis route cached that degraded read for the day).
//
// This job pre-fills `price_cache` once per weekday, pre-market, so the tile
// routes read a warm cache instead of bursting the provider. The previous-day
// close is stable all session, so a single daily fill is enough.
//
// FREE-TIER PACING
// Massive's Polygon-compatible "grouped daily" endpoint returns EVERY US
// ticker's prior-session OHLC in ONE call. We fetch that single call and filter
// to our universe — so the whole fill costs one Massive request and trivially
// respects the ~5/min limit (no bursting, no long pacing loop). If the grouped
// endpoint is ever unavailable, we fall back to sequential per-symbol `/prev`
// calls gated by the shared `try_acquire_provider_slot` lease (12.5s = 5/min),
// bounded by wall-clock and resumable across the day's scheduled ticks.
// ─────────────────────────────────────────────────────────────────────────────

const REGIME = ["SPY", "QQQ", "IWM", "TLT", "IEF", "HYG", "UUP", "GLD", "VIXY", "DIA"];
const SECTORS = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];
const LEVERAGED = ["TQQQ", "SQQQ", "SOXL", "SOXS", "SPXL", "SPXS", "FAS", "FAZ", "UGL", "GLL"];
const UNIVERSE = Array.from(new Set([...REGIME, ...SECTORS, ...LEVERAGED]));

const MASSIVE_PACE_MS = 12_500; // 5 req/min — hard free-tier ceiling
const WALLCLOCK_BUDGET_MS = 45_000; // leave headroom under maxDuration=60s

// ── Sector history backfill ──────────────────────────────────────────────────
// The daily fill above stores ONE session per tick (the previous close), which
// is all the Markets tiles need. But Sector Performance offers 1W/1M/3M/6M/1Y
// windows, and those need real history: with only the sessions this job has
// accumulated since it was scheduled, every window collapsed onto the same two
// bars and reported a one-day move as a "1Y return".
//
// PROVIDER COST — deliberately one call per symbol, not one per day.
// Massive's `/v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` returns the FULL
// daily series in a single response (400 bars is far under the 50k page limit),
// so backfilling all 11 sector ETFs costs 11 requests total — not 11 x 400.
// Each request takes the same shared `try_acquire_provider_slot` lease as the
// fallback path (12.5s = 5/min), so this never bursts the free tier.
//
// The work is wall-clock bounded and RESUMABLE: a tick backfills whatever fits
// in its remaining budget (~3 symbols), skips symbols that already have depth,
// and the next scheduled tick drains the rest. The universe finishes within a
// couple of days unattended, or immediately via ?backfill=1 re-runs. No new
// cron and no schema change are required — this rides the existing schedule.
const BACKFILL_DAYS = 400; // > 365 so the 1Y window has margin at the start edge
const BACKFILL_UNIVERSE = SECTORS; // sector-returns is the only period-windowed consumer

interface Bar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Most recent completed weekday session (ignoring market holidays — those just
// cost one extra grouped call that returns empty, and we walk back another day).
function mostRecentWeekday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return ymd(d);
}

interface GroupedAgg { T?: string; o?: number; c?: number; h?: number; l?: number; v?: number }

// Fetch one grouped-daily snapshot for `date`, filtered to our universe.
// Returns { status: "ok", bars } on data, "empty" for a non-trading day,
// "retry" for a transient 429, or "error" for an entitlement/other failure.
async function fetchGroupedForDate(
  date: string,
  apiKey: string,
): Promise<{ status: "ok"; bars: Bar[] } | { status: "empty" | "retry" | "error" }> {
  const universe = new Set(UNIVERSE);
  try {
    const res = await fetch(
      `https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${apiKey}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25_000), cache: "no-store" },
    );
    if (res.status === 429) return { status: "retry" };
    if (!res.ok) return { status: "error" };
    const data: { results?: GroupedAgg[] } = await res.json();
    const results = data.results ?? [];
    if (results.length === 0) return { status: "empty" };
    const bars: Bar[] = [];
    for (const r of results) {
      if (!r.T || !universe.has(r.T) || r.o == null || r.c == null) continue;
      bars.push({
        symbol: r.T,
        date,
        open: r.o,
        high: r.h ?? r.o,
        low: r.l ?? r.o,
        close: r.c,
        // Grouped-daily returns volume as a FLOAT; price_cache.volume is bigint,
        // so round or the whole upsert batch is rejected.
        volume: r.v != null ? Math.round(r.v) : null,
      });
    }
    return { status: "ok", bars };
  } catch {
    return { status: "error" };
  }
}

// Single-symbol previous-session bar (fallback path only).
async function fetchPrev(symbol: string, apiKey: string): Promise<Bar | null> {
  try {
    const res = await fetch(
      `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000), cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results?.[0];
    if (!r || r.o == null || r.c == null) return null;
    return {
      symbol,
      date: r.t ? ymd(new Date(r.t)) : mostRecentWeekday(),
      open: r.o,
      high: r.h ?? r.o,
      low: r.l ?? r.o,
      close: r.c,
      volume: r.v != null ? Math.round(r.v) : null,
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RangeAgg { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number }

// Full daily series for one symbol in ONE provider call (see BACKFILL_DAYS note).
// Follows `next_url` defensively — Massive paginates regardless of `limit` — but
// a 400-bar range fits in a single page in practice.
async function fetchDailyRange(
  symbol: string,
  from: string,
  to: string,
  apiKey: string,
): Promise<Bar[] | null> {
  const bars: Bar[] = [];
  let url: string | null =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  let pages = 0;
  try {
    while (url && pages < 5) {
      pages++;
      const res: Response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      if (!res.ok) return null; // 429/entitlement — leave it for a later tick
      const data: { results?: RangeAgg[]; next_url?: string } = await res.json();
      for (const r of data.results ?? []) {
        if (r.t == null || r.o == null || r.c == null) continue;
        bars.push({
          symbol,
          date: ymd(new Date(r.t)),
          open: r.o,
          high: r.h ?? r.o,
          low: r.l ?? r.o,
          close: r.c,
          // price_cache.volume is bigint — aggs return a float, so round or the
          // whole upsert batch is rejected (same trap as the grouped path).
          volume: r.v != null ? Math.round(r.v) : null,
        });
      }
      url = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
    }
  } catch {
    return null;
  }
  return bars;
}

/**
 * Backfill daily history for the sector universe, paced + bounded + resumable.
 * Only touches symbols whose cached history does not already reach `from`.
 */
async function backfillSectorHistory(
  svc: ReturnType<typeof createServiceClient>,
  apiKey: string,
  started: number,
): Promise<{ attempted: string[]; filled: string[]; remaining: string[]; bars: number }> {
  const to = mostRecentWeekday();
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - BACKFILL_DAYS);
  const from = ymd(fromDate);
  // A symbol counts as backfilled once its oldest bar sits within a week of the
  // target start — the true first session may lag `from` over a holiday weekend.
  const satisfiedBefore = ymd(new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000));

  const needs: string[] = [];
  for (const symbol of BACKFILL_UNIVERSE) {
    const { data: oldest } = await svc
      .from("price_cache")
      .select("date")
      .eq("symbol", symbol)
      .order("date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!oldest || (oldest as { date: string }).date > satisfiedBefore) needs.push(symbol);
  }

  const attempted: string[] = [];
  const filled: string[] = [];
  let barCount = 0;

  for (const symbol of needs) {
    // Reserve room for one paced call plus the fetch itself before committing.
    if (Date.now() - started > WALLCLOCK_BUDGET_MS - MASSIVE_PACE_MS) break;
    const { data: slot } = await svc.rpc("try_acquire_provider_slot", {
      p_provider: "massive",
      p_min_interval_ms: MASSIVE_PACE_MS,
    });
    if (slot !== true) { await sleep(1_000); continue; }
    attempted.push(symbol);
    const bars = await fetchDailyRange(symbol, from, to, apiKey);
    if (!bars || bars.length === 0) continue;
    const up = await upsertBars(svc, bars);
    if (!up.ok) continue; // surfaced by the caller's coverage check next tick
    filled.push(symbol);
    barCount += bars.length;
  }

  return { attempted, filled, remaining: needs.filter((s) => !filled.includes(s)), bars: barCount };
}

// Persist the fetched bars. Returns the error message on failure so the caller
// reports honestly instead of counting fetched-but-unpersisted bars as "filled".
async function upsertBars(
  svc: ReturnType<typeof createServiceClient>,
  bars: Bar[],
): Promise<{ ok: boolean; error?: string }> {
  for (let i = 0; i < bars.length; i += 500) {
    const { error } = await svc.from("price_cache").upsert(bars.slice(i, i + 500), {
      onConflict: "symbol,date",
      ignoreDuplicates: false,
    });
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function run(force: boolean) {
  const started = Date.now();
  const svc = createServiceClient();
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "MASSIVE_API_KEY not configured", filled: 0 };
  }

  const expected = mostRecentWeekday();
  const issueKey = "price-cache-fill-degraded";

  // Idempotency: skip only when the ENTIRE universe already has the most-recent
  // session. `force` bypasses this.
  //
  // This used to probe SPY ALONE as a marker symbol. But the grouped fill writes
  // the whole universe in one shot, so one fresh marker does not imply the rest
  // are fresh — and it silently didn't. An off-schedule run advanced SPY to the
  // latest session; every scheduled tick afterward saw "SPY >= expected", skipped
  // the grouped fill, and left XLK/QQQ/DIA frozen a session behind (prod: SPY at
  // 07-16, XLK/QQQ stuck at 07-15). One bellwether masked 30 stale symbols. The
  // grouped call is a single request, so re-running it when even one symbol lags
  // is cheap; freezing the universe to save that call is not a trade worth making.
  if (!force) {
    const { data: freshRows } = await svc
      .from("price_cache")
      .select("symbol")
      .in("symbol", UNIVERSE)
      .gte("date", expected);
    const freshSymbols = (freshRows ?? []).map((r: { symbol: string }) => r.symbol);
    const freshCount = new Set(freshSymbols).size;
    if (shouldSkipFill(freshSymbols, UNIVERSE)) {
      // The universe is fully fresh, so any open degraded alert is stale — a
      // prior tick's shortfall has since been filled (often by other jobs that
      // write price_cache). Without this, the skip path returned before ever
      // reaching resolveIssue, so a degraded alert only cleared at midnight
      // auto-expire instead of on recovery (prod: 3/31 alert lingered 7 days).
      await resolveIssue(issueKey, svc);
      // The daily session is already cached, but sector HISTORY may still be
      // draining — spend this tick's budget on the backfill rather than no-op.
      const backfill = await backfillSectorHistory(svc, apiKey, started);
      return {
        ok: true,
        skipped: true,
        reason: `already filled for most recent session (${freshCount}/${UNIVERSE.length})`,
        date: expected,
        filled: 0,
        backfill,
        elapsedMs: Date.now() - started,
      };
    }
  }

  // ── Primary path: one grouped-daily call for the whole universe ──
  let chosenDate: string | null = null;
  let bars: Bar[] = [];
  let source: "grouped" | "per-symbol" = "grouped";
  let groupedError = false;
  let attempts = 0;

  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  for (let step = 0; step < 6; step++) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { d.setUTCDate(d.getUTCDate() - 1); step--; continue; }
    if (attempts > 0 && Date.now() - started > WALLCLOCK_BUDGET_MS) break; // stay under maxDuration
    const date = ymd(d);
    if (attempts > 0) await sleep(MASSIVE_PACE_MS); // pace only between real calls
    attempts++;
    const r = await fetchGroupedForDate(date, apiKey);
    if (r.status === "ok" && r.bars.length > 0) { chosenDate = date; bars = r.bars; break; }
    if (r.status === "empty") { d.setUTCDate(d.getUTCDate() - 1); continue; } // holiday — walk back
    if (r.status === "retry") { continue; } // 429 — pace and retry the same date next loop
    // "error" → entitlement/other; abandon grouped, fall back to per-symbol
    groupedError = true;
    break;
  }

  // ── Sector history backfill ──
  // Runs BEFORE the per-symbol fallback, deliberately. On a normal tick the
  // grouped call above costs ~3s and leaves ~40s spare, so ordering is moot.
  // But when grouped fails, the fallback below will consume the entire budget
  // and the backfill would be starved indefinitely — the sector windows would
  // never fill in. Going first also costs the daily fill nothing for these
  // symbols: the range call spans up to the most recent session, so a
  // backfilled sector is daily-filled by the same request, and the fallback's
  // "already have this session" query then skips it.
  const backfill = await backfillSectorHistory(svc, apiKey, started);

  // ── Fallback path: sequential per-symbol /prev, paced + bounded + resumable ──
  if (!chosenDate && groupedError) {
    source = "per-symbol";
    // Only fetch symbols that don't already have the expected session cached, so
    // repeated ticks drain the universe rather than re-fetching filled names.
    const { data: existing } = await svc
      .from("price_cache")
      .select("symbol")
      .in("symbol", UNIVERSE)
      .gte("date", expected);
    const have = new Set((existing ?? []).map((r: { symbol: string }) => r.symbol));
    const missing = UNIVERSE.filter((s) => !have.has(s));
    for (const symbol of missing) {
      if (Date.now() - started > WALLCLOCK_BUDGET_MS) break;
      // Shared serverless-safe lease: only proceed when the 5/min slot is free.
      const { data: slot } = await svc.rpc("try_acquire_provider_slot", {
        p_provider: "massive",
        p_min_interval_ms: MASSIVE_PACE_MS,
      });
      if (slot !== true) { await sleep(1_000); continue; }
      const bar = await fetchPrev(symbol, apiKey);
      if (bar) { bars.push(bar); chosenDate = chosenDate ?? bar.date; }
    }
  }

  // Persist. A failed write must NOT be reported as a successful fill — surface
  // it as a health issue and return ok:false so the retry tick tries again.
  // (issueKey is declared once at the top of run() so the skip path can resolve it.)
  if (bars.length > 0) {
    const up = await upsertBars(svc, bars);
    if (!up.ok) {
      await reportIssue({
        issueKey,
        severity: "warn",
        category: "data",
        title: "Markets price-cache write failed",
        detail: `Fetched ${bars.length} bars via ${source} but the price_cache upsert failed: ${up.error}. Markets tiles will fall back to lazy fetch until a later tick succeeds.`,
        autoExpireAt: nextUtcMidnight(),
      }, svc);
      return { ok: false, source, error: up.error, date: chosenDate, universe: UNIVERSE.length, filled: 0, elapsedMs: Date.now() - started };
    }
  }

  // A symbol backfilled this tick also received the most recent session (the
  // range call runs up to `mostRecentWeekday`), so it counts as filled — else
  // the coverage check below false-alarms about sectors it just populated.
  const filledSymbols = new Set([...bars.map((b) => b.symbol), ...backfill.filled]);
  const filled = filledSymbols.size;
  const missing = UNIVERSE.filter((s) => !filledSymbols.has(s));
  const coverage = filled / UNIVERSE.length;

  // System Health: only alert on a LARGE shortfall (a couple of illiquid ETFs
  // missing from one grouped snapshot is normal). Auto-clears at UTC midnight.
  if (source === "per-symbol" && filled === 0) {
    await reportIssue({
      issueKey,
      severity: "warn",
      category: "data",
      title: "Markets price-cache fill made no progress",
      detail: `Grouped endpoint failed and the per-symbol fallback filled 0/${UNIVERSE.length} ETFs this tick. Markets tiles will fall back to lazy fetch until a later tick catches up.`,
      autoExpireAt: nextUtcMidnight(),
    }, svc);
  } else if (coverage < 0.6) {
    await reportIssue({
      issueKey,
      severity: "warn",
      category: "data",
      title: `Markets price-cache fill incomplete (${filled}/${UNIVERSE.length})`,
      detail: `Only ${filled} of ${UNIVERSE.length} Markets ETFs filled via ${source}. Missing: ${missing.join(", ")}. Display tiles for the missing names may show "—".`,
      autoExpireAt: nextUtcMidnight(),
    }, svc);
  } else {
    await resolveIssue(issueKey, svc);
  }

  return {
    ok: filled > 0,
    source,
    date: chosenDate,
    universe: UNIVERSE.length,
    filled,
    missing,
    attempts,
    backfill,
    elapsedMs: Date.now() - started,
  };
}

function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// POST — cron-gated (pg_cron sends x-cron-secret) OR owner-gated for manual runs.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const force = new URL(req.url).searchParams.get("force") === "true" || new URL(req.url).searchParams.get("force") === "1";
  const result = await run(force);
  return NextResponse.json(result);
}

// GET — owner-only convenience trigger (same work), so it can be run from a browser.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const result = await run(false);
  return NextResponse.json(result);
}
