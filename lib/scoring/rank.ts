// Shared cross-sectional rank contract. Used by BOTH the live research cron
// (app/api/agents/research/cron/route.ts, "Pass 2") and — later — the offline
// Validation Engine, so a `rank_pct_min` challenger is always evaluated against
// the EXACT rank rule that runs live (mirrors how computeWeightedAnalystScore is
// shared between research-agent.ts and the engine).
//
// Deterministic, pure, NO LLM, NO I/O. A symbol's within-day percentile is
// computed over the ELIGIBLE pool only (data-quality gates run FIRST — the
// "rank composites after gates" requirement), partitioned into comparable
// groups (market × asset-type × sector). Groups below a minimum sample size
// fall back to a pre-registered fixed transform (`degraded`) instead of
// inventing a percentile from a handful of names ("three finalists are not a
// universe"). See features/cross-sectional-rank/FEATURE_ARCHITECTURE.md §4.

import { canonicalSectorKey } from "./sector-taxonomy";

export type RankAssetType = "equity" | "etf";

export interface RankCandidate {
  symbol: string;
  analystScore: number;
  market: string;            // 'us' | 'india'
  assetType: RankAssetType;
  sector: string | null;
  evidenceConfidence: number | null;
  direction: string;         // Pass-1 mechanical gate: 'long' | 'neutral' | 'short'
  isHeld: boolean;
}

export type RankQuality =
  | "ok"                // real empirical percentile over a large-enough group
  | "degraded"          // group below min sample → pre-registered fixed transform
  | "excluded_held"     // held position — never enters the NEW-entry rank pool
  | "excluded_abstain"  // direction !== 'long' (thin evidence / abstained / below floor)
  | "excluded_conf";    // evidence_confidence below the floor

export interface RankResult {
  symbol: string;
  rank_pct: number | null;           // null iff excluded_*
  rank_quality: RankQuality;
  comparable_group_key: string | null;
  group_n: number | null;            // eligible names in the FINAL assigned group
  rank_eligible: boolean;            // passed §4.1 gates → counted in a group
}

// The rank half of the hybrid entry gate (§5). Given a NEW long candidate's
// RankResult and the champion genome's rank_pct_min, is it rank-rejected?
//
// rankPctMin === 0 (the DEFAULT) ALWAYS returns false → the gate is a no-op and
// daily selection is byte-identical to pre-feature behavior. Only call this for
// NEW long candidates; held positions and non-long directions are filtered
// upstream and are never subject to the gate. Shared by the live cron (Pass 2)
// and tests so the tested rule equals the live rule.
export function isRankRejected(r: RankResult | undefined, rankPctMin: number): boolean {
  if (!(rankPctMin > 0)) return false;      // gate off → never rejects
  if (!r || !r.rank_eligible) return true;  // failed §4.1 data-quality gates
  return (r.rank_pct ?? 0) < rankPctMin;
}

// ── Pre-registered constants (documented in the feature architecture) ─────────
export const RANK_MIN_CONF = 0.6;            // evidence_confidence floor (§4.1)
export const RANK_MIN_GROUP_EQUITY_US = 20;  // US equity sector group min sample
export const RANK_MIN_GROUP_EQUITY_INDIA = 15;
export const RANK_MIN_GROUP_ETF = 20;        // ETFs almost always fall to degraded
// Degraded fixed transform: score 45 → 0, score 80 → 1 (clamped).
export const RANK_FLOOR_LO = 45;
export const RANK_FLOOR_HI = 80;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Canonical GICS sector, not the raw provider string.
 *
 * This used to lowercase and trim only, so `Semiconductors` and `Technology`
 * were different groups, as were `Banking` and `Financial Services`, and
 * `Media` / `Communications` / `Telecommunication`. Measured 2026-09-02: 41
 * distinct labels with a MEDIAN OF ~2 SYMBOLS EACH, against a
 * RANK_MIN_GROUP_EQUITY_US floor of 20 — so essentially every sector group fell
 * under the floor and collapsed into the market-wide fallback. The gate would
 * have ranked against the whole market while presenting a sector-partitioned
 * design.
 *
 * Unmapped labels return null and take the existing fallback path, which is the
 * honest place for a symbol whose sector we cannot name: a WRONG sector is worse
 * than a missing one, because it puts the symbol in a peer group it does not
 * belong to and every comparison inside that group is then quietly wrong.
 */
function normalizeSector(sector: string | null): string | null {
  return canonicalSectorKey(sector);
}

function minSampleFor(market: string, assetType: RankAssetType): number {
  if (assetType === "etf") return RANK_MIN_GROUP_ETF;
  return market === "india" ? RANK_MIN_GROUP_EQUITY_INDIA : RANK_MIN_GROUP_EQUITY_US;
}

