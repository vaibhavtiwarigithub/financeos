import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";
import { positionSizePct } from "@/lib/risk/sizing";

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

// ─── PA2 Sizing ─────────────────────────────────────────────────────────────

export interface SizingInput {
  nav: number;
  nav_captured_at: string;
  /** Autonomous NAV max age is strict (4h default). No fallback NAV. */
  nav_max_age_ms?: number;
  current_price: number;
  price_stale: boolean;
  /** Null when < 10 closed paper_trades available — falls back to flat. */
  win_rate: number | null;
  payoff_ratio: number | null;
  /** From strategy_config.position_size_pct — used as flat fallback. */
  flat_size_pct: number;
  policy: LiveAutoPolicy;
  /**
   * Market for this order ("us" | "india"). Required to prevent applying a
   * USD-denominated per-order cap to an INR-denominated India position.
   * live_auto_max_per_order_usd is skipped for India until a native INR cap
   * field is added (live_auto_max_per_order_inr).
   */
  market?: string;
}

export interface SizingResult {
  ok: boolean;
  reject_reason?: string;
  size_method: "kelly" | "flat";
  size_pct: number;
  proposed_qty: number;
  estimated_notional: number;
  pct_of_nav: number;
}

const NAV_MAX_AGE_MS_DEFAULT = 4 * 3_600_000; // 4 hours — strict for autonomous path

export function computeAutonomousSizing(input: SizingInput): SizingResult {
  const age = Date.now() - new Date(input.nav_captured_at).getTime();
  const maxAge = input.nav_max_age_ms ?? NAV_MAX_AGE_MS_DEFAULT;

  if (!input.nav || !Number.isFinite(input.nav) || input.nav <= 0) {
    return noSize("no_live_nav");
  }
  if (age > maxAge) {
    return noSize(`stale_nav_${Math.round(age / 60_000)}min`);
  }
  if (input.price_stale || !Number.isFinite(input.current_price) || input.current_price <= 0) {
    return noSize("no_current_price");
  }

  let size_pct = (input.flat_size_pct / 100) || 0.10;
  let size_method: "kelly" | "flat" = "flat";

  // live_auto_max_per_order_usd is USD-denominated. Applying it to an India order
  // would divide USD-cap / INR-nav → wrong dimensionless ratio. Skip for India
  // until a native live_auto_max_per_order_inr field is added.
  const isUsdMarket = !input.market || input.market !== "india";

  if (
    input.win_rate != null &&
    input.payoff_ratio != null &&
    input.win_rate > 0 &&
    input.payoff_ratio > 0
  ) {
    // Kelly cap = min(10%, per-order cap / nav) — USD markets only
    const perOrderCap = isUsdMarket ? input.policy.live_auto_max_per_order_usd : null;
    const cap = perOrderCap != null
      ? Math.min(0.10, perOrderCap / input.nav)
      : 0.10;
    const kelly = positionSizePct(input.win_rate, input.payoff_ratio, {
      halfKellyCap: cap,
      floorPct: 0.02,
    });
    if (kelly > 0) {
      size_pct = kelly;
      size_method = "kelly";
    }
  }

  // Clamp to per-order notional cap (USD markets only — see isUsdMarket above)
  if (isUsdMarket && input.policy.live_auto_max_per_order_usd != null) {
    size_pct = Math.min(size_pct, input.policy.live_auto_max_per_order_usd / input.nav);
  }

  const notional = input.nav * size_pct;
  const qty = Math.floor(notional / input.current_price);

  if (qty < 1) {
    return noSize("qty_rounds_to_zero");
  }

  const estimated_notional = parseFloat((qty * input.current_price).toFixed(2));
  return {
    ok: true,
    size_method,
    size_pct: parseFloat(size_pct.toFixed(6)),
    proposed_qty: qty,
    estimated_notional,
    pct_of_nav: parseFloat((estimated_notional / input.nav).toFixed(4)),
  };
}

function noSize(reason: string): SizingResult {
  return { ok: false, reject_reason: reason, size_method: "flat", size_pct: 0, proposed_qty: 0, estimated_notional: 0, pct_of_nav: 0 };
}
