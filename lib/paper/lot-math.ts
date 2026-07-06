// Pure P&L math extracted from position-monitor's closePosition — no DB, no
// currency, no side effects. One lot = one paper_trades row (qty + fill_price).
// Each lot must be closed against its OWN entry price, never the aggregated
// position's, or multi-lot symbols double-count / mislabel P&L (see the
// Codex-review fix in app/api/agents/position-monitor/route.ts).

export interface Lot { qty: number; fillPrice: number }
export type Outcome = "win" | "loss" | "breakeven";

export function lotRealizedPnl(lot: Lot, exitPrice: number): number {
  return (exitPrice - lot.fillPrice) * lot.qty;
}

export function lotPnlPct(lot: Lot, exitPrice: number): number {
  return lot.fillPrice > 0 ? ((exitPrice - lot.fillPrice) / lot.fillPrice) * 100 : 0;
}

export function lotOutcome(pnl: number): Outcome {
  if (pnl > 0.5) return "win";
  if (pnl < -0.5) return "loss";
  return "breakeven";
}
