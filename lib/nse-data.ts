// Direct NSE India feeds (free, undocumented JSON) — lifts the two India ceilings
// Yahoo can't: full-market universe, insider disclosures, and option-chain flow.
//
// NSE's API is behind an anti-bot cookie gate: hit the homepage first to mint
// session cookies, then send them (plus a browser UA + Referer) on each API call.
// NSE also geo-throttles some non-India IPs, so EVERY function here fails soft —
// returns [] / null on block — and the callers fall back to the Yahoo/NIFTY-100
// path with an honest "NSE unavailable" note. Never throws.

let _nse: { cookie: string; at: number } | null = null;
const NSE_TTL_MS = 10 * 60 * 1000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

async function nseCookie(): Promise<string | null> {
  if (_nse && Date.now() - _nse.at < NSE_TTL_MS) return _nse.cookie;
  try {
    const res = await fetch("https://www.nseindia.com/", {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    });
    // Collect all set-cookie name=value pairs.
    const raw = res.headers.get("set-cookie") ?? "";
    const cookie = raw.split(/,(?=[^;]+?=)/).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    if (!cookie) return null;
    _nse = { cookie, at: Date.now() };
    return cookie;
  } catch { return null; }
}

async function nseApi(path: string): Promise<any | null> {
  const cookie = await nseCookie();
  if (!cookie) return null;
  try {
    const res = await fetch(`https://www.nseindia.com${path}`, {
      headers: {
        "User-Agent": UA, "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nseindia.com/",
        Cookie: cookie,
      },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Full NSE equity list from the archives host (less protected than the API).
// ~2000 symbols → the real full-market scanner universe. Returns `.NS` tickers.
let _eqList: { list: string[]; at: number } | null = null;
export async function fetchNseEquityList(): Promise<string[]> {
  if (_eqList && Date.now() - _eqList.at < 24 * 3600 * 1000) return _eqList.list;
  try {
    const res = await fetch("https://archives.nseindia.com/content/equities/EQUITY_L.csv", {
      headers: { "User-Agent": UA }, next: { revalidate: 86400 },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.split(/\r?\n/).slice(1); // drop header
    const list: string[] = [];
    for (const ln of lines) {
      const sym = ln.split(",")[0]?.trim();
      // EQ series only (skip ETFs/bonds/etc via col 1 = " EQ")
      const series = ln.split(",")[1]?.trim();
      if (sym && (series === "EQ" || series === "BE")) list.push(`${sym}.NS`);
    }
    if (list.length) _eqList = { list, at: Date.now() };
    return list;
  } catch { return []; }
}

// SEBI-mandated insider (PIT) disclosures. `symbol` optional (bare, no .NS) → one
// company; omit for the market-wide recent feed. Normalized to a small shape.
export type InsiderTrade = { symbol: string; person: string; type: string; qty: number | null; value: number | null; date: string | null };
export async function fetchNseInsider(symbol?: string): Promise<InsiderTrade[]> {
  const q = symbol ? `?index=equities&symbol=${encodeURIComponent(symbol.replace(/\.(NS|BO)$/i, ""))}` : `?index=equities`;
  const j = await nseApi(`/api/corporates-pit${q}`);
  const rows = j?.data ?? [];
  return (Array.isArray(rows) ? rows : []).slice(0, 50).map((r: any) => ({
    symbol: r.symbol ?? symbol ?? "",
    person: r.acqName ?? r.name ?? "—",
    type: r.tdpTransactionType ?? r.buyValue != null ? "BUY" : r.sellValue != null ? "SELL" : (r.tdpTransactionType ?? "—"),
    qty: r.secAcq != null ? Number(r.secAcq) : null,
    value: r.tdpValue != null ? Number(r.tdpValue) : null,
    date: r.date ?? r.acqfromDt ?? null,
  }));
}

// Option chain for a symbol (index like NIFTY/BANKNIFTY, or an equity). Returns
// put/call OI, PCR, and the top OI strikes = the free stand-in for "options flow".
export type OptionFlow = { symbol: string; underlying: number | null; pcr: number | null; totalCallOI: number; totalPutOI: number; topStrikes: { strike: number; callOI: number; putOI: number }[] };
export async function fetchNseOptionChain(symbol = "NIFTY"): Promise<OptionFlow | null> {
  const sym = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(sym);
  const j = await nseApi(`/api/option-chain-${isIndex ? "indices" : "equities"}?symbol=${encodeURIComponent(sym)}`);
  const data = j?.records?.data;
  if (!Array.isArray(data)) return null;
  let totalCallOI = 0, totalPutOI = 0;
  const strikes: { strike: number; callOI: number; putOI: number }[] = [];
  for (const row of data) {
    const callOI = row.CE?.openInterest ?? 0, putOI = row.PE?.openInterest ?? 0;
    totalCallOI += callOI; totalPutOI += putOI;
    if (callOI || putOI) strikes.push({ strike: row.strikePrice, callOI, putOI });
  }
  strikes.sort((a, b) => (b.callOI + b.putOI) - (a.callOI + a.putOI));
  return {
    symbol: sym,
    underlying: j?.records?.underlyingValue ?? null,
    pcr: totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : null,
    totalCallOI, totalPutOI,
    topStrikes: strikes.slice(0, 8),
  };
}
