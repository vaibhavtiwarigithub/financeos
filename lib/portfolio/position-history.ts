export type PositionMarkRow = {
  position_id: string;
  symbol: string;
  market: string;
  session_date: string;
  recorded_at: string;
  mark_price: number | string;
  provenance: string;
  stale: boolean;
  source: string;
};

export type PositionHistoryPoint = {
  sessionDate: string;
  markPrice: number;
  returnPctFromFirstMark: number;
  provenance: "live_quote" | "carry_forward" | "entry_cost";
  stale: boolean;
  source: string;
};

export type PositionHistorySeries = {
  symbol: string;
  points: PositionHistoryPoint[];
  asOf: string | null;
  truncated?: boolean;
  status: "ready" | "insufficient_history" | "unavailable";
};

export type PositionActivityRow = {
  id: string;
  market: string;
  symbol: string;
  order_side: string;
  qty: number | string;
  fill_price: number | string;
  executed_at: string;
  signal_id?: string | null;
  paper_event_id?: number | string | null;
  position_role?: string | null;
  exit_price?: number | string | null;
  exit_reason?: string | null;
  exit_at?: string | null;
  closed_at?: string | null;
  partial_exit_lot?: boolean | null;
};

export type PositionActivityEvent = {
  at: string;
  side: "buy" | "sell";
  quantity: number;
  fillPrice: number;
  notional: number;
  quantityAfter: number;
  reason: string | null;
};

export type PositionActivitySeries = {
  events: PositionActivityEvent[];
  status: "ready" | "unavailable" | "reconciliation_mismatch";
  reconstructedQty: number | null;
};

const PROVENANCE = new Set(["live_quote", "carry_forward", "entry_cost"]);

const positive = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

function activityLineageKey(row: PositionActivityRow): string | null {
  const eventId = row.paper_event_id == null ? "" : String(row.paper_event_id);
  const signalId = row.signal_id ?? "";
  if (!eventId && !signalId) return row.partial_exit_lot ? null : `${row.executed_at}|${row.id}`;
  return [row.market, row.symbol.toUpperCase(), row.position_role ?? "alpha", row.executed_at, eventId, signalId].join("|");
}

/**
 * Reconstruct only the current position epoch from the immutable paper-lot
 * ledger. Partial-exit residual rows carry the same entry lineage and are
 * folded back into their original buy; the closed slice remains the sale.
 * A missing open timestamp, ambiguous residual, malformed fill, or ending
 * quantity mismatch is an explicit refusal, never a plausible-looking chart.
 */
export function buildPositionActivitySeries(args: {
  positionId: string;
  symbol: string;
  market: "us" | "india";
  positionRole?: string | null;
  openedAt: string | null;
  currentQty: number;
  rows: PositionActivityRow[];
}): PositionActivitySeries {
  if (!args.openedAt || !Number.isFinite(Date.parse(args.openedAt)) || !positive(args.currentQty)) {
    return { events: [], status: "unavailable", reconstructedQty: null };
  }
  const openedAt = Date.parse(args.openedAt);
  const scoped = args.rows.filter(row => row.market === args.market
    && row.symbol.toUpperCase() === args.symbol.toUpperCase()
    && (row.position_role ?? null) === (args.positionRole ?? null)
    && Number.isFinite(Date.parse(row.executed_at))
    && Date.parse(row.executed_at) >= openedAt);
  if (!scoped.length) return { events: [], status: "unavailable", reconstructedQty: null };

  const groups = new Map<string, PositionActivityRow[]>();
  const sales: PositionActivityEvent[] = [];
  for (const row of scoped) {
    if (String(row.order_side).toLowerCase() !== "buy") {
      return { events: [], status: "unavailable", reconstructedQty: null };
    }
    const qty = positive(row.qty);
    const fillPrice = positive(row.fill_price);
    if (!qty || !fillPrice) return { events: [], status: "unavailable", reconstructedQty: null };
    const key = activityLineageKey(row);
    if (!key) return { events: [], status: "unavailable", reconstructedQty: null };
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);

    const exitAt = row.exit_at ?? row.closed_at;
    if (exitAt) {
      const exitQty = positive(row.qty);
      const exitPrice = positive(row.exit_price);
      if (!exitQty || !exitPrice || !row.exit_reason || !Number.isFinite(Date.parse(exitAt))) {
        return { events: [], status: "unavailable", reconstructedQty: null };
      }
      sales.push({ at: exitAt, side: "sell", quantity: exitQty, fillPrice: exitPrice,
        notional: exitQty * exitPrice, quantityAfter: 0, reason: row.exit_reason });
    }
  }

  const buys: PositionActivityEvent[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const prices = group.map(row => positive(row.fill_price));
    const times = new Set(group.map(row => row.executed_at));
    if (prices.some(price => price == null || Math.abs(price - prices[0]!) > 1e-8) || times.size !== 1) {
      return { events: [], status: "unavailable", reconstructedQty: null };
    }
    const quantity = group.reduce((sum, row) => sum + (positive(row.qty) ?? 0), 0);
    const fillPrice = prices[0]!;
    buys.push({ at: first.executed_at, side: "buy", quantity, fillPrice,
      notional: quantity * fillPrice, quantityAfter: 0, reason: group.some(row => row.partial_exit_lot) ? "entry (partial-exit lineage reconciled)" : "entry/add" });
  }

  const events = [...buys, ...sales].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)
    || (a.side === "buy" ? -1 : 1));
  let quantity = 0;
  for (const event of events) {
    quantity += event.side === "buy" ? event.quantity : -event.quantity;
    if (quantity < -1e-8) return { events: [], status: "unavailable", reconstructedQty: null };
    event.quantityAfter = Math.max(0, quantity);
  }
  const roundedQty = Number(quantity.toFixed(8));
  if (Math.abs(roundedQty - args.currentQty) > Math.max(1e-6, args.currentQty * 1e-8)) {
    return { events, status: "reconciliation_mismatch", reconstructedQty: roundedQty };
  }
  return { events, status: events.length ? "ready" : "unavailable", reconstructedQty: roundedQty };
}

export function buildPositionHistorySeries(args: {
  positionId: string;
  symbol: string;
  market: "us" | "india";
  openedAt: string | null;
  rows: PositionMarkRow[];
}): PositionHistorySeries {
  const openedDate = args.openedAt?.slice(0, 10) ?? null;
  const latestPerSession = new Map<string, PositionMarkRow>();

  for (const row of args.rows) {
    if (row.position_id !== args.positionId || row.market !== args.market) continue;
    if (row.symbol.toUpperCase() !== args.symbol.toUpperCase()) continue;
    if (openedDate && row.session_date < openedDate) continue;
    const price = Number(row.mark_price);
    if (!Number.isFinite(price) || price <= 0 || !PROVENANCE.has(row.provenance)) continue;
    const prior = latestPerSession.get(row.session_date);
    if (!prior || row.recorded_at > prior.recorded_at) latestPerSession.set(row.session_date, row);
  }

  const ordered = [...latestPerSession.values()].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const firstPrice = Number(ordered[0]?.mark_price);
  const points = ordered.map(row => ({
    sessionDate: row.session_date,
    markPrice: Number(row.mark_price),
    returnPctFromFirstMark: ((Number(row.mark_price) / firstPrice) - 1) * 100,
    provenance: row.provenance as PositionHistoryPoint["provenance"],
    stale: row.stale,
    source: row.source,
  }));

  return {
    symbol: args.symbol,
    points,
    asOf: points.at(-1)?.sessionDate ?? null,
    status: points.length >= 2 ? "ready" : points.length === 1 ? "insufficient_history" : "unavailable",
  };
}
