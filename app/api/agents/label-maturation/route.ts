import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaCandles } from "@/lib/india-data";
import { computeLabel } from "@/lib/learning/label-math";

export const dynamic = "force-dynamic";

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
  return (data ?? []).map((c: any) => ({
    date: c.date, close: parseFloat(c.close), high: parseFloat(c.high ?? c.close), low: parseFloat(c.low ?? c.close),
  }));
}

async function indiaCandles(symbol: string): Promise<Candle[]> {
  const raw = await fetchIndiaCandles(symbol, "3mo");
  return raw.map(c => ({ date: c.date, close: c.close, high: c.high, low: c.low }));
}

async function candlesFor(supabase: any, market: string, symbol: string, sinceDate: string): Promise<Candle[]> {
  if (market === "india") return indiaCandles(symbol);
  return usCandles(supabase, symbol, sinceDate);
}

async function runMaturation(marketScope: "us" | "india" | null) {
  const svc = createServiceClient();
  let matured = 0, skipped = 0;

  for (const horizonDays of HORIZONS) {
    const cutoff = maturityCutoff(horizonDays);

    // Candidate observations old enough for this horizon to be maturable,
    // scoped to market if requested, oldest first, capped per run.
    let obsQuery = svc.from("decision_observations")
      .select("id, ts, market, symbol, price_at_decision, currency")
      .lte("ts", cutoff)
      .order("ts", { ascending: true })
      .limit(200);
    if (marketScope) obsQuery = obsQuery.eq("market", marketScope);
    const { data: obsRows, error: obsErr } = await obsQuery;
    if (obsErr || !obsRows?.length) continue;

    // Which of these already have this horizon labeled? Anti-join in JS.
    const obsIds = obsRows.map((r: any) => r.id);
    const { data: existingLabels } = await svc
      .from("observation_labels")
      .select("observation_id")
      .eq("horizon_days", horizonDays)
      .in("observation_id", obsIds);
    const already = new Set((existingLabels ?? []).map((l: any) => l.observation_id));
    const pending = obsRows.filter((r: any) => !already.has(r.id));

    // Batch candle fetches, ~8 parallel with a pause, matching scan/india/refresh style.
    const BATCH = 8;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (obs: any) => {
        try {
          const sinceDate = new Date(new Date(obs.ts).getTime() - 5 * 86400_000).toISOString().slice(0, 10);
          const candles = await candlesFor(svc, obs.market, obs.symbol, sinceDate);
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
            const benchCandles = await candlesFor(svc, obs.market, benchSymbol, sinceDate);
            const benchOnOrAfter = benchCandles.filter(c => c.date >= decisionDate);
            const benchEntry = benchOnOrAfter[0]?.close ?? null;
            const benchAfter = benchOnOrAfter.filter(c => c.date > benchOnOrAfter[0]?.date);
            if (benchEntry != null && benchAfter.length >= horizonDays) {
              const benchExit = benchAfter[horizonDays - 1].close;
              benchmarkReturn = (benchExit - benchEntry) / benchEntry;
            }
          } catch { /* benchmark optional — label still inserted */ }

          const label = computeLabel(entryPrice, afterEntry, horizonDays, benchmarkReturn);
          if (!label) { skipped++; return; }

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
          }, { onConflict: "observation_id,horizon_days" });
          if (insErr) { skipped++; return; }
          matured++;
        } catch {
          skipped++;
        }
      }));
      if (i + BATCH < pending.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  return { matured, skipped, market: marketScope ?? "all" };
}

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
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
        result_summary: `Matured ${result.matured}, skipped ${result.skipped} (${result.market}).`,
        completed_at: new Date().toISOString(),
      } as any);
    } catch { /* best-effort */ }
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
