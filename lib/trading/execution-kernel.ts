import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";

export interface LiveAutoPolicy {
  live_auto_enabled: boolean;
  live_auto_enabled_until: string | null;
  live_auto_policy_version: number;
  live_auto_daily_cap_usd: number | null;
  live_auto_max_per_order_usd: number | null;
  live_auto_min_evidence_confidence: number | null;
  live_auto_max_open_positions: number | null;
  live_auto_max_orders_per_day: number | null;
}

export interface KernelInput {
  symbol: string;
  market: string;
  direction: string;
  score: number;
  evidence_confidence: number;
  score_threshold: number;
  proposed_notional_usd: number;
  policy: LiveAutoPolicy;
  current_open_positions: number;
  orders_placed_today: number;
}

export interface KernelResult {
  go: boolean;
  shadow_status: "queued_auto" | "manual_review_required";
  gate_failed: string | null;
  reason: string;
  policy_version: number;
  evaluated_at: string;
}

export function evaluateAutonomousExecution(input: KernelInput): KernelResult {
  const { policy } = input;
  const now = new Date();

  // Gate 1: deployment flag — hardcoded false in current deploy
  if (!AUTONOMOUS_LIVE_ENABLED) {
    return fail("deployment_flag_inactive", "AUTONOMOUS_LIVE_ENABLED=false in deployment", policy, now);
  }

  // Gate 2: DB toggle
  if (!policy.live_auto_enabled) {
    return fail("db_toggle_off", "live_auto_enabled=false in strategy_config", policy, now);
  }

  // Gate 3: lease expiry
  if (policy.live_auto_enabled_until && new Date(policy.live_auto_enabled_until) < now) {
    return fail(
      "lease_expired",
      `owner lease expired at ${policy.live_auto_enabled_until}`,
      policy,
      now,
    );
  }

  // Gate 4: only long new-position signals (no autonomous shorts, no exits)
  if (input.direction !== "long") {
    return fail(
      "non_long_direction",
      `direction="${input.direction}" — autonomous new entries are long-only`,
      policy,
      now,
    );
  }

  // Gate 5: score must clear threshold
  if (input.score < input.score_threshold) {
    return fail(
      "score_below_threshold",
      `score=${input.score} < threshold=${input.score_threshold}`,
      policy,
      now,
    );
  }

  // Gate 6: evidence confidence floor
  const minConf = policy.live_auto_min_evidence_confidence ?? 0.6;
  if (input.evidence_confidence < minConf) {
    return fail(
      "confidence_below_floor",
      `evidence_confidence=${input.evidence_confidence.toFixed(3)} < floor=${minConf}`,
      policy,
      now,
    );
  }

  // Gate 7: max open positions
  if (
    policy.live_auto_max_open_positions != null &&
    input.current_open_positions >= policy.live_auto_max_open_positions
  ) {
    return fail(
      "max_positions_reached",
      `open_positions=${input.current_open_positions} >= cap=${policy.live_auto_max_open_positions}`,
      policy,
      now,
    );
  }

  // Gate 8: max orders per day
  if (
    policy.live_auto_max_orders_per_day != null &&
    input.orders_placed_today >= policy.live_auto_max_orders_per_day
  ) {
    return fail(
      "max_daily_orders_reached",
      `orders_today=${input.orders_placed_today} >= cap=${policy.live_auto_max_orders_per_day}`,
      policy,
      now,
    );
  }

  // Gate 9: per-order notional cap (only when notional > 0 — PA1 passes 0)
  if (
    policy.live_auto_max_per_order_usd != null &&
    input.proposed_notional_usd > 0 &&
    input.proposed_notional_usd > policy.live_auto_max_per_order_usd
  ) {
    return fail(
      "per_order_cap_exceeded",
      `notional=$${input.proposed_notional_usd} > cap=$${policy.live_auto_max_per_order_usd}`,
      policy,
      now,
    );
  }

  return {
    go: true,
    shadow_status: "queued_auto",
    gate_failed: null,
    reason: "all gates passed",
    policy_version: policy.live_auto_policy_version,
    evaluated_at: now.toISOString(),
  };
}

function fail(
  gate: string,
  detail: string,
  policy: LiveAutoPolicy,
  now: Date,
): KernelResult {
  return {
    go: false,
    shadow_status: "manual_review_required",
    gate_failed: gate,
    reason: detail,
    policy_version: policy.live_auto_policy_version,
    evaluated_at: now.toISOString(),
  };
}
