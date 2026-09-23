/** L4 live-trading gate for crypto (BTC/ETH/SOL). Mirrors
 * leveraged-live-kernel.ts exactly, with crypto's own decoupled flags
 * (CRYPTO_LIVE_ENABLED / strategy_config.crypto_live_auto_enabled) and its
 * own lease (crypto_live_lease_usd). Does not check protective_orders_enabled
 * or PROTECTIVE_PLACEMENT_WORKER_AVAILABLE — those gate the equity-shaped
 * lib/protective/placement-worker.ts, which crypto does not use (crypto's
 * own stop mechanism lives in placeRobinhoodCryptoOrder). Pure, deterministic,
 * no I/O.
 */

export const CRYPTO_LIVE_MIN_PAPER_TRADES = 10;

export interface CryptoLiveGateInput {
  deploymentFlagEnabled: boolean; // CRYPTO_LIVE_ENABLED (env)
  liveAutoEnabled: boolean; // strategy_config.crypto_live_auto_enabled
  appPaused: boolean;
  securityLocked: boolean;
  leaseUsd: number; // strategy_config.crypto_live_lease_usd
  closedPaperTradeCount: number;
  minPaperTradesOverride: boolean; // crypto_live_overrides row for this symbol
  openUnresolvedCriticalAlertCount: number;
  robinhoodCryptoAccountEligible: boolean; // readRobinhoodCryptoExecutionSnapshot().accountEligible
}

export type CryptoLiveGateResult = { go: true } | { go: false; gate: string; reason: string };

export function evaluateCryptoLiveEntry(input: CryptoLiveGateInput): CryptoLiveGateResult {
  if (!input.deploymentFlagEnabled) return fail("deployment_flag_inactive", "CRYPTO_LIVE_ENABLED=false");
  if (!input.liveAutoEnabled) return fail("db_toggle_off", "crypto_live_auto_enabled=false in strategy_config");
  if (input.appPaused) return fail("app_paused", "strategy_config.app_paused=true");
  if (input.securityLocked) return fail("security_locked", "strategy_config.security_locked=true");
  if (!input.robinhoodCryptoAccountEligible) {
    return fail("crypto_account_not_eligible", "Robinhood crypto account is not eligible/connected — no live order without a real, current account check");
  }
  if (!Number.isFinite(input.leaseUsd) || input.leaseUsd <= 0) {
    return fail("no_lease_capacity", `crypto_live_lease_usd=${input.leaseUsd} — owner has not set a live lease`);
  }
  if (!Number.isFinite(input.openUnresolvedCriticalAlertCount) || input.openUnresolvedCriticalAlertCount > 0) {
    return fail("open_critical_alerts", `${input.openUnresolvedCriticalAlertCount} unresolved critical alert(s) — kill-switch`);
  }
  if (!input.minPaperTradesOverride && input.closedPaperTradeCount < CRYPTO_LIVE_MIN_PAPER_TRADES) {
    return fail(
      "insufficient_paper_evidence",
      `${input.closedPaperTradeCount}/${CRYPTO_LIVE_MIN_PAPER_TRADES} closed paper trades for this symbol (no override set)`,
    );
  }
  return { go: true };
}

function fail(gate: string, reason: string): CryptoLiveGateResult {
  return { go: false, gate, reason };
}