// Fallback "all" group key when a sector group is too thin or the sector is
// unknown — never mixes markets or asset types.
function fallbackGroupKey(market: string, assetType: RankAssetType): string {
  return `${market}:${assetType}:all`;
}

function sectorGroupKey(market: string, assetType: RankAssetType, sector: string): string {
  return `${market}:${assetType}:${sector}`;
}

// Empirical within-group percentile: fraction of the group scoring STRICTLY
// below this symbol, over (n-1). Lowest = 0, highest = 1. Ties share a rank, so
// it is a monotonic transform of analystScore within the group (the intra-group
// ordering equals ordering by analyst_score — the CLAUDE.md "top-3" invariant).
function empiricalPercentile(score: number, groupScores: number[]): number {
  const n = groupScores.length;
  if (n <= 1) return degradedTransform(score); // guard; callers avoid this path
  const below = groupScores.filter(s => s < score).length;
  return clamp01(below / (n - 1));
}

function degradedTransform(score: number): number {
  return clamp01((score - RANK_FLOOR_LO) / (RANK_FLOOR_HI - RANK_FLOOR_LO));
}

// Data-quality eligibility (§4.1). Order matters only for the reported reason.
// Returns null when eligible, otherwise the exclusion quality.
function exclusionReason(c: RankCandidate): RankQuality | null {
  if (c.isHeld) return "excluded_held";
  if (c.direction !== "long") return "excluded_abstain"; // thin/abstain/below-floor all collapse to neutral in Pass 1
  if (c.evidenceConfidence != null && c.evidenceConfidence < RANK_MIN_CONF) return "excluded_conf";
  return null;
}

/**
 * Compute grouped cross-sectional rank for one within-day universe.
 *
 * Deterministic given the input array (independent of input ordering). Excluded
 * symbols still get a row (rank_pct=null, rank_eligible=false) for auditability.
 */
export function computeComparableRank(candidates: RankCandidate[]): RankResult[] {
  // 1. Split eligible vs excluded.
  const excluded = new Map<string, RankQuality>();
  const eligible: RankCandidate[] = [];
  for (const c of candidates) {
    const reason = exclusionReason(c);
    if (reason) excluded.set(c.symbol, reason);
    else eligible.push(c);
  }

  // 2. Preferred (sector) key per eligible candidate + count eligibles per key.
  const preferredKeyOf = new Map<string, string | null>(); // symbol → sector key or null
  const sectorEligibleCount = new Map<string, number>();
  for (const c of eligible) {
    const sector = normalizeSector(c.sector);
    if (sector) {
      const key = sectorGroupKey(c.market, c.assetType, sector);
      preferredKeyOf.set(c.symbol, key);
      sectorEligibleCount.set(key, (sectorEligibleCount.get(key) ?? 0) + 1);
    } else {
      preferredKeyOf.set(c.symbol, null);
    }
  }

  // 3. Assign each eligible to its sector group only if that group meets its
  //    market/asset min sample; else to the market:asset:all fallback.
  const assignedKeyOf = new Map<string, string>();
  const groupScores = new Map<string, number[]>();
  for (const c of eligible) {
    const preferred = preferredKeyOf.get(c.symbol) ?? null;
    const min = minSampleFor(c.market, c.assetType);
    const useSector = preferred != null && (sectorEligibleCount.get(preferred) ?? 0) >= min;
    const key = useSector ? preferred! : fallbackGroupKey(c.market, c.assetType);
    assignedKeyOf.set(c.symbol, key);
    const arr = groupScores.get(key) ?? [];
    arr.push(c.analystScore);
    groupScores.set(key, arr);
  }

  // 4. Emit results.
  return candidates.map(c => {
    const reason = excluded.get(c.symbol);
    if (reason) {
      return {
        symbol: c.symbol,
        rank_pct: null,
        rank_quality: reason,
        comparable_group_key: null,
        group_n: null,
        rank_eligible: false,
      };
    }
    const key = assignedKeyOf.get(c.symbol)!;
    const scores = groupScores.get(key)!;
    const n = scores.length;
    const min = minSampleFor(c.market, c.assetType);
    // Real percentile only when the FINAL group is large enough; otherwise the
    // honest degenerate: a softened absolute gate flagged `degraded`.
    const isOk = n >= min && n > 1;
    return {
      symbol: c.symbol,
      rank_pct: isOk ? empiricalPercentile(c.analystScore, scores) : degradedTransform(c.analystScore),
      rank_quality: isOk ? "ok" : "degraded",
      comparable_group_key: key,
      group_n: n,
      rank_eligible: true,
    };
  });
}
