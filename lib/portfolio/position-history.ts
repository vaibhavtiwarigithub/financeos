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

const PROVENANCE = new Set(["live_quote", "carry_forward", "entry_cost"]);

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
