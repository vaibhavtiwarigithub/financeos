import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchYahooCandles } from "@/lib/india-data";
import { computeLabel } from "@/lib/learning/label-math";
import {
  ATR_EXIT_POLICY_VERSION,
  computeAtrExitOutcomes,
  readEntryAtr,
} from "@/lib/learning/atr-exit-evidence";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchUsCandles } from "@/lib/data/candles";

export const dynamic = "force-dynamic";
// Needs Vercel Pro (300s cap) or higher for large backlogs.
export const maxDuration = 300;

// Phase 1 learning-core: nightly maturation of decision_observations into
// observation_labels. A horizon (2/5/10/20 trading days) is "matured" once
// enough calendar time has passed for that many trading days to have occurred.
// Fails soft everywhere — a missing table/candle never fails the whole run.

const HORIZONS = [2, 5, 10, 20] as const;

// Approximate trading days as calendar days × 7/5, +1 buffer for weekends/holidays.
function maturityCutoff(horizonDays: number): string {
  const calendarDays = Math.ceil(horizonDays * (7 / 5)) + 1;
  return new Date(Date.now() - calendarDays * 86400_000).toISOString();
}

type Candle = { date: string; close: number; high: number; low: number };

async function usCandles(supabase: any, symbol: string, sinceDate: string): Promise<Candle[]> {
  const { data } = await supabase
    .from("price_cache")
    .select("date, close, high, low")
    .eq("symbol", symbol)
    .gte("date", sinceDate)
    .order("date", { ascending: true });
  const cached = (data ?? []).map((c: any) => ({
    date: c.date, close: parseFloat(c.close), high: parseFloat(c.high ?? c.close), low: parseFloat(c.low ?? c.close),
  }));
  if (cached.length > 0) return cached;

  // Research does not guarantee that every observed US symbol is written to
  // price_cache. Without this provider fallback, labels for those observations
  // can never mature (the production table had no matching US rows).
  const resolved = await fetchUsCandles(symbol, async () => [], 3);
  const candles = resolved.candles
    .filter(c => c.date >= sinceDate)
    .map(c => ({ date: c.date, close: c.close, high: c.high, low: c.low }));
  if (resolved.candles.length > 0) {
    const rows = resolved.candles.map(c => ({
      symbol, date: c.date, open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, cached_at: new Date().toISOString(),
    }));
    await supabase.from("price_cache").upsert(rows, { onConflict: "symbol,date" });
  }
  return candles;
}

async function indiaCandles(symbol: string): Promise<Candle[]> {
  const raw = await fetchYahooCandles(symbol, "3mo");
  return raw.map(c => ({ date: c.date, close: c.close, high: c.high, low: c.low }));
}

async function candlesFor(supabase: any, market: string, symbol: string, sinceDate: string): Promise<Candle[]> {
  if (market === "india") return indiaCandles(symbol);
  return usCandles(supabase, symbol, sinceDate);
}

