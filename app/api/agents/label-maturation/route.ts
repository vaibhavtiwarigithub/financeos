import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runAccountingEnvelope } from "@/lib/monitoring/run-accounting";
import { fetchYahooCandles } from "@/lib/india-data";
import { computeLabel } from "@/lib/learning/label-math";
import {
  ATR_EXIT_POLICY_VERSION,
  computeAtrExitOutcomes,
  readEntryAtr,
} from "@/lib/learning/atr-exit-evidence";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchUsCandles } from "@/lib/data/candles";
import {
  CandleResolver,
  SkipLedger,
  epochDay,
  forwardWindow,
  rotatingOffset,
} from "@/lib/learning/label-window";

export const dynamic = "force-dynamic";
// Needs Vercel Pro (300s cap) or higher for large backlogs.
export const maxDuration = 300;

// Phase 1 learning-core: nightly maturation of decision_observations into
// observation_labels. A horizon (2/5/10/20 trading days) is "matured" once
// enough calendar time has passed for that many trading days to have occurred.
// Fails soft everywhere — a missing table/candle never fails the whole run.
//
// 2026-08-16 (W7/W8): candle resolution moved to lib/learning/label-window.ts,
// which decides on forward-session COVERAGE rather than row existence, and the
// per-horizon budget is now split scan-vs-success with a rotating second pass
// so a permanently-failing oldest prefix cannot starve newer observations.

// 2026-08-17: h60 and h120 added. Evaluation horizon is DECOUPLED from holding
// period (the mandate trades a 5-15 day hold) — these labels answer "are we
// exiting too early", which the <=20d labels structurally cannot.
//
// They produce nothing until roughly 2026-09-29: maturityCutoff(60) is now-85d
// and the oldest observation is 2026-07-06, so every h60/h120 page comes back
// empty and exits immediately. That is the point — maturation is calendar-bound
// and cannot be compressed, so the clock has to start before the answer is
// wanted. Cost until then is two empty queries per run.
const HORIZONS = [2, 5, 10, 20, 60, 120] as const;

/** India provider range. The resolver fetches each symbol at most ONCE per run
 *  (providerTried is keyed market:symbol), so this single fetch has to satisfy
 *  the LONGEST horizon — the previous "3mo" (~63 bars) could never cover a
 *  120-session forward window, and would have starved h60/h120 silently. */
const INDIA_PROVIDER_RANGE = "2y";

const PAGE_SIZE = 200;
/** Labels to produce per horizon per run. */
const SUCCESS_BUDGET = 200;
/** Observations we are willing to EXAMINE per horizon per run. Decoupled from
 *  SUCCESS_BUDGET: skipped rows must not consume the label budget. */
const SCAN_CAP = 2000;

// Approximate trading days as calendar days × 7/5, +1 buffer for weekends/holidays.
function maturityCutoff(horizonDays: number): string {
  const calendarDays = Math.ceil(horizonDays * (7 / 5)) + 1;
  return new Date(Date.now() - calendarDays * 86400_000).toISOString();
}

function makeResolver(svc: any): CandleResolver {
  return new CandleResolver({
    cache: async (market, symbol, since) => {
      if (market === "india") return []; // no India rows in price_cache
      const { data } = await svc
        .from("price_cache")
        .select("date, close, high, low")
        .eq("symbol", symbol)
        .gte("date", since)
        .order("date", { ascending: true });
      return (data ?? []).map((c: any) => ({
        date: c.date,
        close: parseFloat(c.close),
        high: parseFloat(c.high ?? c.close),
        low: parseFloat(c.low ?? c.close),
      }));
    },
    provider: async (market, symbol) => {
      if (market === "india") {
        const raw = await fetchYahooCandles(symbol, INDIA_PROVIDER_RANGE);
        return raw.map((c: any) => ({ date: c.date, close: c.close, high: c.high, low: c.low }));
      }
      // Research does not guarantee that every observed US symbol is written to
      // price_cache, and a present-but-stale row must not suppress this fetch.
      // US needs no explicit range: lib/data/candles.ts fetches Yahoo at range=1y
      // (~251 bars), which already covers a 120-session forward window.
      const resolved = await fetchUsCandles(symbol, async () => [], 3);
      if (resolved.candles.length > 0) {
        const rows = resolved.candles.map((c) => ({
          symbol, date: c.date, open: c.open, high: c.high, low: c.low,
          close: c.close, volume: c.volume, cached_at: new Date().toISOString(),
        }));
        try { await svc.from("price_cache").upsert(rows, { onConflict: "symbol,date" }); }
        catch { /* cache warm is best-effort; the label still uses the fetch */ }
      }
      return resolved.candles.map((c) => ({ date: c.date, close: c.close, high: c.high, low: c.low }));
    },
  });
}

