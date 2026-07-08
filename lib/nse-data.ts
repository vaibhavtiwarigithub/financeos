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
      signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(8000),
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
      headers: { "User-Agent": UA }, next: { revalidate: 86400 }, signal: AbortSignal.timeout(10000),
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
  // Classify BUY/SELL explicitly — the old `?? … != null ? …` chain mis-parsed
  // (operator precedence) so any populated tdpTransactionType returned "BUY",
  // hiding every sell/disposal disclosure.
  const classify = (r: any): string => {
    const t = String(r.tdpTransactionType ?? "").toLowerCase();
    if (/acqui|buy|purchase/.test(t)) return "BUY";
    if (/dispos|sell|sale/.test(t)) return "SELL";
    if (r.buyValue != null) return "BUY";
    if (r.sellValue != null) return "SELL";
    return r.tdpTransactionType ? String(r.tdpTransactionType) : "—";
  };
  return (Array.isArray(rows) ? rows : []).slice(0, 50).map((r: any) => ({
    symbol: r.symbol ?? symbol ?? "",
    person: r.acqName ?? r.name ?? "—",
    type: classify(r),
    qty: r.secAcq != null ? Number(r.secAcq) : null,
    value: r.tdpValue != null ? Number(r.tdpValue) : null,
    date: r.date ?? r.acqfromDt ?? null,
  }));
}

// Market-wide India earnings/results calendar from NSE's event-calendar (free
// JSON) — a real full-market feed, unlike the per-symbol Yahoo dates. Filters to
// "Financial Results" events. Fails soft → []. Dates are DD-MMM-YYYY from NSE.
export type EarningsEvent = { symbol: string; company: string; date: string | null; purpose: string };
export async function fetchNseEarnings(): Promise<EarningsEvent[]> {
  const j = await nseApi(`/api/event-calendar?index=equities`);
  const rows = Array.isArray(j) ? j : (j?.data ?? []);
  return (Array.isArray(rows) ? rows : [])
    .filter((r: any) => /result/i.test(String(r.purpose ?? r.subject ?? "")))
    .slice(0, 200)
    .map((r: any) => ({
      symbol: r.symbol ? `${r.symbol}.NS` : "",
      company: r.company ?? r.symbol ?? "—",
      date: r.date ?? null,
      purpose: r.purpose ?? r.subject ?? "Financial Results",
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

// ── India "smart money" (the closest India analog to US Congress/insider feeds).
// India has no politician-trade disclosure; institutional flows are the signal.

// FII/DII net cash-market flows for the latest session (₹ crore). Foreign vs
// domestic institutional net buy/sell — a widely-watched India risk-appetite read.
export type FiiDiiFlow = { category: string; buy: number; sell: number; net: number; date: string | null };
export async function fetchNseFiiDii(): Promise<FiiDiiFlow[]> {
  const j = await nseApi(`/api/fiidiiTradeReact`);
  const rows = Array.isArray(j) ? j : (j?.data ?? []);
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    category: r.category ?? r.clientType ?? "—",
    buy: parseFloat(r.buyValue ?? r.grossPurchase ?? "0") || 0,
    sell: parseFloat(r.sellValue ?? r.grossSales ?? "0") || 0,
    net: parseFloat(r.netValue ?? "0") || (parseFloat(r.buyValue ?? "0") - parseFloat(r.sellValue ?? "0")) || 0,
    date: r.date ?? null,
  }));
}

// Block/bulk deals — large single trades by promoters, MFs, FIIs, banks. The
// India stand-in for "notable insider/institutional buys". Advisory only. NSE's
// endpoints and field names are undocumented and have changed over time, so the
// parser is defensive: it tries several field-name variants, and — critically —
// only reports a buy/sell SIDE when the response actually carries a real
// buy/sell field. It NEVER defaults an unknown side to "sell" (that would
// fabricate bearish smart-money activity). Missing qty/price → 0.
export type BigDeal = { symbol: string; client: string; side: "buy" | "sell" | "unknown"; qty: number; price: number; date: string | null; kind: "block" | "bulk" };
export async function fetchNseBigDeals(): Promise<BigDeal[]> {
  const num = (...cands: any[]) => { for (const c of cands) { const n = parseFloat(c); if (Number.isFinite(n)) return n; } return 0; };
  const map = (rows: any[], kind: "block" | "bulk"): BigDeal[] =>
    (Array.isArray(rows) ? rows : []).map((r: any): BigDeal => {
      const rawSide = String(r.buySell ?? r.dealType ?? r.buyOrSell ?? "");
      const side: BigDeal["side"] = /buy|purchase|bought/i.test(rawSide) ? "buy"
        : /sell|sold|sale/i.test(rawSide) ? "sell"
        : "unknown"; // no real side field → don't guess
      return {
        symbol: r.symbol ? `${r.symbol}.NS` : "",
        client: r.clientName ?? r.name ?? r.client ?? "—",
        side,
        qty: num(r.quantityTraded, r.qty, r.totalTradedVolume, r.quantity),
        price: num(r.tradePrice, r.watp, r.lastPrice, r.price),
        date: r.date ?? r.BD_DT_DATE ?? null,
        kind,
      };
    }).filter((d) => d.symbol);
  // NSE has changed these endpoints; both are fetched fail-soft (a 404/blocked
  // response → null → []). Block deals are the more reliable of the two.
  const [block, bulk] = await Promise.all([
    nseApi(`/api/block-deal`).catch(() => null),
    nseApi(`/api/historical/bulk-deals`).catch(() => null),
  ]);
  const blockRows = (block?.data ?? block) ?? [];
  const bulkRows = (bulk?.data ?? bulk) ?? [];
  return [...map(blockRows, "block"), ...map(bulkRows, "bulk")].slice(0, 100);
}
