// India market data via Yahoo Finance (free, no API key) for NSE `.NS` tickers.
// Kite Personal tier gives execution + portfolio only — NO market quotes or
// historical — so all India price/fundamentals come from Yahoo here.
//
// Yahoo's fundamentals endpoints (v7 quote, v10 quoteSummary) require a
// cookie+crumb handshake; the chart endpoint (price + candles) does not.

import type { Candle } from "@/lib/data/technicals";
import { normalizeRealIsoDate } from "@/lib/date-only";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { getCrumb } from "@/lib/data/yahoo-crumb";
// Candle fetching moved to lib/data/yahoo-candles.ts — it was never India-specific.
// Re-exported here so existing India call sites keep one import, but new code
// (especially US) should import fetchYahooCandles directly.
export { fetchYahooCandles } from "@/lib/data/yahoo-candles";

const isIndia = (s: string) => s.toUpperCase().endsWith(".NS") || s.toUpperCase().endsWith(".BO");
export { isIndia };

export interface IndiaQuote {
  price: number;
  changePct: number;
  retrievedAt: string;
  stale: boolean;
}

function isMarketHours(market: "us" | "india"): boolean {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
  }));
  const day = local.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = local.getHours() * 60 + local.getMinutes();
  return market === "india"
    ? minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30
    : minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function isYahooQuoteStale(retrievedAt: string, market: "us" | "india"): boolean {
  const age = Date.now() - new Date(retrievedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return true;
  if (isMarketHours(market)) return age > 30 * 60_000;
  // India callers use Yahoo as their primary read source and need the latest
  // close across weekends. US PositionMonitor uses it only as an independent
  // same-session fallback, so do not accept a multi-day close there.
  return age > (market === "india" ? 4 * 86_400_000 : 36 * 60 * 60_000);
}

export async function fetchYahooQuote(
  symbol: string,
  market: "us" | "india",
): Promise<IndiaQuote | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const m = (await res.json())?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice || !m?.regularMarketTime) return null;
    const prev = m.chartPreviousClose ?? m.previousClose ?? m.regularMarketPrice;
    const retrievedAt = new Date(Number(m.regularMarketTime) * 1000).toISOString();
    return {
      price: m.regularMarketPrice,
      changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : 0,
      retrievedAt,
      stale: isYahooQuoteStale(retrievedAt, market),
    };
  } catch {
    return null;
  }
}

export async function fetchIndiaQuote(symbol: string): Promise<IndiaQuote | null> {
  return fetchYahooQuote(symbol, "india");
}

// Bounded quote fan-out for portfolio paths. Yahoo is unofficial and can
// throttle datacenter bursts; every requested symbol remains explicit in the
// output so a missing quote is an unevaluated state, never an implicit hold.
export async function fetchIndiaQuotes(
  symbols: string[],
  batchSize = 4,
  pauseMs = 250,
): Promise<Record<string, IndiaQuote | null>> {
  return fetchYahooQuotes(symbols, "india", batchSize, pauseMs);
}

export async function fetchYahooQuotes(
  symbols: string[],
  market: "us" | "india",
  batchSize = 4,
  pauseMs = 250,
): Promise<Record<string, IndiaQuote | null>> {
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))];
  const out: Record<string, IndiaQuote | null> = {};
  const size = Math.max(1, Math.min(8, Math.floor(batchSize)));
  for (let i = 0; i < unique.length; i += size) {
    const batch = unique.slice(i, i + size);
    await Promise.all(batch.map(async symbol => {
      out[symbol] = await fetchYahooQuote(symbol, market).catch(() => null);
    }));
    if (i + size < unique.length && pauseMs > 0) {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
  }
  return out;
}

// India market indices (Yahoo symbols). Consumed by the Markets panel so India
// gets the same index/VIX row US gets. Chart endpoint = no auth needed.
export const INDIA_INDICES: { symbol: string; label: string; kind: "index" | "vix" }[] = [
  { symbol: "^NSEI",      label: "NIFTY 50",   kind: "index" },
  { symbol: "^BSESN",     label: "SENSEX",     kind: "index" },
  { symbol: "^NSEBANK",   label: "BANK NIFTY", kind: "index" },
  { symbol: "^INDIAVIX",  label: "India VIX",  kind: "vix"   },
];

// Batch index quotes for the Markets page. Reuses the auth-free chart endpoint
// (fetchIndiaQuote works for any Yahoo symbol, indices included).
export async function fetchIndiaIndices(): Promise<{ symbol: string; label: string; kind: string; price: number; changePct: number }[]> {
  const out = await Promise.all(
    INDIA_INDICES.map(async (idx) => {
      const q = await fetchIndiaQuote(idx.symbol);
      return q ? { ...idx, price: q.price, changePct: q.changePct } : null;
    })
  );
  return out.filter(Boolean) as any[];
}

// NSE sectoral indices (Yahoo symbols) — the India equivalent of the US sector
// row/heatmap on the Markets panel. All resolve on the auth-free chart endpoint.
export const INDIA_SECTORS: { symbol: string; label: string }[] = [
  { symbol: "^CNXIT",      label: "IT" },
  { symbol: "^NSEBANK",    label: "Bank" },
  { symbol: "^CNXAUTO",    label: "Auto" },
  { symbol: "^CNXFMCG",    label: "FMCG" },
  { symbol: "^CNXPHARMA",  label: "Pharma" },
  { symbol: "^CNXMETAL",   label: "Metal" },
  { symbol: "^CNXENERGY",  label: "Energy" },
  { symbol: "^CNXREALTY",  label: "Realty" },
  { symbol: "^CNXFIN",     label: "Financials" },
  { symbol: "^CNXINFRA",   label: "Infra" },
];

