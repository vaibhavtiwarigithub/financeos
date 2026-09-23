/** L4 live-trading gate for the leveraged sleeve (SOXL/TQQQ/SQQQ/SOXS).
 * Pure, deterministic, no I/O. Does NOT reuse execution-kernel.ts's
 * score/evidence-confidence gates -- the leveraged sleeve has no
 * analyst_score; its own deterministic trend/quote/geometry checks
 * (leveraged-live-entry.ts) already gate the setup itself. This kernel
 * gates whether a live order may be attempted AT ALL.
 *
 * DELIBERATELY DECOUPLED (2026-09-23) from core-equity AutonomousLive's own
 * gates: LEVERAGED_LIVE_ENABLED/leveraged_live_auto_enabled are separate
 * flags from AUTONOMOUS_LIVE_ENABLED/live_auto_enabled. Owner flagged, at
 * the moment of actually enabling this, that reusing the shared flags would
 * silently also enable core-equity's own live trading (a completely
 * separate, much larger, never-fired system) as a side effect. See
 * lib/autonomy.ts's LEVERAGED_LIVE_ENABLED comment. Unlike core equity's
 * live_auto_enabled_until, there is no auto-expiring lease window here --
 * the DB toggle plus the explicit Disable button in Settings is the control.
 *
 * See features/leveraged-etf-and-intraday-execution/FEATURE_ARCHITECTURE.md
 * part 6.
 */

export const LEVERAGED_LIVE_MIN_PAPER_TRADES = 10;

export interface LeveragedLiveGateInput {
  deploymentFlagEnabled: boolean; // LEVERAGED_LIVE_ENABLED (env)
  liveAutoEnabled: boolean; // strategy_config.leveraged_live_auto_enabled
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
  if (!input.deploymentFlagEnabled) return fail("deployment_flag_inactive", "LEVERAGED_LIVE_ENABLED=false");
  if (!input.liveAutoEnabled) return fail("db_toggle_off", "leveraged_live_auto_enabled=false in strategy_config");
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