async function loadPendingObservations(
  svc: any,
  horizonDays: number,
  cutoff: string,
  marketScope: "us" | "india" | null
): Promise<any[]> {
  const pending: any[] = [];
  const PAGE_SIZE = 200;
  // Page past completed observations instead of repeatedly anti-joining only
  // the oldest page, which can permanently starve newer labels.
  for (let offset = 0; pending.length < PAGE_SIZE; offset += PAGE_SIZE) {
    let query = svc.from("decision_observations")
      .select("id, ts, market, symbol, price_at_decision, currency, features")
      .lte("ts", cutoff)
      .order("ts", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (marketScope) query = query.eq("market", marketScope);
    const { data: observations, error: observationError } = await query;
    if (observationError || !observations?.length) break;

    const { data: labels, error: labelError } = await svc
      .from("observation_labels")
      .select("observation_id, atr_policy_version")
      .eq("horizon_days", horizonDays)
      .in("observation_id", observations.map((row: any) => row.id));
    if (labelError) break;
    const current = new Set((labels ?? [])
      .filter((label: any) => label.atr_policy_version === ATR_EXIT_POLICY_VERSION)
      .map((label: any) => label.observation_id));
    pending.push(...observations.filter((row: any) => !current.has(row.id)));
    if (observations.length < PAGE_SIZE) break;
  }
  return pending.slice(0, PAGE_SIZE);
}

async function runMaturation(marketScope: "us" | "india" | null) {
  const svc = createServiceClient();
  let matured = 0, skipped = 0, atrLabeled = 0, atrUnavailable = 0;
  // One provider fetch per symbol per run. The same symbol is otherwise fetched
  // once for every observation and horizon, causing a request stampede.
  const candleMemo = new Map<string, Promise<Candle[]>>();
  const getCandles = (market: string, symbol: string, sinceDate: string) => {
    // Observations are processed oldest-first, so the first request has the
    // broadest needed window; later observations can safely reuse it.
    const key = `${market}:${symbol}`;
    let pending = candleMemo.get(key);
    if (!pending) {
      pending = candlesFor(svc, market, symbol, sinceDate);
      candleMemo.set(key, pending);
    }
    return pending;
  };

  for (const horizonDays of HORIZONS) {
    const cutoff = maturityCutoff(horizonDays);

    const pending = await loadPendingObservations(svc, horizonDays, cutoff, marketScope);
    if (pending.length === 0) continue;

    // Batch candle fetches, ~8 parallel with a pause, matching scan/india/refresh style.
    const BATCH = 8;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (obs: any) => {
        try {
          const sinceDate = new Date(new Date(obs.ts).getTime() - 5 * 86400_000).toISOString().slice(0, 10);
          const candles = await getCandles(obs.market, obs.symbol, sinceDate);
          if (candles.length === 0) { skipped++; return; }

          const decisionDate = String(obs.ts).slice(0, 10);
          // Entry price: stored price_at_decision, else first candle on/after decision date.
          const onOrAfter = candles.filter(c => c.date >= decisionDate);
          const entryPrice = obs.price_at_decision ?? onOrAfter[0]?.close ?? null;
          if (entryPrice == null || onOrAfter.length === 0) { skipped++; return; }

          // Window = first H candles strictly after the entry date.
          const afterEntry = onOrAfter.filter(c => c.date > onOrAfter[0].date);
          if (afterEntry.length < horizonDays) { skipped++; return; } // not matured yet — next run

          // Benchmark: SPY for us, ^NSEI for india, same window.
          let benchmarkReturn: number | null = null;
          try {
            const benchSymbol = obs.market === "india" ? "^NSEI" : "SPY";
            const benchCandles = await getCandles(obs.market, benchSymbol, sinceDate);
            const benchOnOrAfter = benchCandles.filter(c => c.date >= decisionDate);
            const benchEntry = benchOnOrAfter[0]?.close ?? null;
            const benchAfter = benchOnOrAfter.filter(c => c.date > benchOnOrAfter[0]?.date);
            if (benchEntry != null && benchAfter.length >= horizonDays) {
              const benchExit = benchAfter[horizonDays - 1].close;
              benchmarkReturn = (benchExit - benchEntry) / benchEntry;
            }
          } catch { /* benchmark optional — label still inserted */ }

          const entryAtr = readEntryAtr(obs.features);
          const label = computeLabel(entryPrice, afterEntry, horizonDays, benchmarkReturn, entryAtr);
          if (!label) { skipped++; return; }
          const atrExitOutcomes = computeAtrExitOutcomes(entryPrice, entryAtr, afterEntry, horizonDays);

          const { error: insErr } = await svc.from("observation_labels").upsert({
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
          if (insErr) { skipped++; return; }
          if (atrExitOutcomes) atrLabeled++;
          else atrUnavailable++;
          matured++;
        } catch {
          skipped++;
        }
      }));
      if (i + BATCH < pending.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  return { matured, skipped, atrLabeled, atrUnavailable, market: marketScope ?? "all" };
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
      await svc.from("agent_runs").insert({
        agent_type: "label_maturation",
        status: "done",
        trigger_source: isCron ? "scheduled" : "manual",
        result_summary: `Matured ${result.matured}, skipped ${result.skipped}, ATR ${result.atrLabeled}/${result.matured} (${result.market}).`,
        completed_at: new Date().toISOString(),
      } as any);
    } catch { /* best-effort */ }
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
