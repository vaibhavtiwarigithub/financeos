import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fredSeriesDated } from "@/lib/data/fred-macro";
import { fetchFiiDiiFlows } from "@/lib/india-macro";
import { YAHOO_ALLOWED_HOSTS } from "@/lib/india-markets/adapter";
import {
  INDIA_MACRO_SERIES, fiiDiiToObservations, fredToObservations, lastIntradayCloses, nullCloseDates, parseYahooChart,
  type MacroObservation, type MacroSeriesSpec,
} from "@/lib/india-macro-series";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Measure-only India macro series collector. Writes india_macro_observations (append-only, first-seen wins);
// no score, signal, trade or learner path reads it. ?backfill=1 pulls ~2y of history once (insert-ignore makes it idempotent).

async function fetchYahoo(spec: MacroSeriesSpec, range: string, todayUtc: string, backfill = false): Promise<MacroObservation[]> {
  const host = YAHOO_ALLOWED_HOSTS[0];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(spec.provider)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; KairosMacro/1.0)" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!res.ok) throw new Error(`yahoo_http_${res.status}`);
  const json = await res.json();
  const obs = parseYahooChart(spec, json, todayUtc);
  if (!spec.intradayFallback) return obs;
  // Yahoo can leave a completed session's daily close null for an ETF. Use that session's last hourly close, never a bridge from the
  // previous day, so an append-only consumer never records a zero return for a real trading day.
  const gaps = nullCloseDates(json).filter((d) => d < todayUtc);
  if (!gaps.length) return obs;
  const hourly = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(spec.provider)}?range=${backfill ? "2y" : "1mo"}&interval=1h`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; KairosMacro/1.0)" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!hourly.ok) return obs;
  return [...obs, ...lastIntradayCloses(spec, await hourly.json(), gaps)];
}

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const backfill = req.nextUrl.searchParams.get("backfill") === "1";
  const svc = createServiceClient();
  const runId = `india-macro-series:${new Date().toISOString()}`;
  const todayUtc = new Date().toISOString().slice(0, 10);

  const rows: MacroObservation[] = [];
  const perSeries: Record<string, { fetched: number; error?: string }> = {};

  await Promise.all(INDIA_MACRO_SERIES.filter((s) => s.source !== "nse").map(async (spec) => {
    try {
      const obs = spec.source === "fred"
        ? fredToObservations(spec, await fredSeriesDated(spec.provider, backfill ? 800 : 15))
        : await fetchYahoo(spec, backfill ? "2y" : "10d", todayUtc, backfill);
      rows.push(...obs);
      perSeries[spec.id] = { fetched: obs.length, ...(obs.length ? {} : { error: "empty" }) };
    } catch (e: any) {
      perSeries[spec.id] = { fetched: 0, error: String(e?.message ?? e).slice(0, 80) };
    }
  }));

  const flows = await fetchFiiDiiFlows().catch(() => null);
  const flowRows = fiiDiiToObservations(flows?.[0] ?? null);
  rows.push(...flowRows);
  for (const id of ["fii_net_cr", "dii_net_cr"]) {
    const n = flowRows.filter((r) => r.series_id === id).length;
    perSeries[id] = { fetched: n, ...(n ? {} : { error: "empty_or_blocked" }) };
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, run_id: runId }));
    const { data, error } = await svc.from("india_macro_observations")
      .upsert(chunk, { onConflict: "series_id,source,obs_date", ignoreDuplicates: true }).select("id");
    if (error) return NextResponse.json({ ok: false, error: `write failed: ${error.message}`, perSeries }, { status: 500 });
    written += data?.length ?? 0;
  }

  const failed = Object.entries(perSeries).filter(([, v]) => v.error).map(([k]) => k);
  await svc.from("agent_runs").insert({
    agent_type: "india_macro_series", status: "done", market: "india", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${written} new observations from ${rows.length} fetched; series without data: ${failed.join(", ") || "none"}; behavior changed=false`,
  });

  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, backfill, fetched: rows.length, written, failed, perSeries });
}

export const POST = GET;
