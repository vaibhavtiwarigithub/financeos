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
  source: "manual" | "agentic";
  matched_broker_order_id: number | null;
  suggested_stop_price: number | null;
}

export interface ManualDetection {
  symbol: string;
  qty: number;
  suggestedStop: number;
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
): DetectManualFillsResult {
  const rowsToInsert: LedgerRow[] = [];
  const manualDetections: ManualDetection[] = [];

  for (const holding of holdings) {
    const prevQty = lastKnownQty.get(holding.symbol) ?? 0;
    const delta = holding.qty - prevQty;
    if (delta <= 0) continue;

    const matchedOrder = recentOrders.find(
      o => o.symbol === holding.symbol && o.side === "buy" && Math.abs(o.filledQty - delta) < QTY_MATCH_EPSILON,
    );
    const source: "manual" | "agentic" = matchedOrder ? "agentic" : "manual";
    const avgCost = holding.costBasis != null && holding.qty > 0 ? holding.costBasis / holding.qty : holding.currentPrice;
    const suggestedStop = source === "manual" ? Number((avgCost * (1 - stopLossPct / 100)).toFixed(2)) : null;

    rowsToInsert.push({
      account_id: accountId,
      symbol: holding.symbol,
      qty: holding.qty,
      avg_cost: avgCost,
      source,
      matched_broker_order_id: matchedOrder?.id ?? null,
      suggested_stop_price: suggestedStop,
    });

    if (source === "manual") manualDetections.push({ symbol: holding.symbol, qty: delta, suggestedStop: suggestedStop! });
  }

  for (const [symbol, prevQty] of lastKnownQty) {
    const stillHeld = holdings.some(h => h.symbol === symbol);
    if (!stillHeld && prevQty > 0) {
      rowsToInsert.push({ account_id: accountId, symbol, qty: 0, avg_cost: null, source: "manual", matched_broker_order_id: null, suggested_stop_price: null });
    }
  }

  return { rowsToInsert, manualDetections };
}
