/** Paper experiment risk accounting. Percentages use portfolio NAV, not cash.
 * SOXL's factor is a conservative daily exposure proxy, not a measured beta.
 * This module alone cannot authorize an entry or change a position.
 */
export const SEMICONDUCTOR_RISK_VERSION = "semiconductor-paper-risk-v2";
export const SOXL_MAX_NAV_FRACTION = 0.05;
const DIRECT = new Set(["SOXL", "SOXX", "SMH", "ARM", "NVDA", "AMD", "AVGO", "MU", "INTC", "QCOM", "TSM", "MRVL", "AMAT", "LRCX", "KLAC", "ASML", "ADI", "TXN", "MCHP", "ON", "MPWR"]);

export interface SemiconductorHolding {
  symbol: string;
  marketValue: number;
  /** Current portfolio classification; null means no reliable classification. */
  semiconductor: boolean | null;
}

export function semiconductorCapacity(input: {
  nav: number;
  cash: number;
  stopDistancePct: number;
  riskBudgetPct: number;
  exposureCapPct: number;
  holdings: SemiconductorHolding[];
}): { ok: true; maxNotional: number; exposureBefore: number; version: string } | { ok: false; reason: string } {
  const { nav, cash, stopDistancePct, riskBudgetPct, exposureCapPct } = input;
  if (![nav, cash, stopDistancePct, riskBudgetPct, exposureCapPct].every(Number.isFinite)
    || nav <= 0 || cash < 0 || stopDistancePct <= 0 || stopDistancePct >= 100
    || riskBudgetPct <= 0 || riskBudgetPct > 100 || exposureCapPct <= 0 || exposureCapPct > 100) {
    return { ok: false, reason: "invalid_risk_inputs" };
  }
  let exposureBefore = 0;
  for (const holding of input.holdings) {
    const symbol = holding.symbol.trim().toUpperCase();
    if (!Number.isFinite(holding.marketValue) || holding.marketValue < 0)
      return { ok: false, reason: "invalid_holding_mark" };
    if (!DIRECT.has(symbol) && holding.semiconductor == null && holding.marketValue > 0)
      return { ok: false, reason: "unclassified_portfolio_exposure" };
    if (DIRECT.has(symbol) || holding.semiconductor === true)
      exposureBefore += holding.marketValue * (symbol === "SOXL" ? 3 : 1);
    if (symbol === "SOXL" && holding.marketValue > 0)
      return { ok: false, reason: "existing_soxl_position" };
  }
  const exposureCapacity = Math.max(0, nav * exposureCapPct / 100 - exposureBefore) / 3;
  const riskCapacity = nav * riskBudgetPct / stopDistancePct;
  const maxNotional = Math.min(cash, nav * SOXL_MAX_NAV_FRACTION, exposureCapacity, riskCapacity);
  return { ok: true, maxNotional, exposureBefore, version: SEMICONDUCTOR_RISK_VERSION };
}
