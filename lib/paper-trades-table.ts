// Pure sorting / filtering helpers for the Paper Portfolio "Trades" table. Client-safe: no imports, so the "use client" page can use it
// without pulling server modules into the bundle.
//
// Why it exists: the table listed lots newest-ENTRY first with only an entry date, so a position sold today sat below every open lot
// bought more recently and showed no sold date. Users could not find what had been sold when the book went from 8 names to 6.

export type TradeSortKey =
  | "activity" | "symbol" | "side" | "qty" | "fill" | "exit" | "total" | "score" | "plan" | "realized" | "current" | "outcome" | "bought" | "sold" | "reason";
export type SortDir = "asc" | "desc";
export type TradeStatusFilter = "all" | "open" | "sold";

export interface TradeSortProjection {
  symbol: string;
  side: string;
  qty: number | null;
  fill: number | null;
  exit: number | null;
  total: number | null;
  score: number | null;
  plan: string | null;
  realized: number | null;
  current: number | null;
  outcome: string;
  bought: number | null;
  sold: number | null;
  reason: string | null;
}

export const TRADE_COLUMNS: ReadonlyArray<{ key: Exclude<TradeSortKey, "activity">; label: string; numeric: boolean }> = [
  { key: "symbol", label: "Symbol", numeric: false },
  { key: "side", label: "Side", numeric: false },
  { key: "qty", label: "Qty", numeric: true },
  { key: "fill", label: "Fill Price", numeric: true },
  { key: "exit", label: "Exit / Mkt", numeric: true },
  { key: "total", label: "Total", numeric: true },
  { key: "score", label: "Score", numeric: true },
  { key: "plan", label: "Exit Plan", numeric: false },
  { key: "realized", label: "Realized P&L", numeric: true },
  { key: "current", label: "Current P&L", numeric: true },
  { key: "outcome", label: "Outcome", numeric: false },
  { key: "bought", label: "Bought", numeric: true },
  { key: "sold", label: "Sold", numeric: true },
  { key: "reason", label: "Exit reason", numeric: false },
];

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const ms = (v: unknown): number | null => {
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** Flatten one trade row (+ the values the page derives for it) into comparable fields. */
export function projectTrade(
  t: any,
  derived: { currentAmount: number | null; currentPrice: number | null; plan: string | null },
): TradeSortProjection {
  const closed = t.closed_at != null;
  const qty = finite(t.qty);
  const fill = finite(t.fill_price);
  return {
    symbol: String(t.symbol ?? ""),
    side: String(t.order_side ?? ""),
    qty, fill,
    exit: closed ? finite(t.exit_price) : derived.currentPrice,
    total: qty != null && fill != null ? qty * fill : null,
    score: finite(t.analyst_score),
    plan: closed ? (t.exit_reason ? String(t.exit_reason) : null) : derived.plan,
    realized: finite(t.realized_pnl),
    current: derived.currentAmount,
    outcome: t.outcome ? String(t.outcome) : "open",
    bought: ms(t.executed_at),
    sold: ms(t.closed_at),
    reason: t.exit_reason ? String(t.exit_reason) : null,
  };
}

const valueOf = (p: TradeSortProjection, key: TradeSortKey): string | number | null =>
  key === "activity" ? (p.bought == null && p.sold == null ? null : Math.max(p.bought ?? -Infinity, p.sold ?? -Infinity)) : p[key];

/** Nulls always sort last, whatever the direction, so empty cells never crowd the top of a sorted column. */
export function compareProjections(a: TradeSortProjection, b: TradeSortProjection, key: TradeSortKey, dir: SortDir): number {
  const x = valueOf(a, key), y = valueOf(b, key);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  const base = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
  return dir === "asc" ? base : -base;
}

export function sortTrades<T>(rows: readonly T[], project: (row: T) => TradeSortProjection, key: TradeSortKey, dir: SortDir): T[] {
  return rows
    .map((row, index) => ({ row, index, p: project(row) }))
    .sort((a, b) => compareProjections(a.p, b.p, key, dir) || a.index - b.index) // stable: ties keep server order
    .map((x) => x.row);
}

/** First click on a column: text sorts A-Z, numbers and dates newest/largest first. Clicking the active column flips direction. */
export function nextSort(current: { key: TradeSortKey; dir: SortDir }, clicked: Exclude<TradeSortKey, "activity">): { key: TradeSortKey; dir: SortDir } {
  if (current.key === clicked) return { key: clicked, dir: current.dir === "asc" ? "desc" : "asc" };
  const numeric = TRADE_COLUMNS.find((c) => c.key === clicked)?.numeric ?? false;
  return { key: clicked, dir: numeric ? "desc" : "asc" };
}

export function filterByStatus<T extends { closed_at?: unknown }>(rows: readonly T[], status: TradeStatusFilter): T[] {
  if (status === "open") return rows.filter((r) => r.closed_at == null);
  if (status === "sold") return rows.filter((r) => r.closed_at != null);
  return [...rows];
}

export interface RecentSale { symbol: string; soldOn: string; lots: number; realizedPnl: number; reasons: string[] }

/** Sales in the last `days` days, grouped by symbol and sale day, newest first. Several lots of one position sold together show once. */
export function recentlySold(
  trades: ReadonlyArray<{ symbol?: unknown; closed_at?: unknown; realized_pnl?: unknown; exit_reason?: unknown }>,
  nowMs: number, days = 14, limit = 8,
): RecentSale[] {
  const cutoff = nowMs - days * 86_400_000;
  const groups = new Map<string, RecentSale & { t: number }>();
  for (const t of trades) {
    const closed = ms(t.closed_at);
    if (closed == null || closed < cutoff || closed > nowMs + 60_000) continue;
    const soldOn = new Date(closed).toISOString().slice(0, 10);
    const key = `${String(t.symbol)}|${soldOn}`;
    const g = groups.get(key) ?? { symbol: String(t.symbol), soldOn, lots: 0, realizedPnl: 0, reasons: [], t: closed };
    g.lots++;
    g.realizedPnl += finite(t.realized_pnl) ?? 0;
    const reason = t.exit_reason ? String(t.exit_reason) : null;
    if (reason && !g.reasons.includes(reason)) g.reasons.push(reason);
    g.t = Math.max(g.t, closed);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.t - a.t).slice(0, limit).map(({ t: _t, ...rest }) => rest);
}
