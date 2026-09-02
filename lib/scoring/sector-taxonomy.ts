/**
 * One canonical sector per symbol, at ONE level of granularity.
 * features/sector-regime-dimension/FEATURE_ARCHITECTURE.md — Stage 0.
 *
 * THE PROBLEM THIS SOLVES. Measured 2026-09-02 across `symbol_profiles`,
 * `paper_positions` and `holding_risk_snapshots`, the stored sector labels are
 * 41 distinct strings at MIXED granularity: `Semiconductors` (16) sits beside
 * `Technology` (304), so an identical chip maker lands in either; `Banking` (2)
 * splits from `Financial Services` (10); `Communications`, `Telecommunication`
 * and `Media` are three names for one sector. `normalizeSector` in
 * ./rank.ts only lowercased and trimmed, so every variant stayed a separate
 * group.
 *
 * WHY IT MATTERS BEYOND COSMETICS. `rank.ts` partitions the cross-section into
 * `market x asset-type x sector` and requires RANK_MIN_GROUP_EQUITY_US = 20
 * members, falling back to a market-wide `:all` group below that. With a median
 * of ~2 symbols per raw label, essentially EVERY sector group fell under the
 * floor and collapsed into the fallback — so the cross-sectional rank gate would
 * have ranked against the whole market while presenting a sector-partitioned
 * design.
 *
 * THE LABEL SPACE HOLDS TWO TAXONOMIES, NOT ONE. Alongside equity sectors the
 * data carries FUND asset classes — `Diversified Equity`, `International
 * Equity`, `Fixed Income`, `Commodities`, `Digital Assets`. Forcing a bond ETF
 * into a GICS sector would be a category error, so those resolve to an explicit
 * fund class instead of being bent into an equity bucket.
 */

/** The 11 GICS sectors. This is the ONLY equity granularity we group on. */
export type GicsSector =
  | "Information Technology"
  | "Health Care"
  | "Financials"
  | "Consumer Discretionary"
  | "Consumer Staples"
  | "Communication Services"
  | "Industrials"
  | "Energy"
  | "Utilities"
  | "Real Estate"
  | "Materials";

export const GICS_SECTORS: GicsSector[] = [
  "Information Technology", "Health Care", "Financials", "Consumer Discretionary",
  "Consumer Staples", "Communication Services", "Industrials", "Energy",
  "Utilities", "Real Estate", "Materials",
];

/** Fund-level classes that are NOT equity sectors and must not be mapped to one. */
export type FundAssetClass =
  | "Diversified Equity" | "International Equity" | "Fixed Income"
  | "Commodities" | "Digital Assets";

export type SectorClassification =
  | { kind: "gics"; sector: GicsSector }
  | { kind: "fund_asset_class"; assetClass: FundAssetClass }
  /** Deliberately not guessed. `raw` is kept so the gap is visible and fixable. */
  | { kind: "unmapped"; raw: string };

/**
 * Raw label (lowercased) -> canonical sector.
 *
 * Every entry below was observed in production on 2026-09-02. Industry-level
 * labels are lifted to their GICS sector; that is the whole point, since mixed
 * granularity is what fragmented the groups.
 */