type PendingPage = { rows: any[]; scanned: number; exhausted: boolean };

/** One raw page of eligible observations, minus those already labelled at this
 *  horizon under the current ATR policy version. `scanned` is the RAW count —
 *  what the scan budget spends — not the unlabelled remainder. */
async function pendingPage(
  svc: any,
  horizonDays: number,
  cutoff: string,
  marketScope: "us" | "india" | null,
  offset: number,
): Promise<PendingPage> {
  let query = svc.from("decision_observations")
    .select("id, ts, market, symbol, price_at_decision, currency, features")
    .lte("ts", cutoff)
    .order("ts", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (marketScope) query = query.eq("market", marketScope);
  const { data: observations, error: observationError } = await query;
  if (observationError || !observations?.length) return { rows: [], scanned: 0, exhausted: true };

  const { data: labels, error: labelError } = await svc
    .from("observation_labels")
    .select("observation_id, atr_policy_version")
    .eq("horizon_days", horizonDays)
    .in("observation_id", observations.map((row: any) => row.id));
  if (labelError) return { rows: [], scanned: observations.length, exhausted: true };

  const current = new Set((labels ?? [])
    .filter((label: any) => label.atr_policy_version === ATR_EXIT_POLICY_VERSION)
    .map((label: any) => label.observation_id));
  return {
    rows: observations.filter((row: any) => !current.has(row.id)),
    scanned: observations.length,
    exhausted: observations.length < PAGE_SIZE,
  };
}

async function eligibleTotal(
  svc: any,
  cutoff: string,
  marketScope: "us" | "india" | null,
): Promise<number> {
  try {
    let q = svc.from("decision_observations")
      .select("id", { count: "exact", head: true })
      .lte("ts", cutoff);
    if (marketScope) q = q.eq("market", marketScope);
    const { count } = await q;
    return count ?? 0;
  } catch { return 0; }
}

type Ctx = {
  svc: any;
  resolver: CandleResolver;
  skips: SkipLedger;
  atrLabeled: number;
  atrUnavailable: number;
};

/** Label one observation at one horizon. Returns true when a label was written. */
async function labelOne(ctx: Ctx, obs: any, horizonDays: number): Promise<boolean> {
  const market = String(obs.market ?? "us");
  const symbol = String(obs.symbol ?? "?");
  try {
    const decisionDate = String(obs.ts).slice(0, 10);
    const since = new Date(new Date(obs.ts).getTime() - 5 * 86400_000).toISOString().slice(0, 10);
    const candles = await ctx.resolver.resolve(market, symbol, decisionDate, horizonDays, since);
    if (candles.length === 0) { ctx.skips.add("no_candles", market, symbol); return false; }

    const window = forwardWindow(candles, decisionDate, horizonDays);
    // Not matured yet, or the provider genuinely has no forward sessions — a
    // real, reportable reason rather than a silent zero.
    if (!window) { ctx.skips.add("window_incomplete", market, symbol); return false; }

    const entryPrice = obs.price_at_decision ?? window.entry.close ?? null;
    if (entryPrice == null) { ctx.skips.add("no_entry_price", market, symbol); return false; }

    // Benchmark: SPY for us, ^NSEI for india, same window.
    let benchmarkReturn: number | null = null;
    try {
      const benchSymbol = market === "india" ? "^NSEI" : "SPY";
      const benchCandles = await ctx.resolver.resolve(market, benchSymbol, decisionDate, horizonDays, since);
      const benchWindow = forwardWindow(benchCandles, decisionDate, horizonDays);
      if (benchWindow) {
        const benchEntry = benchWindow.entry.close;
        const benchExit = benchWindow.after[horizonDays - 1].close;
        benchmarkReturn = (benchExit - benchEntry) / benchEntry;
      }
    } catch { /* benchmark optional — label still inserted */ }

    const entryAtr = readEntryAtr(obs.features);
    const label = computeLabel(entryPrice, window.after, horizonDays, benchmarkReturn, entryAtr);
    if (!label) { ctx.skips.add("label_unavailable", market, symbol); return false; }
    const atrExitOutcomes = computeAtrExitOutcomes(entryPrice, entryAtr, window.after, horizonDays);

    const { error: insErr } = await ctx.svc.from("observation_labels").upsert({
      observation_id: obs.id,
      horizon_days: horizonDays,
      fwd_return: label.fwdReturn,
      benchmark_return: benchmarkReturn,
      benchmark_neutral_return: label.benchmarkNeutralReturn,
      max_adverse_excursion: label.maxAdverseExcursion,
      max_favorable_excursion: label.maxFavorableExcursion,
      entry_price: label.entryPrice,
      exit_price: label.exitPrice,
      entry_atr: label.entryAtr,
      entry_atr_pct: label.entryAtrPct,
      max_adverse_excursion_atr: label.maxAdverseExcursionAtr,
      max_favorable_excursion_atr: label.maxFavorableExcursionAtr,
      atr_exit_outcomes: atrExitOutcomes,
      atr_policy_version: ATR_EXIT_POLICY_VERSION,
    }, { onConflict: "observation_id,horizon_days" });
    if (insErr) { ctx.skips.add("insert_failed", market, symbol); return false; }
    if (atrExitOutcomes) ctx.atrLabeled++;
    else ctx.atrUnavailable++;
    return true;
  } catch {
    ctx.skips.add("exception", market, symbol);
    return false;
  }
}

/**
 * Scan forward from `startOffset`, labelling until `successBudget` labels are
 * produced or `scanCap` observations have been examined. Skipped rows spend the
 * scan budget only — this is what stops a permanently-failing prefix from
 * consuming every run.
 */
async function runPass(
  ctx: Ctx,
  horizonDays: number,
  cutoff: string,
  marketScope: "us" | "india" | null,
  startOffset: number,
  successBudget: number,
  scanCap: number,
  seen: Set<string>,
): Promise<{ produced: number; scanned: number }> {
  let produced = 0, scanned = 0;
  const BATCH = 8;

  for (let offset = startOffset; scanned < scanCap && produced < successBudget; offset += PAGE_SIZE) {
    const page = await pendingPage(ctx.svc, horizonDays, cutoff, marketScope, offset);
    scanned += page.scanned;

    // Group by market/symbol so the resolver's per-symbol fetch is shared and
    // consecutive work hits the same key. Coverage is still checked per row.
    const fresh = page.rows
      .filter((row: any) => !seen.has(`${row.id}:${horizonDays}`))
      .sort((a: any, b: any) =>
        `${a.market}:${a.symbol}`.localeCompare(`${b.market}:${b.symbol}`) ||
        String(a.ts).localeCompare(String(b.ts)));
    for (const row of fresh) seen.add(`${row.id}:${horizonDays}`);

    for (let i = 0; i < fresh.length && produced < successBudget; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map((obs: any) => labelOne(ctx, obs, horizonDays)));
      produced += results.filter((r) => r.status === "fulfilled" && r.value).length;
      if (i + BATCH < fresh.length) await new Promise((r) => setTimeout(r, 300));
    }

    if (page.exhausted) break;
  }
  return { produced, scanned };
}

