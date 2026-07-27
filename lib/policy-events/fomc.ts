import type { FredObservation } from "@/lib/data/fred-macro";

export const FOMC_SOURCE_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";

export type FomcSchedule = { scheduledDate: string; sourceUrl: string };

// The final day of each regularly scheduled meeting, transcribed from the
// Federal Reserve calendar. This is a calendar, not an inferred decision time.
export const FOMC_SCHEDULE: readonly FomcSchedule[] = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09",
  "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
].map((scheduledDate) => ({ scheduledDate, sourceUrl: FOMC_SOURCE_URL }));

export type TargetRange = {
  effectiveDate: string;
  lower: number;
  upper: number;
};

/** Join the official FRED lower/upper series by effective date. */
export function targetRanges(lower: FredObservation[], upper: FredObservation[]): TargetRange[] {
  const upperByDate = new Map(upper.map((row) => [row.date, row.value]));
  return lower
    .map((row) => ({ effectiveDate: row.date, lower: row.value, upper: upperByDate.get(row.date) }))
    .filter((row): row is TargetRange => Number.isFinite(row.lower) && Number.isFinite(row.upper))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

/** First full daily target-range observation on or after a scheduled event. */
export function resolveScheduledDecision(ranges: TargetRange[], scheduledDate: string): TargetRange | null {
  return ranges.find((range) => range.effectiveDate >= scheduledDate) ?? null;
}

/** FOMC policy statements are scheduled for 2:00 PM New York time. */
export function scheduledDecisionTimeReached(scheduledDate: string, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  if (localDate !== scheduledDate) return localDate > scheduledDate;
  return Number(value("hour")) >= 14;
}

export type FrozenReturn = {
  sessionDate: string;
  simpleReturn: number;
  priceBasis: "adjusted_close" | "raw_close";
  source: string;
};

export function compoundReturn(rows: FrozenReturn[]): number | null {
  if (!rows.length) return null;
  let product = 1;
  for (const row of rows) {
    if (!Number.isFinite(row.simpleReturn) || row.simpleReturn <= -1) return null;
    product *= 1 + row.simpleReturn;
  }
  return Number.isFinite(product) ? product - 1 : null;
}

export function completePostEventWindow(
  rows: FrozenReturn[],
  eventEffectiveDate: string,
  horizonSessions: number,
): FrozenReturn[] | null {
  const byDate = new Map<string, FrozenReturn>();
  for (const row of rows) {
    if (row.sessionDate > eventEffectiveDate) byDate.set(row.sessionDate, row);
  }
  const selected = [...byDate.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate)).slice(0, horizonSessions);
  return selected.length === horizonSessions ? selected : null;
}

export function impactFingerprint(input: {
  eventId: string;
  symbol: string;
  horizonSessions: number;
  rows: FrozenReturn[];
  benchmarkRows: FrozenReturn[];
}): string {
  const text = [
    input.eventId, input.symbol, input.horizonSessions,
    ...input.rows.map((row) => `${row.sessionDate}:${row.simpleReturn}:${row.priceBasis}:${row.source}`),
    "SPY",
    ...input.benchmarkRows.map((row) => `${row.sessionDate}:${row.simpleReturn}:${row.priceBasis}:${row.source}`),
  ].join("|");
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < text.length; i++) a = ((a << 5) + a + text.charCodeAt(i)) | 0;
  for (let i = text.length - 1; i >= 0; i--) b = ((b << 5) + b + text.charCodeAt(i)) | 0;
  return `fomc${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