const GICS_MAP: Record<string, GicsSector> = {
  // Information Technology — note `semiconductors` is an INDUSTRY, lifted here.
  "technology": "Information Technology",
  "information technology": "Information Technology",
  "semiconductors": "Information Technology",
  "software": "Information Technology",
  "it": "Information Technology",

  // Health Care — biotech and life-science tools are industries within it.
  "healthcare": "Health Care",
  "health care": "Health Care",
  "biotechnology": "Health Care",
  "pharmaceuticals": "Health Care",
  "life sciences tools & services": "Health Care",

  // Financials — `banking` and `financial services` are the same GICS sector.
  "financials": "Financials",
  "financial services": "Financials",
  "banking": "Financials",
  "banks": "Financials",
  "insurance": "Financials",

  // Consumer Discretionary — "consumer cyclical" is the Yahoo name for it.
  "consumer discretionary": "Consumer Discretionary",
  "consumer cyclical": "Consumer Discretionary",
  "retail": "Consumer Discretionary",
  "hotels, restaurants & leisure": "Consumer Discretionary",
  "automobiles": "Consumer Discretionary",
  "textiles, apparel & luxury goods": "Consumer Discretionary",

  // Consumer Staples — "consumer defensive" is the Yahoo name.
  "consumer staples": "Consumer Staples",
  "consumer defensive": "Consumer Staples",
  "consumer products": "Consumer Staples",
  "beverages": "Consumer Staples",
  "food & beverage": "Consumer Staples",
  "food products": "Consumer Staples",

  // Communication Services — three observed names for one sector.
  "communication services": "Communication Services",
  "communication": "Communication Services",
  "communications": "Communication Services",
  "telecommunication": "Communication Services",
  "telecommunications": "Communication Services",
  "media": "Communication Services",

  // Industrials — several industry labels roll up here.
  "industrials": "Industrials",
  "aerospace & defense": "Industrials",
  "machinery": "Industrials",
  "road & rail": "Industrials",
  "logistics & transportation": "Industrials",
  "transportation": "Industrials",
  "commercial services & supplies": "Industrials",
  "electrical equipment": "Industrials",

  "energy": "Energy",
  "oil & gas": "Energy",

  "utilities": "Utilities",

  "real estate": "Real Estate",
  "reit": "Real Estate",

  // Materials — "basic materials" is the Yahoo name.
  "materials": "Materials",
  "basic materials": "Materials",
  "metals & mining": "Materials",
  "chemicals": "Materials",
};

const FUND_MAP: Record<string, FundAssetClass> = {
  "diversified equity": "Diversified Equity",
  "international equity": "International Equity",
  "fixed income": "Fixed Income",
  "bonds": "Fixed Income",
  "commodities": "Commodities",
  "digital assets": "Digital Assets",
  "crypto": "Digital Assets",
};

/**
 * Classify a raw sector string.
 *
 * `Other`, empty and unknown labels return `unmapped` rather than a guess. A
 * wrong sector is worse than a missing one: it puts a symbol in a peer group it
 * does not belong to, and every relative comparison inside that group is then
 * quietly wrong.
 */
export function classifySector(raw: string | null | undefined): SectorClassification {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key || key === "other" || key === "unknown" || key === "n/a") {
    return { kind: "unmapped", raw: String(raw ?? "") };
  }
  const gics = GICS_MAP[key];
  if (gics) return { kind: "gics", sector: gics };
  const fund = FUND_MAP[key];
  if (fund) return { kind: "fund_asset_class", assetClass: fund };
  return { kind: "unmapped", raw: String(raw ?? "") };
}

/**
 * The grouping key for cross-sectional comparison, or null when unknown.
 *
 * Returning null (rather than an "unknown" bucket) keeps unmapped symbols OUT of
 * peer comparisons entirely — `rank.ts` already has a market-wide fallback for
 * exactly that case, which is the honest place for a symbol whose sector we
 * cannot name.
 */
export function canonicalSectorKey(raw: string | null | undefined): string | null {
  const classified = classifySector(raw);
  if (classified.kind === "gics") return classified.sector;
  if (classified.kind === "fund_asset_class") return classified.assetClass;
  return null;
}

export interface SectorCoverage {
  total: number;
  mapped: number;
  gics: number;
  fundAssetClass: number;
  unmapped: number;
  coverage: number;
  /** Distinct raw labels that resolved to nothing, most frequent first. */
  unmappedLabels: Array<{ label: string; count: number }>;
}

/**
 * Coverage of a symbol population. Stage 0's success criterion is MEASURED, and
 * the unmapped labels are named so the next gap is a one-line map entry rather
 * than another investigation.
 */
export function sectorCoverage(rawLabels: Array<string | null | undefined>): SectorCoverage {
  const counts = new Map<string, number>();
  let gics = 0, fund = 0, unmapped = 0;
  for (const raw of rawLabels) {
    const classified = classifySector(raw);
    if (classified.kind === "gics") gics++;
    else if (classified.kind === "fund_asset_class") fund++;
    else {
      unmapped++;
      const label = classified.raw.trim() || "(empty)";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const total = rawLabels.length;
  return {
    total,
    mapped: gics + fund,
    gics,
    fundAssetClass: fund,
    unmapped,
    coverage: total ? (gics + fund) / total : 0,
    unmappedLabels: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
