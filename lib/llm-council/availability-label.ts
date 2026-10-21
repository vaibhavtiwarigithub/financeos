import { expectedMarketSessionsBetween, getMarketDayStatus, researchSessionCloseAt } from "@/lib/trading/market-calendar";

export const AVAILABILITY_LABEL_VERSION = "expected-close-v2";

export type CouncilClose = { date: string; close: number | null };
export type AvailabilityAlignedLabel = {
  entrySession: string;
  endSession: string;
  symbolReturn: number;
  benchmarkReturn: number;
  benchmarkNeutralReturn: number;
};

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
  /** Evaluation cutoff: an intraday cache row is not a completed daily bar. */
  asOf?: string;
  symbolMarks: CouncilClose[];
  benchmarkMarks: CouncilClose[];
}): AvailabilityAlignedLabel | null {
  const availableAt = Date.parse(args.availableAt);
  const cutoff = args.asOf == null ? Date.now() : Date.parse(args.asOf);
  if (!Number.isFinite(availableAt) || !Number.isFinite(cutoff) || availableAt > cutoff || ![2, 5, 10, 20].includes(args.horizonDays)) return null;
  const closeMap = (marks: CouncilClose[]) => new Map(marks.map((mark) => [mark.date, mark.close]));
  const symbol = closeMap(args.symbolMarks);
  const benchmark = closeMap(args.benchmarkMarks);
  // Determine the expected entry independently of data availability. Otherwise
  // a missing first mark silently moves entry to a more convenient later day.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: args.market === "us" ? "America/New_York" : "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(availableAt));
  const part = (type: string) => local.find((p) => p.type === type)?.value;
  const cursor = new Date(`${part("year")}-${part("month")}-${part("day")}T12:00:00Z`);
  let expectedEntry: string | null = null;
  for (let i = 0; i < 15; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const state = getMarketDayStatus(args.market, cursor);
    if (!state.calendarSupported || state.kind === "special_session") return null;
    const close = researchSessionCloseAt(args.market, date);
    if (close != null && close > availableAt) { expectedEntry = date; break; }
  }
  if (!expectedEntry) return null;
  const alignedDates = [...symbol.keys()].filter((date) => {
    const state = getMarketDayStatus(args.market, new Date(`${date}T12:00:00Z`));
    const symbolClose = symbol.get(date), benchmarkClose = benchmark.get(date);
    return state.calendarSupported && state.kind === "trading_day"
      && (researchSessionCloseAt(args.market, date) ?? -Infinity) > availableAt
      && (researchSessionCloseAt(args.market, date) ?? Infinity) <= cutoff
      && Number.isFinite(Number(symbolClose)) && Number(symbolClose) > 0
      && Number.isFinite(Number(benchmarkClose)) && Number(benchmarkClose) > 0;
  }).sort();
  const startIndex = 0;
  const endIndex = startIndex + args.horizonDays;
  if (alignedDates.length <= endIndex) return null;
  const entrySession = alignedDates[startIndex];
  if (entrySession !== expectedEntry) return null;
  const endSession = alignedDates[endIndex];
  const windowCursor = new Date(`${entrySession}T12:00:00Z`);
  while (windowCursor.toISOString().slice(0, 10) <= endSession) {
    if (getMarketDayStatus(args.market, windowCursor).kind === "special_session") return null;
    windowCursor.setUTCDate(windowCursor.getUTCDate() + 1);
  }
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
