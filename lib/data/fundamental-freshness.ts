const DAY_MS = 86_400_000;
const EVENT_LOOKBACK_DAYS = 3;
const EVENT_LOOKAHEAD_DAYS = 14;

export const DEFAULT_FUNDAMENTAL_MAX_AGE_DAYS = 7;
export const EVENT_FUNDAMENTAL_MAX_AGE_DAYS = 1;

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}
export function reportedFundamentalMaxAgeDays(
  reportDates: Array<string | null | undefined>,
  asOf = new Date(),
): number {
  const asOfDay = utcDay(asOf);
  const nearEvent = reportDates.some((value) => {
    if (!value) return false;
    const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) return false;
    const deltaDays = (utcDay(parsed) - asOfDay) / DAY_MS;
    return deltaDays >= -EVENT_LOOKBACK_DAYS && deltaDays <= EVENT_LOOKAHEAD_DAYS;
  });
  return nearEvent ? EVENT_FUNDAMENTAL_MAX_AGE_DAYS : DEFAULT_FUNDAMENTAL_MAX_AGE_DAYS;
}

export type FundamentalFreshnessEntry = {
  symbol: string;
  isEtf: boolean;
  fundamentalMaxAgeDays?: number;
};

export async function annotateFundamentalFreshness<T extends FundamentalFreshnessEntry>(
  entries: T[],
  supabase: any,
  asOf = new Date(),
): Promise<T[]> {
  const symbols = [...new Set(entries.filter((entry) => !entry.isEtf).map((entry) => entry.symbol.toUpperCase()))];
  const datesBySymbol = new Map<string, string[]>();

  if (symbols.length > 0) {
    try {
      const { data, error } = await supabase
        .from("earnings_calendar")
        .select("symbol,report_date")
        .in("symbol", symbols);
      if (!error) {
        for (const row of data ?? []) {
          const symbol = String(row.symbol ?? "").toUpperCase();
          const reportDate = String(row.report_date ?? "");
          if (!symbol || !reportDate) continue;
          const dates = datesBySymbol.get(symbol) ?? [];
          dates.push(reportDate);
          datesBySymbol.set(symbol, dates);
        }
      }
    } catch {
      // Unknown calendar state uses the conservative seven-day default.
    }
  }

  return entries.map((entry) => ({
    ...entry,
    fundamentalMaxAgeDays: entry.isEtf
      ? DEFAULT_FUNDAMENTAL_MAX_AGE_DAYS
      : reportedFundamentalMaxAgeDays(datesBySymbol.get(entry.symbol.toUpperCase()) ?? [], asOf),
  }));
}
