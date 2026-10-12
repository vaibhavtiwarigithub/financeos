import { expectedMarketSessionsBetween, getMarketDayStatus } from "@/lib/trading/market-calendar";

export type CouncilClose = { date: string; close: number | null };
export type AvailabilityAlignedLabel = {
  entrySession: string;
  endSession: string;
  symbolReturn: number;
  benchmarkReturn: number;
  benchmarkNeutralReturn: number;
};

function closeAtMs(market: "us" | "india", session: string): number {
  const [year, month, day] = session.split("-").map(Number);
  const zone = market === "us" ? "America/New_York" : "Asia/Kolkata";
  const [hour, minute] = market === "us" ? [16, 0] : [15, 30];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return guess - (localAsUtc - guess);
}

/**
 * Labels a subscription forecast only from a complete regular-session close
 * strictly after the client reported the forecast available. Returns are
 * benchmark-neutral close-to-close price changes; no pre-availability return,
 * raw-return fallback, or cost-adjustment claim is made.
 */
export function availabilityAlignedLabel(args: {
  market: "us" | "india";
  availableAt: string;
  horizonDays: number;
  symbolMarks: CouncilClose[];
  benchmarkMarks: CouncilClose[];
}): AvailabilityAlignedLabel | null {
  const availableAt = Date.parse(args.availableAt);
  if (!Number.isFinite(availableAt) || ![2, 5, 10, 20].includes(args.horizonDays)) return null;
  const closeMap = (marks: CouncilClose[]) => new Map(marks.map((mark) => [mark.date, mark.close]));
  const symbol = closeMap(args.symbolMarks);
  const benchmark = closeMap(args.benchmarkMarks);
  const alignedDates = [...symbol.keys()].filter((date) => {
    const state = getMarketDayStatus(args.market, new Date(`${date}T12:00:00Z`));
    const symbolClose = symbol.get(date), benchmarkClose = benchmark.get(date);
    return state.calendarSupported && state.kind === "trading_day"
      && closeAtMs(args.market, date) > availableAt
      && Number.isFinite(Number(symbolClose)) && Number(symbolClose) > 0
      && Number.isFinite(Number(benchmarkClose)) && Number(benchmarkClose) > 0;
  }).sort();
  const startIndex = 0;
  const endIndex = startIndex + args.horizonDays;
  if (alignedDates.length <= endIndex) return null;
  const entrySession = alignedDates[startIndex];
  const endSession = alignedDates[endIndex];
  let expected: string[];
  try { expected = expectedMarketSessionsBetween(args.market, entrySession, endSession); }
  catch { return null; }
  if (expected.length !== args.horizonDays || expected.some((date, index) => alignedDates[index + 1] !== date)) return null;
  const symbolEntry = symbol.get(entrySession), symbolEnd = symbol.get(endSession);
  const benchmarkEntry = benchmark.get(entrySession), benchmarkEnd = benchmark.get(endSession);
  if ([symbolEntry, symbolEnd, benchmarkEntry, benchmarkEnd].some((value) => value == null || !Number.isFinite(Number(value)) || Number(value) <= 0)) return null;
  const symbolReturn = Number(symbolEnd) / Number(symbolEntry) - 1;
  const benchmarkReturn = Number(benchmarkEnd) / Number(benchmarkEntry) - 1;
  return { entrySession, endSession, symbolReturn, benchmarkReturn, benchmarkNeutralReturn: symbolReturn - benchmarkReturn };
}
