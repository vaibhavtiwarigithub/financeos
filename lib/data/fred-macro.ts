import { providerCachedFetch } from "@/lib/data/provider-fetch";

// FRED (St. Louis Fed) macro series adapter — official, free, keyed. Replaces
// MacroSentinel's Alpha Vantage economic endpoints, which are rate-limited on
// the free tier and were the root cause of "unknown regime / 0-of-8 indicators"
// runs that then scored every symbol's macro dimension as a fake 100. FRED does
// not share AV's 25/day budget and does not throttle at this volume.
//
// Series IDs (all official FRED):
//   DGS2/DGS10  2Y/10Y Treasury (daily, %)
//   UNRATE      Unemployment rate (monthly, %)
//   PAYEMS      Total nonfarm payroll (monthly, level thousands)
//   GDPC1       Real GDP (quarterly, level)
//   CPIAUCSL    CPI (monthly, level)
//   RSAFS       Advance retail sales (monthly, level)
//   FEDFUNDS    Effective fed funds rate (monthly, %)
//   DGORDER     Durable goods orders (monthly, level)

export const FRED_SERIES = {
  y2: "DGS2", y10: "DGS10", unemployment: "UNRATE", payrolls: "PAYEMS",
  gdp: "GDPC1", cpi: "CPIAUCSL", retail: "RSAFS", fedFunds: "FEDFUNDS", durables: "DGORDER",
} as const;

export interface FredObservation {
  /** FRED observation date, ISO `YYYY-MM-DD` (period START for monthly series). */
  date: string;
  value: number;
}

// Latest `limit` DATED observations, newest-first, non-finite dropped.
//
// Prefer this over `fredSeries` whenever the caller cares WHICH period a reading
// belongs to (year-over-year, any fixed lookback). FRED writes "." for a missing
// period — dropping it silently SHIFTS every later index, so `vals[12]` stops
// meaning "12 periods ago" and the arithmetic is quietly wrong rather than
// merely absent. Keeping the date lets the caller align on the period it
// actually wants.
export async function fredSeriesDated(seriesId: string, limit = 13): Promise<FredObservation[]> {
  const key = process.env.FRED_API_KEY ?? "";
  if (!key) return [];
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const json = await providerCachedFetch("fred", `FRED:${seriesId}:${limit}`, url, {
      timeoutMs: 8000,
      isThrottled: (j) => !j?.observations,
    });
    const obs: any[] = json?.observations ?? [];
    return obs
      .map((o) => ({ date: String(o?.date ?? ""), value: parseFloat(o?.value) }))
      .filter((o) => o.date !== "" && Number.isFinite(o.value));
  } catch { return []; }
}

/**
 * The observation exactly `monthsBack` calendar months before `from`, or null.
 *
 * Month arithmetic, not index arithmetic: a gap in the series must yield "no
 * comparison available" (honest absence), never a silently mis-aligned pair.
 */
export function observationMonthsBefore(
  obs: readonly FredObservation[],
  from: string,
  monthsBack: number,
): FredObservation | null {
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  const target = d.toISOString().slice(0, 7); // YYYY-MM
  return obs.find((o) => o.date.slice(0, 7) === target) ?? null;
}

// Latest `limit` numeric observations for a FRED series, newest-first. FRED marks
// missing values as ".", which we drop.
//
// CAUTION: because missing periods are dropped, the returned array is dense and
// its indices are NOT period offsets. Safe for "the last N readings, order only"
// (trend direction, min/max over a window). If you need "N periods ago", use
// `fredSeriesDated` + `observationMonthsBefore` instead — see the CPI YoY read
// in macro-sentinel, which this footgun silently disabled for weeks.
// Day-cached under the fred provider budget.
export async function fredSeries(seriesId: string, limit = 13): Promise<number[]> {
  return (await fredSeriesDated(seriesId, limit)).map((o) => o.value);
}
