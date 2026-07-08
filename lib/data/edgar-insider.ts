// SEC EDGAR Form 4 insider adapter — free, official, unlimited (10 req/s fair-use).
// Extracted from app/api/markets/edgar-insiders/route.ts so ResearchAgent's
// insider dimension can use SEC as PRIMARY instead of spending an Alpha Vantage
// 25/day slot on INSIDER_TRANSACTIONS. Same 90-day buy/sell-value scoring shape
// as research-agent.ts:scoreInsider ({ score, summary, available }).

const SEC_UA = "Kairos vterminater@gmail.com";
const LOOKBACK_DAYS = 90;
const MAX_FILINGS_PER_SYMBOL = 8;
const MIN_INSIDER_TRANSACTIONS = 3; // same sample-size gate as scoreInsider

let tickerCikCache: Map<string, string> | null = null;
let tickerCikFetchedAt = 0;

async function getTickerCikMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (tickerCikCache && now - tickerCikFetchedAt < 24 * 3600_000) return tickerCikCache;
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA },
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`CIK map fetch failed: ${res.status}`);
  const json = await res.json();
  const map = new Map<string, string>();
  for (const entry of Object.values(json) as any[]) {
    if (entry.ticker) map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }
  tickerCikCache = map;
  tickerCikFetchedAt = now;
  return map;
}

interface Tx { type: "buy" | "sell" | "other"; value: number }

function parseForm4Xml(xml: string): Tx[] {
  const out: Tx[] = [];
  const blocks = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)];
  for (const m of blocks) {
    const block = m[1];
    const shares = parseFloat(block.match(/<transactionShares>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    const price = parseFloat(block.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    const adCode = block.match(/<transactionAcquiredDisposedCode>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "";
    if (shares <= 0) continue;
    out.push({ type: adCode === "A" ? "buy" : adCode === "D" ? "sell" : "other", value: shares * price });
  }
  return out;
}

async function fetchForm4sForSymbol(cikPadded: string): Promise<Tx[]> {
  const cikNum = parseInt(cikPadded, 10);
  const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, {
    headers: { "User-Agent": SEC_UA }, next: { revalidate: 3600 },
  });
  if (!subRes.ok) return [];
  const sub = await subRes.json();
  const recent = sub.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const accNos: string[] = recent.accessionNumber ?? [];
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);

  const indices = forms
    .map((f: string, i: number) => ({ f, i }))
    .filter(({ f, i }) => f === "4" && dates[i] >= cutoff)
    .slice(0, MAX_FILINGS_PER_SYMBOL)
    .map(({ i }) => i);

  const txns: Tx[] = [];
  for (const idx of indices) {
    const accDash = accNos[idx];
    const accFlat = accDash.replace(/-/g, "");
    try {
      const xmlRes = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${accFlat}/${accDash}.xml`, { headers: { "User-Agent": SEC_UA } });
      if (!xmlRes.ok) continue;
      txns.push(...parseForm4Xml(await xmlRes.text()));
    } catch { continue; }
    await new Promise((r) => setTimeout(r, 120)); // SEC ~10 req/s fair use
  }
  return txns;
}

// Score a symbol's insider activity from SEC Form 4s. Returns the same shape as
// research-agent.ts:scoreInsider. `available:false` when the symbol isn't in the
// CIK map (non-US), the fetch fails, or fewer than MIN_INSIDER_TRANSACTIONS —
// so the caller excludes it from weighting rather than scoring a fake neutral.
export async function scoreEdgarInsider(symbol: string): Promise<{ score: number; summary: string; available: boolean }> {
  try {
    const cikMap = await getTickerCikMap();
    const cik = cikMap.get(symbol.toUpperCase());
    if (!cik) return { score: 50, summary: "No SEC CIK for symbol (non-US or not found).", available: false };

    const txns = await fetchForm4sForSymbol(cik);
    let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
    for (const t of txns) {
      if (t.type === "buy") { buyValue += t.value; buyCount++; }
      else if (t.type === "sell") { sellValue += t.value; sellCount++; }
    }
    const total = buyValue + sellValue;
    if (buyCount + sellCount < MIN_INSIDER_TRANSACTIONS || total === 0) {
      return { score: 50, summary: `Only ${buyCount + sellCount} SEC Form 4 transaction(s) in past 90 days — too few to score.`, available: false };
    }
    const buyRatio = buyValue / total;
    const score = Math.round(10 + buyRatio * 80); // 100% buying = 90, balanced = 50
    const fmt = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}`;
    return {
      score,
      summary: `SEC Form 4: ${buyCount} buys (${fmt(buyValue)}) vs ${sellCount} sells (${fmt(sellValue)}) in 90d. Buy ratio ${(buyRatio * 100).toFixed(0)}%.`,
      available: true,
    };
  } catch {
    return { score: 50, summary: "SEC EDGAR insider fetch failed.", available: false };
  }
}
