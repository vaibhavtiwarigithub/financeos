import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAutonomousExecution,
  type LiveAutoPolicy,
  type KernelResult,
} from "@/lib/trading/execution-kernel";

const SIGNAL_LOOKBACK_HOURS = 24;

export interface ShadowRunResult {
  run_id: string;
  evaluated: number;
  would_go: number;
  rejected: number;
  results: Array<{
    symbol: string;
    market: string;
    signal_id: number;
    proposal_id: number | null;
    kernel: KernelResult;
  }>;
}

export async function runAutonomousShadow(
  svc: SupabaseClient,
  runId: string,
): Promise<ShadowRunResult> {
  const runStart = new Date().toISOString();

  // 1. Snapshot policy.
  const { data: config, error: cfgErr } = await svc
    .from("strategy_config")
    .select(
      "live_auto_enabled,live_auto_enabled_until,live_auto_policy_version," +
      "live_auto_daily_cap_usd,live_auto_max_per_order_usd,live_auto_min_evidence_confidence," +
      "live_auto_max_open_positions,live_auto_max_orders_per_day,score_threshold"
    )
    .limit(1)
    .single();

  if (cfgErr || !config) throw new Error("Could not read strategy_config");

  const cfg = config as any;
  const policy: LiveAutoPolicy = {
    live_auto_enabled:                 cfg.live_auto_enabled ?? false,
    live_auto_enabled_until:           cfg.live_auto_enabled_until ?? null,
    live_auto_policy_version:          cfg.live_auto_policy_version ?? 1,
    live_auto_daily_cap_usd:           cfg.live_auto_daily_cap_usd ?? null,
    live_auto_max_per_order_usd:       cfg.live_auto_max_per_order_usd ?? null,
    live_auto_min_evidence_confidence: cfg.live_auto_min_evidence_confidence ?? null,
    live_auto_max_open_positions:      cfg.live_auto_max_open_positions ?? null,
    live_auto_max_orders_per_day:      cfg.live_auto_max_orders_per_day ?? null,
  };
  const scoreThreshold: number = cfg.score_threshold ?? 60;

  // 2. Count today's shadow proposals (UTC calendar day).
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count: ordersToday } = await svc
    .from("trade_proposals")
    .select("id", { count: "exact", head: true })
    .eq("execution_mode", "autonomous_shadow")
    .gte("created_at", todayStart.toISOString());

  // 3. Count active live positions (filled broker_orders not yet closed).
  const { count: openPositions } = await svc
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .eq("status", "filled");

  // 4. Query qualifying signals.
  const lookbackCutoff = new Date(
    Date.now() - SIGNAL_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();

  const { data: signals } = await svc
    .from("agent_signals")
    .select("id, symbol, market, direction, analyst_score, evidence_confidence, score_source, rationale")
    .eq("score_source", "deterministic_v1")
    .eq("direction", "long")
    .gte("analyst_score", scoreThreshold)
    .gte("created_at", lookbackCutoff)
    .order("analyst_score", { ascending: false })
    .limit(policy.live_auto_max_orders_per_day ?? 10);

  const results: ShadowRunResult["results"] = [];
  let shadowOrdersThisRun = 0;

  for (const signal of signals ?? []) {
    const { data: proposal, error: propErr } = await svc
      .from("trade_proposals")
      .insert({
        symbol:          signal.symbol,
        market:          signal.market ?? "us",
        side:            "buy",
        order_type:      "market",
        signal_id:       signal.id,
        analyst_score:   signal.analyst_score,
        thesis:          signal.rationale ?? null,
        status:          "pending_review",
        execution_mode:  "autonomous_shadow",
        auto_run_id:     runId,
        auto_decided_at: new Date().toISOString(),
        policy_snapshot: { policy, score_threshold: scoreThreshold, run_id: runId, run_start: runStart },
      })
      .select("id")
      .single();

    if (propErr || !proposal) {
      results.push({
        symbol:      signal.symbol,
        market:      signal.market ?? "us",
        signal_id:   signal.id,
        proposal_id: null,
        kernel: {
          go: false,
          shadow_status: "manual_review_required",
          gate_failed: "proposal_insert_failed",
          reason: propErr?.message ?? "insert returned no row",
          policy_version: policy.live_auto_policy_version,
          evaluated_at: new Date().toISOString(),
        },
      });
      continue;
    }

    const kernel = evaluateAutonomousExecution({
      symbol:               signal.symbol,
      market:               signal.market ?? "us",
      direction:            signal.direction ?? "long",
      score:                signal.analyst_score ?? 0,
      evidence_confidence:  signal.evidence_confidence ?? 0,
      score_threshold:      scoreThreshold,
      proposed_notional_usd: 0, // PA1: sizing not yet implemented; notional gate skipped
      policy,
      current_open_positions: openPositions ?? 0,
      orders_placed_today:    (ordersToday ?? 0) + shadowOrdersThisRun,
    });

    await svc
      .from("trade_proposals")
      .update({
        status: kernel.shadow_status,
        policy_snapshot: {
          policy,
          score_threshold: scoreThreshold,
          run_id: runId,
          run_start: runStart,
          kernel,
        },
      })
      .eq("id", proposal.id);

    if (kernel.go) shadowOrdersThisRun++;

    results.push({
      symbol:      signal.symbol,
      market:      signal.market ?? "us",
      signal_id:   signal.id,
      proposal_id: proposal.id,
      kernel,
    });
  }

  const went = results.filter((r) => r.kernel.go).length;
  const blocked = results.filter((r) => !r.kernel.go).length;

  await svc.from("decision_journal").insert({
    entry_type: "autonomous_shadow_run",
    summary:
      `Shadow run ${runId}: ${results.length} signal(s) evaluated — ` +
      `${went} would-go (queued_auto), ${blocked} rejected (manual_review_required)`,
  } as any);

  return { run_id: runId, evaluated: results.length, would_go: went, rejected: blocked, results };
}
