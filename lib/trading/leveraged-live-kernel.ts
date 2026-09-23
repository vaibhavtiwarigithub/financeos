/** L4 live-trading gate for the leveraged sleeve (SOXL/TQQQ/SQQQ/SOXS).
 * Pure, deterministic, no I/O. Reuses the SAME dual-gate philosophy as
 * lib/trading/execution-kernel.ts (AUTONOMOUS_LIVE_ENABLED + live_auto_enabled)
 * but does NOT reuse that kernel's score/evidence-confidence gates -- the
 * leveraged sleeve has no analyst_score; its own deterministic trend/quote/
 * geometry checks (planTqqqEntry etc.) already gate the setup itself. This
 * kernel gates whether a live order may be attempted AT ALL.
 *
 * See features/leveraged-etf-and-intraday-execution/FEATURE_ARCHITECTURE.md
 * part 6.
 */

export const LEVERAGED_LIVE_MIN_PAPER_TRADES = 10;

export interface LeveragedLiveGateInput {
  deploymentFlagEnabled: boolean; // AUTONOMOUS_LIVE_ENABLED
  liveAutoEnabled: boolean; // strategy_config.live_auto_enabled
  liveAutoEnabledUntil: string | null;
  appPaused: boolean;
  securityLocked: boolean;
  tradingEnabledUs: boolean;
  protectiveOrdersEnabled: boolean; // strategy_config.protective_orders_enabled -- non-negotiable
  protectivePlacementWorkerAvailable: boolean; // PROTECTIVE_PLACEMENT_WORKER_AVAILABLE code constant
  leaseUsd: number; // strategy_config.leveraged_sleeve_live_lease_usd
  closedPaperTradeCount: number;
  minPaperTradesOverride: boolean; // leveraged_live_overrides row for this symbol
  openUnresolvedCriticalAlertCount: number;
  now: number;
}

export type LeveragedLiveGateResult = { go: true } | { go: false; gate: string; reason: string };

export function evaluateLeveragedLiveEntry(input: LeveragedLiveGateInput): LeveragedLiveGateResult {
  if (!input.deploymentFlagEnabled) return fail("deployment_flag_inactive", "AUTONOMOUS_LIVE_ENABLED=false");
  if (!input.liveAutoEnabled) return fail("db_toggle_off", "live_auto_enabled=false in strategy_config");
  if (input.liveAutoEnabledUntil && Date.parse(input.liveAutoEnabledUntil) < input.now) {
    return fail("lease_expired", `owner lease expired at ${input.liveAutoEnabledUntil}`);
  }
  if (input.appPaused) return fail("app_paused", "strategy_config.app_paused=true");
  if (input.securityLocked) return fail("security_locked", "strategy_config.security_locked=true");
  if (!input.tradingEnabledUs) return fail("trading_disabled_us", "strategy_config.trading_enabled_us=false");
  if (!input.protectivePlacementWorkerAvailable) {
    return fail("protective_worker_unavailable", "PROTECTIVE_PLACEMENT_WORKER_AVAILABLE=false (code constant)");
  }
  if (!input.protectiveOrdersEnabled) {
    return fail("protective_orders_disabled", "strategy_config.protective_orders_enabled=false — no live order without a confirmed broker-native stop");
  }
  if (!Number.isFinite(input.leaseUsd) || input.leaseUsd <= 0) {
    return fail("no_lease_capacity", `leveraged_sleeve_live_lease_usd=${input.leaseUsd} — owner has not set a live lease`);
  }
  if (!Number.isFinite(input.openUnresolvedCriticalAlertCount) || input.openUnresolvedCriticalAlertCount > 0) {
    return fail("open_critical_alerts", `${input.openUnresolvedCriticalAlertCount} unresolved critical alert(s) — kill-switch`);
  }
  if (!input.minPaperTradesOverride && input.closedPaperTradeCount < LEVERAGED_LIVE_MIN_PAPER_TRADES) {
    return fail(
      "insufficient_paper_evidence",
      `${input.closedPaperTradeCount}/${LEVERAGED_LIVE_MIN_PAPER_TRADES} closed paper trades for this symbol (no override set)`,
    );
  }
  return { go: true };
}

function fail(gate: string, reason: string): LeveragedLiveGateResult {
  return { go: false, gate, reason };
}