async function runMaturation(marketScope: "us" | "india" | null) {
  const svc = createServiceClient();
  const ctx: Ctx = { svc, resolver: makeResolver(svc), skips: new SkipLedger(), atrLabeled: 0, atrUnavailable: 0 };
  let matured = 0, scanned = 0;

  for (const horizonDays of HORIZONS) {
    const cutoff = maturityCutoff(horizonDays);
    const total = await eligibleTotal(svc, cutoff, marketScope);
    const seen = new Set<string>();

    // Half the capacity to the oldest eligible work, half to a rotating cursor.
    const half = Math.floor(SUCCESS_BUDGET / 2);
    const oldest = await runPass(ctx, horizonDays, cutoff, marketScope, 0, half, Math.floor(SCAN_CAP / 2), seen);
    const rotated = await runPass(
      ctx, horizonDays, cutoff, marketScope,
      rotatingOffset(total, PAGE_SIZE, epochDay()),
      SUCCESS_BUDGET - oldest.produced, SCAN_CAP - oldest.scanned, seen,
    );
    matured += oldest.produced + rotated.produced;
    scanned += oldest.scanned + rotated.scanned;
  }

  return {
    matured,
    skipped: ctx.skips.total,
    scanned,
    atrLabeled: ctx.atrLabeled,
    atrUnavailable: ctx.atrUnavailable,
    providerFetches: ctx.resolver.providerFetches,
    skipReasons: ctx.skips.byReason,
    skipSymbols: ctx.skips.topSymbols(),
    // Detector surface — the exact incident signature ({matured:0, skipped:800}).
    // A fully-drained backlog yields matured=0 AND skipped=0, which stays healthy;
    // rejecting work while producing nothing does not.
    zeroOutputWithPending: matured === 0 && ctx.skips.total > 0,
    market: marketScope ?? "all",
  };
}

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mktParam = new URL(req.url).searchParams.get("market");
  const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

  try {
    const result = await runMaturation(marketScope);
    // Bookkeeping row so stale-check (P0 improvement) can see this ran today.
    try {
      const svc = createServiceClient();
      const reasons = Object.entries(result.skipReasons)
        .map(([reason, n]) => `${reason}=${n}`).join(" ") || "none";
      // W6 run-accounting envelope. skipped obs are unavailable (data missing) not failed;
      // zeroOutputWithPending is the incident signature from the 2026-08 pipeline incident.
      //
      // `eligible` is the units this run ATTEMPTED (matured + skipped), NOT
      // `result.scanned`. Scanned is the raw paged-through count, and the W8
      // loader deliberately pages PAST unlabelable rows on a scan budget — those
      // rows were never units this run owned. Passing scanned made the envelope
      // unbalanceable by construction (eligible 6324 vs 494 accounted) and fired
      // a critical "5830 units unaccounted for" every single night. A monitor
      // that cries wolf nightly is worse than no monitor. Scanned is telemetry.
      const attempted = result.matured + result.skipped;
      const accounting = runAccountingEnvelope({
        job: `label-maturation:${result.market}`,
        market: result.market === "us" || result.market === "india" ? result.market : undefined,
        eligible: attempted,
        succeeded: result.matured,
        expectedSkip: 0,
        deferred: 0,
        unavailable: result.skipped,
        failed: 0,
        skipReasons: result.skipReasons,
        businessMetrics: {
          atr_labeled: result.atrLabeled,
          provider_fetches: result.providerFetches,
          scanned: result.scanned,
        },
      });
      await svc.from("agent_runs").insert({
        agent_type: "label_maturation",
        // A zero-output run over a non-empty backlog must not read as "done".
        status: result.zeroOutputWithPending ? "error" : "done",
        trigger_source: isCron ? "scheduled" : "manual",
        result_summary: `Matured ${result.matured}, skipped ${result.skipped} (${reasons}), scanned ${result.scanned}, ATR ${result.atrLabeled}/${result.matured} (${result.market}).`,
        workload_metrics: accounting,
        completed_at: new Date().toISOString(),
      } as any);
    } catch { /* best-effort */ }
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
