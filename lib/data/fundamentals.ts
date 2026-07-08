import { providerCachedFetch } from "@/lib/data/provider-fetch";

// US fundamentals adapter. Maps FMP's TTM ratio/metric fields into the same
// Alpha-Vantage-OVERVIEW shape that lib/data/scores.ts:scoreFundamentals already
// reads (PERatio, ProfitMargin, ReturnOnEquityTTM, EPS, Sector) so the scoring
// code is unchanged. FMP free is 250/day (own budget) vs AV's shared 25/day, so
// fundamentals stop competing with everything else for AV's tiny quota.
//
// Field scale matches AV: ProfitMargin/ROE are fractions (0.27 = 27%), PERatio
// and EPS are raw. Verified live against AAPL.

type Overview = Record<string, string>;

const FMP_STABLE = "https://financialmodelingprep.com/stable";

// FMP fundamentals: ratios-ttm (P/E, margin, EPS) + key-metrics-ttm (ROE).
// Two day-cached calls per symbol → ~2×universe/day, far under the 240 budget.
export async function fetchFmpOverview(symbol: string): Promise<Overview> {
  const key = process.env.FMP_API_KEY ?? "";
  if (!key) return {};
  const badShape = (j: any): boolean => {
    if (j && typeof j === "object" && !Array.isArray(j) && "Error Message" in j) return true; // FMP error object
    return !Array.isArray(j) || j.length === 0;
  };
  try {
    const [ratios, metrics] = await Promise.all([
      providerCachedFetch("fmp", `FMP_RATIOS:${symbol}`,
        `${FMP_STABLE}/ratios-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
        { timeoutMs: 8000, isThrottled: badShape }),
      providerCachedFetch("fmp", `FMP_KEYMETRICS:${symbol}`,
        `${FMP_STABLE}/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
        { timeoutMs: 8000, isThrottled: badShape }),
    ]);
    const r = Array.isArray(ratios) ? ratios[0] : null;
    const m = Array.isArray(metrics) ? metrics[0] : null;
    if (!r && !m) return {};

    const ov: Overview = { Symbol: symbol };
    const set = (k: string, v: any) => { if (typeof v === "number" && Number.isFinite(v)) ov[k] = String(v); };
    set("PERatio", r?.priceToEarningsRatioTTM);
    set("ProfitMargin", r?.netProfitMarginTTM);
    set("EPS", r?.netIncomePerShareTTM);
    set("ReturnOnEquityTTM", m?.returnOnEquityTTM);
    return ov;
  } catch { return {}; }
}

// US fundamentals resolver: FMP → (caller's AV OVERVIEW fallback). Returns the
// AV-OVERVIEW-shaped object scoreFundamentals expects, plus which source served
// it. `avFallback` keeps AV as last resort without this module importing it.
export async function fetchUsOverview(
  symbol: string,
  avFallback: () => Promise<Overview>,
): Promise<{ overview: Overview; source: string }> {
  const fmp = await fetchFmpOverview(symbol);
  // Require >=2 real fields (matches hasMinFundamentalFields) before trusting FMP.
  const realFields = Object.keys(fmp).filter(k => k !== "Symbol").length;
  if (realFields >= 2) return { overview: fmp, source: "fmp" };
  const av = await avFallback().catch(() => ({} as Overview));
  return { overview: av, source: av.Symbol ? "alpha_vantage" : "unavailable" };
}
