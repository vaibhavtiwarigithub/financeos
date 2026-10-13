import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  EXPOSURE_FACTORS, FACTOR_SERIES, computeExposure,
  type FactorLevels, type SessionReturn,
} from "@/lib/india-macro-exposure";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Measure-only: per-symbol macro exposure (OLS betas to market, USD/INR, Brent, India VIX) for India symbols the research
// pipeline scored in the last 30 days. Writes india_macro_exposures (append-only). No scorer, gate or trade reads it.

const LOOKBACK_DAYS = 400;
const CHUNK = 8;
// Estimation method stamped on every row. v1 joined factor levels on the exact date and dropped ~30% of sessions;
// v2 uses the last level within 4 days. Rows are append-only, so a method change needs a new key, not an overwrite.
const METHOD = "asof4d_v2";

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const runId = `india-macro-exposure:${new Date().toISOString()}`;
  const startedAt = Date.now();

  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const obs = await fetchAllRows((from, to) => svc.from("decision_observations").select("id,symbol")
    .eq("market", "india").gte("ts", since30).order("id", { ascending: true }).range(from, to), "india exposure universe") as any[];
  const symbols = [...new Set(obs.map((r) => String(r.symbol).toUpperCase()))].sort();

  const factorRows = await fetchAllRows((from, to) => svc.from("india_macro_observations").select("id,series_id,obs_date,value")
    .in("series_id", Object.values(FACTOR_SERIES)).order("id", { ascending: true }).range(from, to), "india exposure factors") as any[];
  const levels = Object.fromEntries(EXPOSURE_FACTORS.map((f) => [f, new Map<string, number>()])) as FactorLevels;
  for (const f of EXPOSURE_FACTORS) {
    for (const row of factorRows) if (row.series_id === FACTOR_SERIES[f]) levels[f].set(String(row.obs_date), Number(row.value));
  }

  const sinceReturns = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  const outRows: Record<string, unknown>[] = [];
  const statusCounts: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i += CHUNK) {
    if (Date.now() - startedAt > 45_000) break; // time budget; the weekly run resumes next week, rows are idempotent per window_end
    const batch = symbols.slice(i, i + CHUNK);
    const rows = await fetchAllRows((from, to) => svc.from("symbol_daily_returns")
      .select("id,symbol,session_date,previous_session_date,simple_return")
      .eq("market", "india").in("symbol", batch).gte("session_date", sinceReturns)
      .order("id", { ascending: true }).range(from, to), "india exposure returns") as any[];
    const bySymbol = new Map<string, SessionReturn[]>();
    for (const r of rows) {
      const list = bySymbol.get(r.symbol) ?? [];
      list.push({ session_date: String(r.session_date), previous_session_date: String(r.previous_session_date), simple_return: Number(r.simple_return) });
      bySymbol.set(r.symbol, list);
    }
    for (const symbol of batch) {
      const returns = bySymbol.get(symbol) ?? [];
      const res = computeExposure(returns, levels);
      const windowEnd = res.window_end ?? returns.map((r) => r.session_date).sort().pop() ?? null;
      const status = res.ok ? "ok" : res.reason!;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (!windowEnd) continue;
      outRows.push({
        symbol, window_start: res.window_start, window_end: windowEnd, n_obs: res.n_obs, factor_coverage: res.factor_coverage,
        status, r2: res.r2 ?? null, betas: res.betas ?? null, tstats: res.tstats ?? null, significant: res.significant ?? null, method: METHOD, run_id: runId,
      });
    }
  }

  let written = 0;
  for (let i = 0; i < outRows.length; i += 200) {
    const { data, error } = await svc.from("india_macro_exposures")
      .upsert(outRows.slice(i, i + 200), { onConflict: "symbol,window_end,method", ignoreDuplicates: true }).select("id");
    if (error) return NextResponse.json({ ok: false, error: `write failed: ${error.message}` }, { status: 500 });
    written += data?.length ?? 0;
  }

  await svc.from("agent_runs").insert({
    agent_type: "india_macro_exposure", status: "done", market: "india", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${symbols.length} symbols, ${written} new exposure rows (${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}); behavior changed=false`,
  });

  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, symbols: symbols.length, written, statusCounts });
}

export const POST = GET;
