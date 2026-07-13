import { providerCachedFetch } from "@/lib/data/provider-fetch";

// ⚠️ EXPERIMENTAL — NOT WIRED INTO SCORING. A live spot-check (2026-07-13) found
// the raw-companyfacts derivation below gives wrong margin/ROE for several filers
// (NVDA/MSFT off by >2×) because SEC XBRL concept selection (which "Revenues"
// tag is the true total, cumulative vs annual frames) needs the SEC `frames` API,
// not tag heuristics. Left here as a starting point; do NOT add to fetchUsOverview
// until margin/ROE match a known-good source within tolerance across >=10 names.
//
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

// Build fiscalYear → value for a set of candidate tags. Annual only (10-K / FY),
// latest filing per year. When several tags report the same year (common for
// revenue: a filer lists both a partial "Revenues" line AND the total
// "RevenueFromContractWithCustomer…"), keep the LARGEST — the total, not a
// sub-line. This is what fixes AAPL/MSFT margins being 1.5–6× too high.
function fyMap(gaap: any, tags: string[], mode: "max" | "first" = "max"): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of tags) {
    const arr: Fact[] = (gaap?.[t]?.units?.USD ?? []) as Fact[];
    for (const f of arr) {
      if (!(f.form === "10-K" || f.fp === "FY")) continue;
      if (typeof f.val !== "number" || f.fy == null) continue;
      const cur = out.get(f.fy);
      if (cur == null) out.set(f.fy, f.val);
      else if (mode === "max") out.set(f.fy, Math.max(cur, f.val));
      // mode "first": keep the earliest tag's value (tags passed in priority order)
    }
    if (mode === "first" && out.size) break; // first tag that produced any year wins
  }
  return out;
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

    // Revenue: MAX across candidate tags per year (total, not a sub-line).
    const revByFy = fyMap(gaap, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "Revenue"], "max");
    const niByFy  = fyMap(gaap, ["NetIncomeLoss", "ProfitLoss"], "first");
    const eqByFy  = fyMap(gaap, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "Equity"], "max");
    // EPS lives in a per-share unit (not USD) — pull it separately, latest annual.
    const epsUnit = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "DilutedEarningsLossPerShare"]
      .map(t => gaap?.[t]?.units).find(u => u && Object.keys(u).length);
    const epsAnnual = epsUnit ? (Object.values(epsUnit)[0] as Fact[]).filter(f => (f.form === "10-K" || f.fp === "FY") && typeof f.val === "number" && f.fy != null).sort((a, b) => b.fy! - a.fy!) : [];

    // Align every derived metric on the SAME target fiscal year — the latest year
    // for which net income exists — so margin/ROE/growth are never cross-period.
    const targetFy = [...niByFy.keys()].sort((a, b) => b - a)[0];
    if (targetFy == null) return { Symbol: ticker };
    const ni = niByFy.get(targetFy);
    const rev = revByFy.get(targetFy);
    const revPrev = revByFy.get(targetFy - 1);
    const eq = eqByFy.get(targetFy);
    const eqPrev = eqByFy.get(targetFy - 1);

    const ov: Overview = { Symbol: ticker };
    if (typeof ni === "number" && typeof rev === "number" && rev > 0) {
      ov.ProfitMargin = String(ni / rev); // fraction, matches AV scale
    }
    if (typeof ni === "number" && typeof eq === "number") {
      const avgEq = typeof eqPrev === "number" ? (eq + eqPrev) / 2 : eq;
      if (avgEq !== 0) ov.ReturnOnEquityTTM = String(ni / avgEq);
    }
    if (typeof rev === "number" && typeof revPrev === "number" && revPrev > 0) {
      ov.QuarterlyRevenueGrowthYOY = String((rev - revPrev) / revPrev);
    }
    if (typeof epsAnnual[0]?.val === "number") ov.EPS = String(epsAnnual[0]!.val);
    return ov;
  } catch { return {}; }
}
