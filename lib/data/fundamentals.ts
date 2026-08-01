import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchIndiaOverview as fetchYahooOverview } from "@/lib/india-data";
// NOTE: lib/data/sec-fundamentals.ts is intentionally NOT wired here. A live
// spot-check (2026-07-13) showed its XBRL-derived margin/ROE are unreliable for
// several filers (NVDA/MSFT off by >2×) because SEC concept selection needs the
// `frames` API, not raw companyfacts tag heuristics. It stays as a future task;
// Finnhub + Yahoo are the two validated-correct US fundamentals sources.

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
// Two event-aware cached calls per symbol; normally seven days, one day around reports.
export async function fetchFmpOverview(symbol: string, maxAgeDays = 7): Promise<Overview> {
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
        { timeoutMs: 8000, isThrottled: badShape, maxAgeDays, maxStaleAgeDays: maxAgeDays }),
      providerCachedFetch("fmp", `FMP_KEYMETRICS:${symbol}`,
        `${FMP_STABLE}/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
        { timeoutMs: 8000, isThrottled: badShape, maxAgeDays, maxStaleAgeDays: maxAgeDays }),
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

// Finnhub fundamentals: /stock/metric (P/E, margin, ROE, EPS, revenue growth) +
// /stock/profile2 (sector). Finnhub free is 60/min with no daily cap — and,
// unlike FMP's premium-gated /stable endpoints and FinancialDatasets' metered
// credits, these two endpoints ARE available on the free tier, so this is the
// primary US fundamentals source. Percent-scaled Finnhub fields (margin/ROE/
// growth) are divided by 100 to match AV's fraction convention that
// scoreFundamentals reads (ProfitMargin 0.27 = 27%).
export async function fetchFinnhubOverview(symbol: string, maxAgeDays = 7): Promise<Overview> {
  const key = process.env.FINNHUB_API_KEY ?? "";
  if (!key) return {};
  try {
    const [metricRes, profileRes] = await Promise.all([
      providerCachedFetch("finnhub", `FINNHUB_METRIC:${symbol}`,
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${key}`,
        { timeoutMs: 8000, maxAgeDays, maxStaleAgeDays: maxAgeDays }),
      providerCachedFetch("finnhub", `FINNHUB_PROFILE:${symbol}`,
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`,
        { timeoutMs: 8000, maxAgeDays: 30 }),
    ]);
    const m = (metricRes as any)?.metric ?? {};
    const p = (profileRes as any) ?? {};
    const ov: Overview = { Symbol: symbol };
    const setRaw = (k: string, v: any) => { if (typeof v === "number" && Number.isFinite(v)) ov[k] = String(v); };
    const setFrac = (k: string, v: any) => { if (typeof v === "number" && Number.isFinite(v)) ov[k] = String(v / 100); };
    setRaw("PERatio", m.peTTM ?? m.peBasicExclExtraTTM);
    setRaw("EPS", m.epsTTM ?? m.epsBasicExclExtraItemsTTM);
    setFrac("ProfitMargin", m.netProfitMarginTTM);
    setFrac("ReturnOnEquityTTM", m.roeTTM);
    setFrac("QuarterlyRevenueGrowthYOY", m.revenueGrowthQuarterlyYoy ?? m.revenueGrowthTTMYoy);
    if (typeof m["52WeekHigh"] === "number") ov["52WeekHigh"] = String(m["52WeekHigh"]);
    if (typeof m["52WeekLow"] === "number") ov["52WeekLow"] = String(m["52WeekLow"]);
    if (p.finnhubIndustry) {
      // Profile 2 exposes Finnhub's industry classification, not a GICS sector.
      ov.Sector = String(p.finnhubIndustry);
      ov.SectorTaxonomy = "finnhub_industry";
    }
    return ov;
  } catch { return {}; }
}

// US fundamentals resolver: Finnhub → FMP → (caller's AV OVERVIEW fallback).
// Returns the AV-OVERVIEW-shaped object scoreFundamentals expects, plus which
// source served it. `avFallback` keeps AV as last resort without this module
// importing it. Requires >=2 real fields (matches hasMinFundamentalFields)
// before trusting a source, so a thin/empty provider result cascades to the next.
// US fundamentals chain: Finnhub → Yahoo → FMP → AV (reserve). Finnhub and Yahoo
// are both live-validated as CORRECT (2026-07-13); each source only wins with >=2
// real fields so a dead/thin source cascades and no single provider is a point of
// failure. (SEC EDGAR deliberately excluded — see import note; its raw-companyfacts
// derivation is not yet reliable enough for the money path.)
export async function fetchUsOverview(
  symbol: string,
  avFallback: () => Promise<Overview>,
  opts: { isAdr?: boolean; maxAgeDays?: number } = {},
): Promise<{ overview: Overview; source: string }> {
  const realFields = (ov: Overview) => Object.keys(ov).filter(k => k !== "Symbol").length;
  const maxAgeDays = opts.maxAgeDays ?? 7;

  // Reviewed ADRs use only an ADS-compatible source. A provider resolving the
  // ticker to its foreign ordinary share can return plausible but unit-incompatible
  // EPS/P-E values; unavailable is safer than cross-basis fallback.
  if (opts.isAdr) {
    const yahooAdr = await fetchYahooOverview(symbol, { maxAgeDays }).catch(() => ({} as Overview));
    return realFields(yahooAdr) >= 2
      ? { overview: yahooAdr, source: "yahoo" }
      : { overview: {}, source: "unavailable" };
  }

  const finnhub = await fetchFinnhubOverview(symbol, maxAgeDays).catch(() => ({} as Overview));
  if (realFields(finnhub) >= 2) return { overview: finnhub, source: "finnhub" };

  const yahoo = await fetchYahooOverview(symbol, { maxAgeDays }).catch(() => ({} as Overview));
  if (realFields(yahoo) >= 2) return { overview: yahoo, source: "yahoo" };

  const fmp = await fetchFmpOverview(symbol, maxAgeDays);
  if (realFields(fmp) >= 2) return { overview: fmp, source: "fmp" };

  const av = await avFallback().catch(() => ({} as Overview));
  return { overview: av, source: av.Symbol ? "alpha_vantage" : "unavailable" };
}
