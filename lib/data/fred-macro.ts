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

// Latest `limit` numeric observations for a FRED series, newest-first. FRED marks
// missing values as ".", which we drop. Day-cached under the fred provider budget.
export async function fredSeries(seriesId: string, limit = 13): Promise<number[]> {
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
      .map((o) => parseFloat(o.value))
      .filter((v) => Number.isFinite(v));
  } catch { return []; }
}
