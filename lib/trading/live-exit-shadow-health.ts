export type LiveExitMarket = "us" | "india";

/** Safe operational counters for a single market's live-exit monitor invocation. */
export interface LiveExitMarketDiagnostics {
  market: LiveExitMarket;
  accountConfigured: boolean;
  marketOpen: boolean | null;
  blockedReason: "no_config" | "paused_or_locked" | null;
  shadowMode: boolean | null;
  fillRowsRead: number;
  accountMatchedFillRows: number;
  accountMatchedBuyFills: number;
  accountMatchedSellFills: number;
  reconstructedPositions: number;
  positionsChecked: number;
  quotesUnavailable: number;
  shadowRowsWritten: number;
  stateWriteFailures: number;
  shadowWriteFailures: number;
}

export interface LiveExitProducerOutcome {
  status: "collected" | "blocked";
  state: string;
  blockers: string[];
}

/**
 * Collection health is deliberately distinct from shadow decisions and P&L.
 * No live account identifiers, symbols, or provider error text are persisted.
 */
export function classifyLiveExitCollection(d: LiveExitMarketDiagnostics): LiveExitProducerOutcome {
  if (d.blockedReason === "no_config") {
    return { status: "blocked", state: "no_strategy_config", blockers: ["Strategy configuration is unavailable."] };
  }
  if (d.blockedReason === "paused_or_locked") {
    return { status: "blocked", state: "monitor_paused_or_locked", blockers: ["The application is paused or security-locked; monitor evaluation was intentionally stopped."] };
  }
  if (!d.accountConfigured) {
    return { status: "blocked", state: "account_not_configured", blockers: ["No active live account is configured for this market."] };
  }
  if (d.marketOpen === false) {
    return { status: "collected", state: "outside_market_session", blockers: [] };
  }
  if (d.accountMatchedBuyFills > 0 && d.accountMatchedSellFills === 0 && d.reconstructedPositions === 0) {
    return { status: "blocked", state: "filled_buy_not_reconstructed", blockers: ["An active-account filled buy was found, but no open position was reconstructed from the fill ledger."] };
  }
  if (d.quotesUnavailable > 0) {
    return { status: "blocked", state: "position_quote_unavailable", blockers: ["At least one reconstructed position had no usable fresh quote; its exit evaluation was skipped."] };
  }
  if (d.stateWriteFailures > 0) {
    return { status: "blocked", state: "position_state_write_failed", blockers: ["At least one position's exit-ladder state could not be persisted."] };
  }
  if (d.shadowWriteFailures > 0) {
    return { status: "blocked", state: "shadow_write_failed", blockers: ["At least one position's shadow decision could not be persisted."] };
  }
  if (d.reconstructedPositions === 0) {
    return { status: "collected", state: "waiting_for_managed_position", blockers: [] };
  }
  if (d.shadowMode === true && d.shadowRowsWritten !== d.reconstructedPositions) {
    return { status: "blocked", state: "shadow_row_count_mismatch", blockers: ["The number of persisted shadow rows does not match the reconstructed position count."] };
  }
  return {
    status: "collected",
    state: d.shadowMode === true ? "shadow_evaluated" : "monitor_evaluated",
    blockers: [],
  };
}
