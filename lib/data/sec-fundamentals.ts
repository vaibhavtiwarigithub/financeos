import { providerCachedFetch } from "@/lib/data/provider-fetch";

// US fundamentals from SEC EDGAR XBRL company-facts — official, free, no key.
// Maps the latest ANNUAL (10-K / FY) reported figures into the same
// Alpha-Vantage-OVERVIEW shape scoreFundamentals reads. Used as a fundamentals
// SOURCE (after Finnhub + Yahoo) so US fundamentals have real redundancy.
//
// Metric equivalence (Codex correction): company-facts mixes annual, quarterly,
// and YTD observations, so we CANNOT take "the latest value". We select the most
// recent two ANNUAL (form 10-K, fp FY) observations per concept and derive on a
// consistent basis:
//   ProfitMargin = NetIncome_FY / Revenue_FY   (same fiscal year)
//   ReturnOnEquityTTM = NetIncome_FY / avg(Equity_FY, Equity_prevFY)
//   QuarterlyRevenueGrowthYOY = (Rev_FY - Rev_prevFY) / Rev_prevFY   (FY vs prior FY)
//   EPS = EarningsPerShareDiluted_FY
// Coverage is per-field: whatever can't be derived on a consistent basis is
// simply omitted (the fundamental score renormalizes over the fields present),
// never faked. P/E is intentionally NOT computed here (needs a live price) — it
// comes from Finnhub/Yahoo. US-GAAP first, then IFRS taxonomy.

const SEC_UA = { "User-Agent": "Kairos Research (vterminater@gmail.com)" };

type Overview = Record<string, string>;
interface Fact { end?: string; val?: number; fy?: number; fp?: string; form?: string; }

// ── ticker → CIK (10-digit, zero-padded) via SEC's public map, cached 7d ────────
let _cikMap: Record<string, string> | null = null;
async function tickerToCik(ticker: string): Promise<string | null> {
  if (!_cikMap) {
    const data = await providerCachedFetch(
      "sec", "SEC_TICKERS", "https://www.sec.gov/files/company_tickers.json",
      { timeoutMs: 10000, maxAgeDays: 7, headers: SEC_UA },
    );
    if (!data || typeof data !== "object") return null;
    const map: Record<string, string> = {};
    for (const row of Object.values(data as Record<string, any>)) {
      const t = String(row?.ticker ?? "").toUpperCase();
      const cik = row?.cik_str;
      if (t && cik != null) map[t] = String(cik).padStart(10, "0");
    }
    _cikMap = map;
  }
  return _cikMap[ticker.toUpperCase()] ?? null;
}

// Latest annual observations (form 10-K, fp FY), newest first, deduped by fiscal year.
function annualFacts(concept: any): Fact[] {
  const arr: Fact[] = (concept?.units?.USD ?? []) as Fact[];
  const annual = arr.filter(f => (f.form === "10-K" || f.fp === "FY") && typeof f.val === "number" && f.fy != null);
  const byFy = new Map<number, Fact>();
  for (const f of annual) { const prev = byFy.get(f.fy!); if (!prev || String(f.end) > String(prev.end)) byFy.set(f.fy!, f); }
  return [...byFy.values()].sort((a, b) => (b.fy! - a.fy!));
}

// First concept tag present in the facts blob (revenue/equity/EPS vary by filer).
function pick(gaap: any, tags: string[]): Fact[] {
  for (const t of tags) { const f = annualFacts(gaap?.[t]); if (f.length) return f; }
  return [];
}

export async function fetchSecOverview(symbol: string): Promise<Overview> {
  const ticker = symbol.replace(/\.(US)$/i, "").toUpperCase();
  try {
    const cik = await tickerToCik(ticker);
    if (!cik) return {};
    const data = await providerCachedFetch(
      "sec", `SEC_FACTS:${cik}`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      { timeoutMs: 10000, maxAgeDays: 7, headers: SEC_UA },
    );
    const facts = (data as any)?.facts;
    const gaap = facts?.["us-gaap"] ?? facts?.["ifrs-full"];
    if (!gaap) return {};

    const rev = pick(gaap, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "Revenue"]);
    const ni = pick(gaap, ["NetIncomeLoss", "ProfitLoss"]);
    const eq = pick(gaap, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "Equity"]);
    const eps = pick(gaap, ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "DilutedEarningsLossPerShare"]);

    const ov: Overview = { Symbol: ticker };
    const revFy = rev[0]?.val, revPrev = rev[1]?.val, niFy = ni[0]?.val, eqFy = eq[0]?.val, eqPrev = eq[1]?.val;

    if (typeof niFy === "number" && typeof revFy === "number" && revFy !== 0) {
      ov.ProfitMargin = String(niFy / revFy); // fraction, matches AV scale
    }
    if (typeof niFy === "number" && typeof eqFy === "number") {
      const avgEq = typeof eqPrev === "number" ? (eqFy + eqPrev) / 2 : eqFy;
      if (avgEq !== 0) ov.ReturnOnEquityTTM = String(niFy / avgEq);
    }
    if (typeof revFy === "number" && typeof revPrev === "number" && revPrev !== 0) {
      ov.QuarterlyRevenueGrowthYOY = String((revFy - revPrev) / revPrev);
    }
    if (typeof eps[0]?.val === "number") ov.EPS = String(eps[0]!.val);
    return ov;
  } catch { return {}; }
}
