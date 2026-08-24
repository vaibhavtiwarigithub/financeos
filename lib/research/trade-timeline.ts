export type TradeVenue = "paper" | "live";
export type TradeStage = "proposal" | "order" | "fill";

export interface DecisionTradeEvent {
  id: string;
  venue: TradeVenue;
  stage: TradeStage;
  side: "buy" | "sell";
  status: string;
  occurred_at: string;
  qty: number | null;
  price: number | null;
  analyst_score: number | null;
  scores: {
    fundamental: number | null;
    technical: number | null;
    sentiment: number | null;
    macro: number | null;
  } | null;
  realized_pnl_pct: number | null;
  reason: string | null;
  is_execution: boolean;
}

export interface PaperTradeTimelineRow {
  id: string | number;
  order_side?: string | null;
  qty?: number | string | null;
  fill_price?: number | string | null;
  entry_price?: number | string | null;
  exit_price?: number | string | null;
  executed_at?: string | null;
  exit_at?: string | null;
  closed_at?: string | null;
  realized_pnl_pct?: number | string | null;
  pnl_pct?: number | string | null;
  analyst_score?: number | string | null;
  fundamental_score?: number | string | null;
  technical_score?: number | string | null;
  sentiment_score?: number | string | null;
  macro_score?: number | string | null;
  rationale?: string | null;
  exit_reason?: string | null;
}

export interface LiveProposalTimelineRow {
  id: string | number;
  side?: string | null;
  qty?: number | string | null;
  status?: string | null;
  created_at?: string | null;
  price_at_proposal?: number | string | null;
  analyst_score?: number | string | null;
  thesis?: string | null;
}

export interface BrokerOrderTimelineRow {
  id: string | number;
  side?: string | null;
  qty?: number | string | null;
  status?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  closed_at?: string | null;
  avg_fill_price?: number | string | null;
  filled_qty?: number | string | null;
  error?: string | null;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function side(value: unknown): "buy" | "sell" | null {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "buy" || normalized === "sell" ? normalized : null;
}

/**
 * paper_trades is a lot ledger, not an event ledger. A long lot remains
 * order_side=buy when it closes; the SELL is represented by exit_at/exit_price.
 * Expand that shape into the actions a person expects to see on a timeline.
 */
export function paperTradeEvents(rows: PaperTradeTimelineRow[]): DecisionTradeEvent[] {
  const events: DecisionTradeEvent[] = [];
  for (const row of rows) {
    const rowSide = side(row.order_side);
    if (!rowSide) continue;
    const executedAt = row.executed_at;
    const exitAt = row.exit_at ?? row.closed_at;

    if (executedAt) {
      events.push({
        id: `paper:${row.id}:entry`,
        venue: "paper",
        stage: "fill",
        side: rowSide,
        status: "filled",
        occurred_at: executedAt,
        qty: finite(row.qty),
        price: finite(row.fill_price ?? row.entry_price),
        analyst_score: finite(row.analyst_score),
        scores: {
          fundamental: finite(row.fundamental_score),
          technical: finite(row.technical_score),
          sentiment: finite(row.sentiment_score),
          macro: finite(row.macro_score),
        },
        realized_pnl_pct: rowSide === "sell" ? finite(row.realized_pnl_pct ?? row.pnl_pct) : null,
        reason: row.rationale ?? null,
        is_execution: true,
      });
    }

    // A closed long lot records the sale on the original BUY row. Explicit
    // SELL rows are already represented by the entry event and must not be
    // inverted into a fictitious BUY.
    if (rowSide === "buy" && exitAt) {
      events.push({
        id: `paper:${row.id}:exit`,
        venue: "paper",
        stage: "fill",
        side: "sell",
        status: "filled",
        occurred_at: exitAt,
        qty: finite(row.qty),
        price: finite(row.exit_price),
        analyst_score: null,
        scores: null,
        realized_pnl_pct: finite(row.realized_pnl_pct ?? row.pnl_pct),
        reason: row.exit_reason ?? null,
        is_execution: true,
      });
    }
  }
  return events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export function liveDecisionEvents(
  proposals: LiveProposalTimelineRow[],
  orders: BrokerOrderTimelineRow[],
): DecisionTradeEvent[] {
  const events: DecisionTradeEvent[] = [];
  for (const row of proposals) {
    const rowSide = side(row.side);
    if (!rowSide || !row.created_at) continue;
    events.push({
      id: `proposal:${row.id}`,
      venue: "live",
      stage: "proposal",
      side: rowSide,
      status: row.status ?? "unknown",
      occurred_at: row.created_at,
      qty: finite(row.qty),
      price: finite(row.price_at_proposal),
      analyst_score: finite(row.analyst_score),
      scores: null,
      realized_pnl_pct: null,
      reason: row.thesis ?? null,
      is_execution: false,
    });
  }
  for (const row of orders) {
    const rowSide = side(row.side);
    const occurredAt = row.closed_at ?? row.submitted_at ?? row.created_at;
    if (!rowSide || !occurredAt) continue;
    const filledQty = finite(row.filled_qty);
    const isFill = (filledQty ?? 0) > 0 || row.status === "filled" || row.status === "partially_filled";
    events.push({
      id: `order:${row.id}`,
      venue: "live",
      stage: isFill ? "fill" : "order",
      side: rowSide,
      status: row.status ?? "unknown",
      occurred_at: occurredAt,
      qty: isFill ? filledQty : finite(row.qty),
      price: isFill ? finite(row.avg_fill_price) : null,
      analyst_score: null,
      scores: null,
      realized_pnl_pct: null,
      reason: row.error ?? null,
      is_execution: isFill,
    });
  }
  return events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export function latestExecutionEvent(events: DecisionTradeEvent[]): DecisionTradeEvent | null {
  return events.find((event) => event.is_execution) ?? null;
}
