export type CurrentPaperPnl = {
  amount: number;
  pct: number;
  currentPrice: number;
  markedAt: string | null;
};

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export function currentPaperTradePnl(
  trade: any,
  positions: any[],
  market: "us" | "india",
): CurrentPaperPnl | null {
  if (trade?.closed_at != null || trade?.outcome != null || String(trade?.order_side).toLowerCase() !== "buy") return null;
  if ((trade?.market ?? "us") !== market) return null;

  const position = positions.find(positionRow =>
    (positionRow?.market ?? "us") === market
      && String(positionRow?.symbol ?? "").toUpperCase() === String(trade?.symbol ?? "").toUpperCase(),
  );
  const currentPrice = finitePositive(position?.current_price);
  const fillPrice = finitePositive(trade?.fill_price);
  const qty = finitePositive(trade?.qty);
  if (currentPrice == null || fillPrice == null || qty == null) return null;

  return {
    amount: (currentPrice - fillPrice) * qty,
    pct: ((currentPrice - fillPrice) / fillPrice) * 100,
    currentPrice,
    markedAt: typeof position?.updated_at === "string" ? position.updated_at : null,
  };
}
