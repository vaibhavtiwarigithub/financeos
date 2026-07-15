import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";

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

  // Idempotency: if the most-recent session is already cached for our marker
  // symbol, skip (a second daily tick or a manual re-run is a no-op). `force`
  // bypasses this.
  if (!force) {
    const { data: probe } = await svc
      .from("price_cache")
      .select("date")
      .eq("symbol", "SPY")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (probe && (probe as { date: string }).date >= expected) {
      return { ok: true, skipped: true, reason: "already filled for most recent session", date: (probe as { date: string }).date, filled: 0 };
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
  const issueKey = "price-cache-fill-degraded";
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

  const filledSymbols = new Set(bars.map((b) => b.symbol));
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
