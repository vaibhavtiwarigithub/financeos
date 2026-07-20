export interface LiveFillOrder {
  proposal_id: number | string | null;
  symbol: string;
  side: "buy" | "sell" | string;
  filled_qty?: unknown;
  qty?: unknown;
  avg_fill_price?: unknown;
  created_at?: string | null;
}

export interface LiveProposalLineage {
  id: number | string;
  account_number?: string | null;
  policy_snapshot?: unknown;
}

export interface LivePositionPolicy {
  stopLossPct: number;
  targetPct: number;
  maxHoldDays: number;
  horizonDays: number;
  mandateVersion: number;
  source: "ledger_percentile" | "mandate" | "legacy_mandate_fallback";
}

export interface ReconstructedLivePosition {
  symbol: string;
  qty: number;
  avgEntry: number;
  stopPrice: number;
  targetPrice: number;
  firstBuyAt: string;
  horizonDays: number;
  policySource: "recorded" | "legacy_mandate_fallback";
}

type Lot = {
  qty: number;
  entry: number;
  openedAt: number;
  policy: LivePositionPolicy;
};

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function policyFromSnapshot(value: unknown): LivePositionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = (value as any).execution_trade_plan;
  if (!plan || typeof plan !== "object" || plan.version !== "v1") return null;
  const stopLossPct = positive(plan.stop_loss_pct);
  const targetPct = positive(plan.target_pct);
  const maxHoldDays = positive(plan.max_hold_days);
  const horizonDays = positive(plan.horizon_days);
  const mandateVersion = positive(plan.mandate_version);
  if (stopLossPct == null || targetPct == null || maxHoldDays == null || horizonDays == null || mandateVersion == null) return null;
  if (stopLossPct > 30 || targetPct > 100 || maxHoldDays > 252 || horizonDays > maxHoldDays) return null;
  return {
    stopLossPct,
    targetPct,
    maxHoldDays: Math.round(maxHoldDays),
    horizonDays: Math.round(horizonDays),
    mandateVersion: Math.round(mandateVersion),
    source: plan.source === "ledger_percentile" ? "ledger_percentile" : "mandate",
  };
}

export function reconstructAccountLivePositions(args: {
  orders: LiveFillOrder[];
  proposals: LiveProposalLineage[];
  activeAccount: string;
  fallbackPolicy: Omit<LivePositionPolicy, "source">;
}): ReconstructedLivePosition[] {
  const proposalById = new Map(args.proposals.map(p => [String(p.id), p]));
  const lotsBySymbol = new Map<string, Lot[]>();
  const sorted = [...args.orders].sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));

  for (const order of sorted) {
    const proposal = order.proposal_id == null ? null : proposalById.get(String(order.proposal_id));
    if (!proposal || proposal.account_number !== args.activeAccount) continue;
    const symbol = String(order.symbol ?? "").trim().toUpperCase();
    const qty = positive(order.filled_qty) ?? positive(order.qty);
    if (!symbol || qty == null) continue;
    const lots = lotsBySymbol.get(symbol) ?? [];

    if (order.side === "buy") {
      const entry = positive(order.avg_fill_price);
      const openedAt = Date.parse(order.created_at ?? "");
      if (entry == null || !Number.isFinite(openedAt)) continue;
      const recorded = policyFromSnapshot(proposal.policy_snapshot);
      lots.push({
        qty,
        entry,
        openedAt,
        policy: recorded ?? { ...args.fallbackPolicy, source: "legacy_mandate_fallback" },
      });
    } else if (order.side === "sell") {
      let remaining = qty;
      while (remaining > 1e-9 && lots.length) {
        const lot = lots[0];
        const consumed = Math.min(remaining, lot.qty);
        lot.qty -= consumed;
        remaining -= consumed;
        if (lot.qty <= 1e-9) lots.shift();
      }
    }
    lotsBySymbol.set(symbol, lots);
  }

  const positions: ReconstructedLivePosition[] = [];
  for (const [symbol, lots] of lotsBySymbol) {
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    if (qty <= 1e-9) continue;
    const weighted = (fn: (lot: Lot) => number) => lots.reduce((sum, lot) => sum + fn(lot) * lot.qty, 0) / qty;
    const firstBuy = Math.min(...lots.map(lot => lot.openedAt));
    const round = (value: number) => Number(value.toFixed(6));
    positions.push({
      symbol,
      qty,
      avgEntry: round(weighted(lot => lot.entry)),
      stopPrice: round(weighted(lot => lot.entry * (1 - lot.policy.stopLossPct / 100))),
      targetPrice: round(weighted(lot => lot.entry * (1 + lot.policy.targetPct / 100))),
      firstBuyAt: new Date(firstBuy).toISOString(),
      horizonDays: lots[0].policy.horizonDays,
      policySource: lots.every(lot => lot.policy.source !== "legacy_mandate_fallback") ? "recorded" : "legacy_mandate_fallback",
    });
  }
  return positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeSnapshotHolding(value: unknown): {
  symbol: string;
  qty: number;
  avgPrice: number | null;
  currentPrice: number | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as any;
  const symbol = String(row.symbol ?? row.tradingsymbol ?? "").trim().toUpperCase();
  const qty = positive(row.qty ?? row.quantity);
  if (!symbol || qty == null) return null;
  return {
    symbol,
    qty,
    avgPrice: positive(row.avg_price ?? row.average_buy_price ?? row.average_price),
    currentPrice: positive(row.current_price ?? row.last_price ?? row.ltp),
  };
}

export function canonicalPositionSymbol(symbol: string, market: "us" | "india"): string {
  const upper = String(symbol ?? "").trim().toUpperCase();
  return market === "india" ? upper.replace(/\.(NS|BO)$/, "") : upper;
}