// Batch sector-index quotes for the Markets panel's India sector heatmap.
export async function fetchIndiaSectors(): Promise<{ symbol: string; label: string; price: number; changePct: number }[]> {
  const out = await Promise.all(
    INDIA_SECTORS.map(async (s) => {
      const q = await fetchIndiaQuote(s.symbol);
      return q ? { ...s, price: q.price, changePct: q.changePct } : null;
    })
  );
  return out.filter(Boolean) as any[];
}

// Next earnings date for an NSE symbol via Yahoo calendarEvents. There is no free
// full-market India earnings CALENDAR feed, so this is per-symbol (used to enrich
// the watchlist/tracked names on the Earnings panel). Returns YYYY-MM-DD or null.
export async function fetchIndiaEarningsDate(symbol: string): Promise<string | null> {
  const c = await getCrumb();
  if (!c) return null;
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(c.crumb)}`,
      { headers: { "User-Agent": "Mozilla/5.0", Cookie: c.cookie }, next: { revalidate: 86400 }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const ev = (await res.json())?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    const raw = ev?.earningsDate?.[0]?.raw ?? ev?.earningsDate?.[0];
    // Shared parser (lib/date-only) — Yahoo sends epoch seconds here, but a
    // malformed or out-of-range value must fail closed to null, never become a
    // valid-looking date that the earnings risk path would treat as confirmed.
    return normalizeRealIsoDate(raw);
  } catch {
    return null;
  }
}

// Map Yahoo fundamentals into the same shape the existing scorer expects from
// Alpha Vantage's OVERVIEW (PERatio, ProfitMargin, ReturnOnEquityTTM, EPS,
// QuarterlyRevenueGrowthYOY, 52WeekHigh, Sector, Symbol) so India stocks run
// through the exact same computeScores path as US stocks. Missing fields are
// left blank so the scorer falls back to its neutral baseline honestly.
export async function fetchIndiaOverview(
  symbol: string,
  opts: { maxAgeDays?: number } = {},
): Promise<Record<string, string>> {
  const c = await getCrumb();
  if (!c) return {};
  try {
    const json = await providerCachedFetch(
      "yahoo",
      `YAHOO_OVERVIEW:${symbol.toUpperCase()}`,
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile,price&crumb=${encodeURIComponent(c.crumb)}`,
      {
        headers: { "User-Agent": "Mozilla/5.0", Cookie: c.cookie },
        timeoutMs: 8000,
        maxAgeDays: opts.maxAgeDays ?? 1,
        maxStaleAgeDays: opts.maxAgeDays ?? 1,
      },
    );
    const r = json?.quoteSummary?.result?.[0];
    if (!r) return {};
    const sd = r.summaryDetail ?? {}, fd = r.financialData ?? {}, ks = r.defaultKeyStatistics ?? {}, ap = r.assetProfile ?? {}, pr = r.price ?? {};
    const num = (v: any) => (v && typeof v === "object" && "raw" in v ? v.raw : v);
    const ov: Record<string, string> = {};
    ov.Symbol = symbol;
    if (ap.sector) {
      ov.Sector = String(ap.sector);
      ov.SectorTaxonomy = "yahoo_sector";
    }
    if (ap.industry) ov.Industry = String(ap.industry);
    const pe = num(sd.trailingPE) ?? num(ks.trailingPE);
    if (pe != null) ov.PERatio = String(pe);
    const margin = num(fd.profitMargins);
    if (margin != null) ov.ProfitMargin = String(margin);
    const roe = num(fd.returnOnEquity);
    if (roe != null) ov.ReturnOnEquityTTM = String(roe);
    const eps = num(ks.trailingEps) ?? num(pr.epsTrailingTwelveMonths);
    if (eps != null) ov.EPS = String(eps);
    const revG = num(fd.revenueGrowth);
    if (revG != null) ov.QuarterlyRevenueGrowthYOY = String(revG);
    const hi = num(sd.fiftyTwoWeekHigh);
    if (hi != null) ov["52WeekHigh"] = String(hi);
    const target = num(fd.targetMeanPrice);
    if (target != null) ov.AnalystTargetPrice = String(target);
    const grossM = num(fd.grossMargins);
    if (grossM != null) ov.GrossMarginTTM = String(grossM);
    const de = num(fd.debtToEquity);
    if (de != null) ov.DebtToEquity = String(de);
    const peg = num(ks.pegRatio);
    if (peg != null) ov.PEGRatio = String(peg);
    const fcf = num(fd.freeCashflow);
    const mcapForYield = num(pr.marketCap) ?? num(sd.marketCap);
    if (fcf != null && mcapForYield != null && mcapForYield > 0) {
      ov.FCFYield = String(fcf / mcapForYield);
    }
    // Additive display-only fields consumed by the Stock Context feature
    // (features/stock-context). The scorer reads specific keys and ignores
    // these, so adding them is harmless for the money path. Name/exchange/
    // market-cap are not used by scoring — only by symbol_profiles.
    const name = pr.longName ?? pr.shortName ?? null;
    if (name) ov.Name = String(name);
    if (pr.exchangeName) ov.Exchange = String(pr.exchangeName);
    const mcap = num(pr.marketCap) ?? num(sd.marketCap);
    if (mcap != null) ov.MarketCapitalization = String(mcap);
    return ov;
  } catch {
    return {};
  }
}
