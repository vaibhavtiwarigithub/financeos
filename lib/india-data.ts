// India market data via Yahoo Finance (free, no API key) for NSE `.NS` tickers.
// Kite Personal tier gives execution + portfolio only — NO market quotes or
// historical — so all India price/fundamentals come from Yahoo here.
//
// Yahoo's fundamentals endpoints (v7 quote, v10 quoteSummary) require a
// cookie+crumb handshake; the chart endpoint (price + candles) does not.

import type { Candle } from "@/lib/data/technicals";

let _crumb: { cookie: string; crumb: string; at: number } | null = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function getCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  if (_crumb && Date.now() - _crumb.at < CRUMB_TTL_MS) return _crumb;
  try {
    // Grab a session cookie, then a crumb tied to it.
    const cookieRes = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const setCookie = cookieRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] || "";
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    _crumb = { cookie, crumb, at: Date.now() };
    return _crumb;
  } catch {
    return null;
  }
}

const isIndia = (s: string) => s.toUpperCase().endsWith(".NS") || s.toUpperCase().endsWith(".BO");
export { isIndia };

// Price + OHLC candles from the auth-free chart endpoint.
export async function fetchIndiaCandles(symbol: string, range = "6mo"): Promise<Candle[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      out.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: q.open?.[i] ?? q.close[i], high: q.high?.[i] ?? q.close[i],
        low: q.low?.[i] ?? q.close[i], close: q.close[i], volume: q.volume?.[i] ?? 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchIndiaQuote(symbol: string): Promise<{ price: number; changePct: number } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 900 } }
    );
    if (!res.ok) return null;
    const m = (await res.json())?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return null;
    const prev = m.chartPreviousClose ?? m.previousClose ?? m.regularMarketPrice;
    return { price: m.regularMarketPrice, changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : 0 };
  } catch {
    return null;
  }
}

// Map Yahoo fundamentals into the same shape the existing scorer expects from
// Alpha Vantage's OVERVIEW (PERatio, ProfitMargin, ReturnOnEquityTTM, EPS,
// QuarterlyRevenueGrowthYOY, 52WeekHigh, Sector, Symbol) so India stocks run
// through the exact same computeScores path as US stocks. Missing fields are
// left blank so the scorer falls back to its neutral baseline honestly.
export async function fetchIndiaOverview(symbol: string): Promise<Record<string, string>> {
  const c = await getCrumb();
  if (!c) return {};
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile,price&crumb=${encodeURIComponent(c.crumb)}`,
      { headers: { "User-Agent": "Mozilla/5.0", Cookie: c.cookie }, next: { revalidate: 86400 } }
    );
    if (!res.ok) return {};
    const r = (await res.json())?.quoteSummary?.result?.[0];
    if (!r) return {};
    const sd = r.summaryDetail ?? {}, fd = r.financialData ?? {}, ks = r.defaultKeyStatistics ?? {}, ap = r.assetProfile ?? {}, pr = r.price ?? {};
    const num = (v: any) => (v && typeof v === "object" && "raw" in v ? v.raw : v);
    const ov: Record<string, string> = {};
    ov.Symbol = symbol;
    if (ap.sector) ov.Sector = String(ap.sector);
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
    return ov;
  } catch {
    return {};
  }
}
