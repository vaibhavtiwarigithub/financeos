export function replayHistoryNeedsRefresh(input: {
  oldestDate: string | null;
  latestDate: string | null;
  expectedLatestDate: string;
  oldestAcceptableDate: string;
}): boolean {
  return !input.oldestDate
    || !input.latestDate
    || input.oldestDate > input.oldestAcceptableDate
    || input.latestDate < input.expectedLatestDate;
}
