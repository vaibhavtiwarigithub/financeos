import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { runInternationalAllocationReplay } from "@/lib/allocation/international-replay";
import { buildInternationalAllocationAttribution } from "@/lib/allocation/international-attribution";
import { writeAttributionRow } from "@/lib/shadows/attribution-writer";
import { createServiceClient } from "@/lib/supabase/service";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const POLICY_KEY = "us_non_us_broad_core_v1";
const TEST_WEIGHT_PCT = 20;
const ONE_WAY_COST_BPS = 5;

// This endpoint is intentionally owner-only and cache-only. It has no provider
// access, no policy mutation, no candidate construction, and no order authority.
export async function POST(req: NextRequest) {
  const scheduled = verifyCronSecret(req);
  if (!scheduled) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const supabase = createServiceClient();
  const { data: policy, error: policyError } = await supabase
    .from("international_allocation_policies")
    .select("id, market, status, target_pct, deadband_pct")
    .eq("policy_key", POLICY_KEY)
    .maybeSingle();
  if (policyError) return NextResponse.json({ error: policyError.message }, { status: 503 });
  if (!policy || policy.market !== "us") return NextResponse.json({ error: "International allocation policy unavailable" }, { status: 409 });

  const [vooResponse, vxusResponse] = await Promise.all([
    supabase.from("price_cache").select("date, close").eq("symbol", benchmarkSymbolFor("us", "allocation")).order("date", { ascending: true }).range(0, 3_000),
    supabase.from("price_cache").select("date, close").eq("symbol", "VXUS").order("date", { ascending: true }).range(0, 3_000),
  ]);
  if (vooResponse.error || vxusResponse.error) {
    return NextResponse.json({ error: vooResponse.error?.message ?? vxusResponse.error?.message ?? "Historical cache query failed" }, { status: 503 });
  }

  const voo = (vooResponse.data ?? []).map((row: { date: string; close: number | string }) => ({ date: row.date, close: Number(row.close) }));
  const vxus = (vxusResponse.data ?? []).map((row: { date: string; close: number | string }) => ({ date: row.date, close: Number(row.close) }));
  const result = runInternationalAllocationReplay(voo, vxus, { testWeightPct: TEST_WEIGHT_PCT, oneWayCostBps: ONE_WAY_COST_BPS });
  const attribution = buildInternationalAllocationAttribution(voo, vxus);
  const configuration = {
    market: "us",
    currency: "USD",
    baseline: benchmarkSymbolFor("us", "allocation"),
    test_sleeve: { voo_pct: 100 - TEST_WEIGHT_PCT, vxus_pct: TEST_WEIGHT_PCT },
    rebalance: "monthly_first_matched_session_close",
    one_way_cost_bps: ONE_WAY_COST_BPS,
    analytical_only: true,
  };
  const sourceDataFingerprint = createHash("sha256")
    .update(JSON.stringify({ voo, vxus, configuration }))
    .digest("hex");

  const { data: persisted, error: persistError } = await supabase
    .from("international_allocation_replay_runs")
    .insert({
      policy_id: policy.id,
      status: result.status,
      source_start_date: result.startDate,
      source_end_date: result.endDate,
      matched_sessions: result.sessions,
      configuration,
      source_data_fingerprint: sourceDataFingerprint,
      result,
      trigger_source: scheduled ? "scheduled" : "owner_manual",
    })
    .select("id, created_at")
    .single();
  if (persistError) return NextResponse.json({ error: persistError.message }, { status: 503 });

  let attributionWrite: "inserted" | "already_present" | "collecting" = "collecting";
  if (attribution.row) {
    try {
      attributionWrite = await writeAttributionRow(supabase, attribution.row);
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Attribution write failed",
        replayRun: persisted,
        attributionState: "invalid",
      }, { status: 503 });
    }
  }

  return NextResponse.json({
    ok: true,
    run: persisted,
    result,
    attribution: {
      state: attribution.row ? "measured" : "collecting",
      write: attributionWrite,
      reason: attribution.reason,
      asOfSession: attribution.row?.as_of_session ?? result.endDate,
      portfolioScope: "synthetic fixed allocation; not Kairos paper/live holdings",
      metrics: attribution.row ? {
        baselineGrossPct: attribution.row.baseline_portfolio_return_pct,
        variantGrossPct: attribution.row.variant_portfolio_return_pct,
        baselineNetPct: attribution.row.baseline_net_portfolio_return_pct,
        variantNetPct: attribution.row.variant_net_portfolio_return_pct,
        netDeltaPct: attribution.row.net_incremental_return_pct,
        intervalPct: [attribution.row.ci_lower_pct, attribution.row.ci_upper_pct],
        independent63SessionBlocks: attribution.row.independent_sessions,
        tStatistic: attribution.row.t_statistic,
        turnoverPct: attribution.row.turnover_pct,
        drawdownDeltaPct: attribution.row.drawdown_delta_pct,
      } : null,
    },
    trigger: scheduled ? "scheduled" : "owner_manual",
    safeguards: {
      policyStatus: policy.status,
      targetConfigured: policy.target_pct != null,
      alteredPolicy: false,
      executionEnabled: false,
      providerCalls: 0,
    },
  });
}
