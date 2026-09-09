// Manual Trade Guardian — Stage 0 pure detection core.
// Spec: features/manual-trade-guardian/FEATURE_ARCHITECTURE.md.
//
// Pulled out of the cron route so the diff/matching logic is directly
// testable without mocking Supabase or the broker MCP (matches this
// project's convention — see lib/risk/holding-risk.ts + tests/holding-risk.test.ts).
// The route stays a thin shell: fetch, call this, write, alert.

export interface ManualFillHoldingInput {
  symbol: string;
  qty: number;
  currentPrice: number;
  costBasis?: number | null;
}

export interface RecentOrderInput {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  filledQty: number;
}

export interface LedgerRow {
  account_id: string;
  symbol: string;
  qty: number;
  avg_cost: number | null;
  source: "baseline" | "manual" | "agentic" | "unknown";
  matched_broker_order_id: number | null;
  suggested_stop_price: number | null;
  delta_qty: number;
  transition_side: "buy" | "sell" | "baseline";
  matched_broker_order_ids: number[];
}

export interface ManualDetection {
  symbol: string;
  qty: number;
  suggestedStop: number | null;
}

export interface DetectManualFillsResult {
  rowsToInsert: LedgerRow[];
  manualDetections: ManualDetection[];
}

const QTY_MATCH_EPSILON = 0.0001;

/**
 * Diff live holdings against the last known qty per symbol and classify every
 * increase as manual (no matching Kairos order) or agentic (matched). A
 * decrease (partial or full exit) gets a zero-qty ledger row with no stop
 * suggestion — Section 2.5 of the architecture doc: exits are explicitly out
 * of scope for this route, manual selling is the owner's own job.
 */
export function detectManualFills(
  accountId: string,
  holdings: ManualFillHoldingInput[],
  lastKnownQty: Map<string, number>,
  recentOrders: RecentOrderInput[],
  stopLossPct: number,
  isBootstrap = false,
): DetectManualFillsResult {
  const rowsToInsert: LedgerRow[] = [];
  const manualDetections: ManualDetection[] = [];

  const bySymbol = new Map(holdings.map(h => [h.symbol.toUpperCase(), h]));
  const symbols = new Set([...lastKnownQty.keys(), ...bySymbol.keys()]);
  for (const rawSymbol of symbols) {
    const symbol = rawSymbol.toUpperCase();
    const holding = bySymbol.get(symbol);
    const currentQty = holding?.qty ?? 0;
    const prevQty = lastKnownQty.get(symbol) ?? 0;
    const delta = currentQty - prevQty;
    if (!isBootstrap && Math.abs(delta) < QTY_MATCH_EPSILON) continue;
    if (isBootstrap && !holding) continue;

    const transitionSide: "buy" | "sell" | "baseline" = isBootstrap ? "baseline" : delta > 0 ? "buy" : "sell";
    const candidates = isBootstrap ? [] : recentOrders.filter(
      o => o.symbol.toUpperCase() === symbol && o.side === transitionSide && Number.isFinite(o.filledQty) && o.filledQty > 0,
    );
    const candidateTotal = candidates.reduce((sum, o) => sum + o.filledQty, 0);
    const exactAggregate = candidates.length > 0 && Math.abs(candidateTotal - Math.abs(delta)) < QTY_MATCH_EPSILON;
    const source: LedgerRow["source"] = isBootstrap ? "baseline" : exactAggregate ? "agentic" : candidates.length ? "unknown" : "manual";
    const avgCost = holding?.costBasis != null && currentQty > 0 ? holding.costBasis / currentQty : null;
    const suggestedStop = source === "manual" && transitionSide === "buy" && avgCost != null
      ? Number((avgCost * (1 - stopLossPct / 100)).toFixed(2)) : null;

    rowsToInsert.push({
      account_id: accountId,
      symbol,
      qty: currentQty,
      avg_cost: avgCost,
      source,
      matched_broker_order_id: candidates.length === 1 && exactAggregate ? candidates[0].id : null,
      suggested_stop_price: suggestedStop,
      delta_qty: isBootstrap ? currentQty : delta,
      transition_side: transitionSide,
      matched_broker_order_ids: exactAggregate ? candidates.map(o => o.id) : [],
    });

    if (source === "manual" && transitionSide === "buy") manualDetections.push({ symbol, qty: delta, suggestedStop });
  }

  return { rowsToInsert, manualDetections };
}
