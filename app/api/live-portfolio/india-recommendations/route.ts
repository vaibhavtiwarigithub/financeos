import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadGuardianOutcomeScorecard } from "@/lib/live-recommendations/guardian-store";

export const dynamic = "force-dynamic";
const HORIZONS = [2, 5, 10, 20] as const;
const LOOKBACK_DAYS = 180;

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  try {
    const observations = await fetchAllRows((from, to) => svc.from("decision_observations")
      .select("id,ts,symbol,direction,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,price_at_decision,entry_eligible,action,score_source,scoring_version")
      .eq("market", "india").eq("entry_eligible", true).gte("ts", since)
      .order("ts", { ascending: false }).order("id", { ascending: false }).range(from, to), "India live recommendation observations") as any[];
    const eligible = observations.slice(0, 2000);
    const ids = eligible.map((row) => Number(row.id)).filter(Number.isSafeInteger);
    const labels: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await svc.from("observation_labels")
        .select("observation_id,horizon_days,fwd_return,benchmark_return,benchmark_neutral_return,matured_at")
        .in("observation_id", ids.slice(i, i + 200)).in("horizon_days", [...HORIZONS]);
      if (error) throw new Error(`India recommendation labels unavailable: ${error.message}`);
      labels.push(...(data ?? []));
    }
    const byObservation = new Map<number, any[]>();
    for (const label of labels) (byObservation.get(Number(label.observation_id)) ?? byObservation.set(Number(label.observation_id), []).get(Number(label.observation_id))!).push(label);
    const summary = HORIZONS.map((horizon) => {
      const matured = labels.filter((label) => Number(label.horizon_days) === horizon && label.benchmark_neutral_return != null);
      const returns = matured.map((label) => Number(label.benchmark_neutral_return)).filter(Number.isFinite);
      return {
        horizon,
        n: returns.length,
        meanExcessPct: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length * 100 : null,
        hitRatePct: returns.length ? returns.filter((value) => value > 0).length / returns.length * 100 : null,
      };
    });
    const rows = eligible.slice(0, 60).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      researchedAt: row.ts,
      score: row.analyst_score,
      direction: row.direction,
      entryEligible: row.entry_eligible,
      referencePrice: row.price_at_decision,
      dimensions: {
        fundamental: row.fundamental_score, technical: row.technical_score,
        sentiment: row.sentiment_score, macro: row.macro_score, insider: row.insider_score,
      },
      action: row.action,
      scoreSource: row.score_source,
      scoringVersion: row.scoring_version,
      labels: (byObservation.get(Number(row.id)) ?? []).map((label) => ({
        horizon: Number(label.horizon_days),
        symbolReturnPct: label.fwd_return == null ? null : Number(label.fwd_return) * 100,
        niftyReturnPct: label.benchmark_return == null ? null : Number(label.benchmark_return) * 100,
        excessPct: label.benchmark_neutral_return == null ? null : Number(label.benchmark_neutral_return) * 100,
        maturedAt: label.matured_at,
      })),
    }));
    const guardianOutcomes = await loadGuardianOutcomeScorecard(svc, "india");
    return NextResponse.json({
      market: "india", benchmark: "NIFTY 50", asOf: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS,
      observationCount: eligible.length, truncated: observations.length > eligible.length,
      summary, rows, guardianOutcomes,
      semantics: "These are deterministic, entry-eligible ResearchAgent observations, not broker orders. Outcome summaries use only matured labels. Daily observations overlap, so summaries are descriptive and are not inferential IC/t-stat estimates. Current holdings do not prove whether a recommendation was bought and later sold.",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "India recommendations unavailable" }, { status: 500 });
  }
}
