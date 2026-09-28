import type { AtrStopReplayEntry, AtrStopReplayExternalExit } from "@/lib/shadows/atr-stop-forward-replay";

export type PaperLotReplayMarket = "us" | "india";

export interface PaperLotReplayRow {
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
  stop_loss?: number | string | null;
  take_profit?: number | string | null;
  exit_price?: number | string | null;
  exit_reason?: string | null;
  exit_at?: string | null;
  closed_at?: string | null;
  partial_exit_lot?: boolean | null;
}

export interface PaperLotReplayExit extends Omit<AtrStopReplayExternalExit, "reason"> {
  decisionId: string;
  session: string;
  /** Exact source timestamp, retained so replay can reject impossible ordering. */
  filledAt: string;
  classification: "mechanical" | "external";
  reason: "stop" | "target" | AtrStopReplayExternalExit["reason"];
}

export interface PaperLotReplayEvents {
  entries: AtrStopReplayEntry[];
  exits: PaperLotReplayExit[];
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function marketTimezone(market: PaperLotReplayMarket): string {
  return market === "us" ? "America/New_York" : "Asia/Kolkata";
}

/** Convert event timestamps to the exchange-local date used by daily candles. */
export function marketSessionDateAt(timestamp: string, market: PaperLotReplayMarket): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid paper-trade timestamp: ${timestamp}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: marketTimezone(market), year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  if (!year || !month || !day) throw new Error(`Could not derive exchange-local date from ${timestamp}`);
  return `${year}-${month}-${day}`;
}

function classifyExit(reasonValue: unknown): { classification: "mechanical" | "external"; reason: PaperLotReplayExit["reason"] } {
  const reason = String(reasonValue ?? "").trim().toLowerCase();
  if (!reason) throw new Error("Closed paper lot has no exit reason; replay cannot classify its sale.");
  if (/stop_hit|stop_loss/.test(reason)) return { classification: "mechanical", reason: "stop" };
  if (/take_profit|partial_target|target_hit/.test(reason)) return { classification: "mechanical", reason: "target" };
  if (reason.includes("capital_rotation")) return { classification: "external", reason: "capital_rotation" };
  if (reason.includes("direction_flip")) return { classification: "external", reason: "direction_flip" };
  if (reason.includes("score")) return { classification: "external", reason: "score" };
  if (reason.includes("manual")) return { classification: "external", reason: "manual" };
  throw new Error(`Unsupported closed-lot exit reason for replay: ${reasonValue}`);
}

function entryLineageKey(row: PaperLotReplayRow): string {
  const eventId = row.paper_event_id == null ? "" : String(row.paper_event_id);
  const signalId = row.signal_id ?? "";
  if (!eventId && !signalId && row.partial_exit_lot) {
    throw new Error(`Residual lot ${row.id} lacks both signal_id and paper_event_id; original entry lineage is unrecoverable.`);
  }
  // Residual lots retain both lineage fields and executed_at in execute_paper_exit.
  return [row.market, row.symbol.toUpperCase(), row.position_role ?? "alpha", row.executed_at, eventId, signalId].join("|");
}

/**
 * Convert the actual paper lot ledger into session entry/sale events. This
 * understands the production partial-exit contract: the sold slice remains on
 * the original lot and the remaining slice is a cloned `partial_exit_lot` with
 * the same entry timestamp and signal/event lineage. Ambiguous or unsupported
 * lineage fails closed rather than inventing a sale or quantity.
 */
export function paperLotReplayEvents(input: {
  market: PaperLotReplayMarket;
  rows: PaperLotReplayRow[];
  afterSession: string;
  throughSession: string;
  atr14BySignalId: Record<string, number | null | undefined>;
}): PaperLotReplayEvents {
  if (input.throughSession <= input.afterSession) throw new Error("Replay event window must advance by at least one session.");
  const buyGroups = new Map<string, PaperLotReplayRow[]>();
  const exits: PaperLotReplayExit[] = [];

  for (const row of input.rows) {
    if (row.market !== input.market) throw new Error(`Trade ${row.id} belongs to ${row.market}, not replay market ${input.market}.`);
    if (String(row.order_side).toLowerCase() !== "buy") {
      // Current production uses paper_trades as a long-lot ledger, not an order
      // event ledger. A second explicit sell stream needs a defined dedupe key.
      throw new Error(`Unexpected order_side=${row.order_side} in the paper lot ledger; reconcile it before replay.`);
    }
    const qty = finitePositive(row.qty);
    const fillPrice = finitePositive(row.fill_price);
    if (!qty || !fillPrice) throw new Error(`Paper lot ${row.id} has invalid quantity or entry fill.`);

    const entrySession = marketSessionDateAt(row.executed_at, input.market);
    if (entrySession > input.afterSession && entrySession <= input.throughSession) {
      const key = entryLineageKey(row);
      const group = buyGroups.get(key) ?? [];
      group.push(row);
      buyGroups.set(key, group);
    }

    const exitAt = row.exit_at ?? row.closed_at;
    if (!exitAt) continue;
    const exitSession = marketSessionDateAt(exitAt, input.market);
    if (exitSession <= input.afterSession || exitSession > input.throughSession) continue;
    const exitQty = finitePositive(row.qty);
    const exitPrice = finitePositive(row.exit_price);
    if (!exitQty || !exitPrice) throw new Error(`Closed paper lot ${row.id} lacks exact exit quantity/price.`);
    const classified = classifyExit(row.exit_reason);
    exits.push({
      decisionId: `${row.id}:exit`, symbol: row.symbol, session: exitSession,
      quantity: exitQty, fillPrice: exitPrice, filledAt: exitAt, reason: classified.reason,
      classification: classified.classification,
    });
  }

  const entries: AtrStopReplayEntry[] = [];
  for (const group of buyGroups.values()) {
    const first = group[0];
    const quantities = group.map((row) => finitePositive(row.qty));
    const prices = group.map((row) => finitePositive(row.fill_price));
    if (quantities.some((value) => value == null) || prices.some((value) => value == null)
      || prices.some((value) => Math.abs(value! - prices[0]!) > 1e-8)) {
      throw new Error(`Partial-lot group ${first.symbol}/${first.executed_at} has inconsistent entry quantity or price lineage.`);
    }
    const stops = group.map((row) => finitePositive(row.stop_loss));
    const targets = group.map((row) => finitePositive(row.take_profit));
    if (stops.some((value) => value == null) || targets.some((value) => value == null)
      || stops.some((value) => Math.abs(value! - stops[0]!) > 1e-8)
      || targets.some((value) => Math.abs(value! - targets[0]!) > 1e-8)) {
      throw new Error(`Entry ${first.symbol}/${first.executed_at} lacks one consistent exact stop/target across its residual lots.`);
    }
    const session = marketSessionDateAt(first.executed_at, input.market);
    const atr = first.signal_id ? input.atr14BySignalId[first.signal_id] : null;
    entries.push({
      decisionId: `paper-entry:${entryLineageKey(first)}`,
      symbol: first.symbol,
      session,
      filledAt: first.executed_at,
      quantity: quantities.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      fillPrice: prices[0]!,
      baselineStopLoss: stops[0]!,
      priceTarget: targets[0]!,
      atr14AtDecision: finitePositive(atr) ?? Number.NaN,
    });
  }

  entries.sort((a, b) => a.session.localeCompare(b.session) || a.decisionId.localeCompare(b.decisionId));
  exits.sort((a, b) => a.session.localeCompare(b.session) || a.decisionId.localeCompare(b.decisionId));
  return { entries, exits };
}
