export type PaperPositionMarket = "us" | "india";

const MARKET_CLOCK: Record<PaperPositionMarket, { timeZone: string; suffix: string }> = {
  us: { timeZone: "America/New_York", suffix: "ET" },
  india: { timeZone: "Asia/Kolkata", suffix: "IST" },
};

/** Format a persisted position-open timestamp in the market's own clock. */
export function formatPaperPositionOpenedAt(
  value: string | null | undefined,
  market: PaperPositionMarket,
): string | null {
  if (!value) return null;
  const openedAt = new Date(value);
  if (!Number.isFinite(openedAt.getTime())) return null;

  const { timeZone, suffix } = MARKET_CLOCK[market];
  const date = openedAt.toLocaleDateString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = openedAt.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date} · ${time} ${suffix}`;
}
