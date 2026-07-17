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

// ---------------------------------------------------------------------------
// Form 4 primary-document URL resolution
//
// BUG (fixed 2026-07-16): both this file and app/api/markets/edgar-insiders
// built `<accession>.xml` (e.g. .../0001403161-26-000090.xml). That artifact
// does not exist in an EDGAR accession directory — it 404s for EVERY filing, so
// US insider data has never once been read. Verified live against V, AAPL,
// TSLA, COST, MA, PG.
//
// The real document is named by `filings.recent.primaryDocument` in the
// submissions JSON. Two traps:
//
//  1. For Form 4 the primaryDocument ALWAYS points at the XSL *rendering*
//     ("xslF345X06/form4.xml"). SEC serves that path as text/html — it returns
//     200 but contains NONE of the machine tags (<rptOwnerName>,
//     <nonDerivativeTransaction>). Parsing it yields zero transactions: a
//     silent, plausible-looking empty result rather than an error. The
//     machine-readable XML lives at the same accession directory with the
//     xsl prefix REMOVED.
//  2. The filename is NOT always "form4.xml" — filer agents vary it
//     (TSLA: "tm2618092-2_4seq1.xml", MA: "wk-form4_1784149645.xml"). So the
//     prefix must be stripped from primaryDocument, never hardcoded.
//
// The CIK in the path must be unpadded — the zero-padded form 301-redirects.
// ---------------------------------------------------------------------------
export function stripXslRenderPrefix(primaryDocument: string): string {
  return primaryDocument.replace(/^xslF345X\d+\//i, "");
}

export function buildForm4XmlUrl(
  cikPadded: string,
  accessionNumber: string,
  primaryDocument: string | null | undefined,
): string | null {
  const doc = stripXslRenderPrefix(String(primaryDocument ?? "").trim());
  // A Form 4 with no XML primary document (paper/legacy filing) is not
  // machine-readable. Return null so the caller SKIPS it rather than counting
  // it as a fetch failure — those are different facts.
  if (!doc || !doc.toLowerCase().endsWith(".xml")) return null;
  const cikNum = parseInt(cikPadded, 10);
  if (!Number.isFinite(cikNum)) return null;
  const accFlat = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accFlat}/${doc}`;
}

// A fetch outcome, not just rows. `attempted`/`failed` let callers tell
// "this issuer had no open-market trades" from "we could not read the filings".
export interface Form4FetchResult {
  txns: Tx[];
  attempted: number;
  failed: number;
}

function parseForm4Xml(xml: string): Tx[] {
  const out: Tx[] = [];
  const blocks = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)];
  for (const m of blocks) {
    const block = m[1];
    const shares = parseFloat(block.match(/<transactionShares>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    const price = parseFloat(block.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    // Classify by Form 4 transactionCode, NOT the acquired/disposed code. A/D
    // marks shares acquired vs disposed for ANY reason — an award (A), option
    // exercise (M), gift (G), or tax-withholding (F) all "acquire" or "dispose"
    // shares but are NOT open-market conviction trades. Only P (open-market
    // purchase) is a real insider buy and S (open-market sale) a real sell;
    // everything else is `other` and excluded from the buy/sell ratio.
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i)?.[1]?.trim().toUpperCase() ?? "";
    if (shares <= 0) continue;
    const type: Tx["type"] = code === "P" ? "buy" : code === "S" ? "sell" : "other";
    out.push({ type, value: shares * price });
  }
  return out;
}

async function fetchForm4sForSymbol(cikPadded: string): Promise<Form4FetchResult> {
  const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, {
    headers: { "User-Agent": SEC_UA }, next: { revalidate: 3600 },
  });
  // The submissions index itself failing is a read failure, not "no filings".
  // Report it as one attempt that failed so the caller cannot read it as data.
  if (!subRes.ok) return { txns: [], attempted: 1, failed: 1 };
  const sub = await subRes.json();
  const recent = sub.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const accNos: string[] = recent.accessionNumber ?? [];
  const primaryDocs: string[] = recent.primaryDocument ?? [];
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);

  const indices = forms
    .map((f: string, i: number) => ({ f, i }))
    .filter(({ f, i }) => f === "4" && dates[i] >= cutoff)
    .slice(0, MAX_FILINGS_PER_SYMBOL)
    .map(({ i }) => i);

  const txns: Tx[] = [];
  let attempted = 0;
  let failed = 0;
  for (const idx of indices) {
    const xmlUrl = buildForm4XmlUrl(cikPadded, accNos[idx], primaryDocs[idx]);
    if (!xmlUrl) continue; // no XML primary doc — skipped, not failed
    attempted++;
    try {
      const xmlRes = await fetch(xmlUrl, { headers: { "User-Agent": SEC_UA } });
      if (!xmlRes.ok) { failed++; continue; }
      txns.push(...parseForm4Xml(await xmlRes.text()));
    } catch { failed++; continue; }
    await new Promise((r) => setTimeout(r, 120)); // SEC ~10 req/s fair use
  }
  return { txns, attempted, failed };
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

    const { txns, attempted, failed } = await fetchForm4sForSymbol(cik);

    // A failed read is NOT evidence of balanced insider activity. Before the URL
    // fix every filing 404'd and this path still reported "too few transactions
    // to score" — indistinguishable from a genuinely quiet issuer. Name the
    // failure explicitly so a broken fetch can never again read as a finding.
    if (attempted > 0 && failed === attempted) {
      return {
        score: 50,
        summary: `SEC Form 4 fetch failed for all ${attempted} filing(s) in the past ${LOOKBACK_DAYS} days — insider data unavailable, not neutral.`,
        available: false,
      };
    }

    let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
    for (const t of txns) {
      if (t.type === "buy") { buyValue += t.value; buyCount++; }
      else if (t.type === "sell") { sellValue += t.value; sellCount++; }
    }
    const total = buyValue + sellValue;
    if (buyCount + sellCount < MIN_INSIDER_TRANSACTIONS || total === 0) {
      // Partial failure caveat: some filings were unreadable, so the observed
      // count is a floor, not the truth. Say so rather than implying we looked
      // at everything and found little.
      const caveat = failed > 0 ? ` (${failed} of ${attempted} filings could not be read, so this count is a floor)` : "";
      return {
        score: 50,
        summary: `Only ${buyCount + sellCount} open-market SEC Form 4 transaction(s) in past ${LOOKBACK_DAYS} days — too few to score${caveat}.`,
        available: false,
      };
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
