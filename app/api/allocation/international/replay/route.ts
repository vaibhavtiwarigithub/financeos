import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { runInternationalAllocationReplay } from "@/lib/allocation/international-replay";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const POLICY_KEY = "us_non_us_broad_core_v1";
const TEST_WEIGHT_PCT = 20;
const ONE_WAY_COST_BPS = 5;

// This endpoint is intentionally owner-only and cache-only. It has no provider
// access, no policy mutation, no candidate construction, and no order authority.
export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  const supabase = createServiceClient();
  const { data: policy, error: policyError } = await supabase
    .from("international_allocation_policies")
    .select("id, market, status, target_pct, deadband_pct")
    .eq("policy_key", POLICY_KEY)
    .maybeSingle();
  if (policyError) return NextResponse.json({ error: policyError.message }, { status: 503 });
  if (!policy || policy.market !== "us") return NextResponse.json({ error: "International allocation policy unavailable" }, { status: 409 });

  const [vooResponse, vxusResponse] = await Promise.all([
    supabase.from("price_cache").select("date, close").eq("symbol", "VOO").order("date", { ascending: true }).range(0, 3_000),
    supabase.from("price_cache").select("date, close").eq("symbol", "VXUS").order("date", { ascending: true }).range(0, 3_000),
  ]);
  if (vooResponse.error || vxusResponse.error) {
    return NextResponse.json({ error: vooResponse.error?.message ?? vxusResponse.error?.message ?? "Historical cache query failed" }, { status: 503 });
  }

  const voo = (vooResponse.data ?? []).map((row: { date: string; close: number | string }) => ({ date: row.date, close: Number(row.close) }));
  const vxus = (vxusResponse.data ?? []).map((row: { date: string; close: number | string }) => ({ date: row.date, close: Number(row.close) }));
  const result = runInternationalAllocationReplay(voo, vxus, { testWeightPct: TEST_WEIGHT_PCT, oneWayCostBps: ONE_WAY_COST_BPS });
  const configuration = {
    market: "us",
    currency: "USD",
    baseline: "VOO",
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
    })
    .select("id, created_at")
    .single();
  if (persistError) return NextResponse.json({ error: persistError.message }, { status: 503 });

  return NextResponse.json({
    ok: true,
    run: persisted,
    result,
    safeguards: {
      policyStatus: policy.status,
      targetConfigured: policy.target_pct != null,
      alteredPolicy: false,
      executionEnabled: false,
      providerCalls: 0,
    },
  });
}
