// Phase 3 learning-core: typed strategy genome. A genome-less strategy_versions
// row behaves exactly as before (legacy 5-weight scoring) — this is additive.
// Hard search-domain bounds are enforced HERE, not just documented, so a
// challenger proposing an out-of-bounds value is rejected before it can ever
// reach validation.

import crypto from "crypto";

export interface StrategyGenome {
  features: { included: string[]; transforms: Record<string, unknown> };
  // entry.rank_pct_min: minimum within-group cross-sectional percentile for a
  // NEW long entry (features/cross-sectional-rank). Optional & DEFAULT 0.0 =
  // rank never rejects → selection is byte-identical to pre-feature behavior.
  // A challenger carrying rank_pct_min > 0 is the ONLY way the rank gate turns
  // on, and only after owner promotion. Bounded [0, 0.95] at promotion.
  entry: { score_threshold: number; direction: "long"; rank_pct_min?: number };
  universe: { us: string; india: string; liquidity_min_dollar_vol: number | null };
  horizon_days: 2 | 5 | 10 | 20;
  exit: { family: "ledger_percentile" | "fixed_pct"; stop_mae_pctile: number; target_mfe_pctile: number; trail: number };
  sizing: { mode: "half_kelly" | "flat"; cap_pct: number; floor_pct: number };
  regime: { router: "none" | "vol_tercile" };
}

export const DEFAULT_GENOME: StrategyGenome = {
  features: { included: ["fundamental", "technical", "sentiment", "macro", "insider"], transforms: {} },
  entry: { score_threshold: 60, direction: "long", rank_pct_min: 0.0 },
  universe: { us: "screener_default", india: "nifty100", liquidity_min_dollar_vol: null },
  horizon_days: 10,
  exit: { family: "ledger_percentile", stop_mae_pctile: 25, target_mfe_pctile: 75, trail: 0.93 },
  sizing: { mode: "half_kelly", cap_pct: 10, floor_pct: 2 },
  regime: { router: "none" },
};

const BOUNDS = {
  "entry.score_threshold": [50, 75] as const,
  // 0.0 = off (allowed so a challenger can explicitly disable the rank gate);
  // active challengers realistically sit in [0.5, 0.9]. Upper cap 0.95 avoids a
  // gate so tight only the single top name in a group could ever clear it.
  "entry.rank_pct_min": [0, 0.95] as const,
  "exit.stop_mae_pctile": [10, 40] as const,
  "exit.target_mfe_pctile": [60, 90] as const,
  "sizing.cap_pct": [5, 15] as const,
};
const VALID_HORIZONS = [2, 5, 10, 20];

export interface GenomeValidation { ok: boolean; reason?: string }

// Validates a full genome object's fields against the hard search-domain
// bounds. Does NOT enforce "only one field changed" — that's a proposal-time
// convention (see genomeDiff), not a structural constraint.
export function validateGenomeBounds(genome: Partial<StrategyGenome>): GenomeValidation {
  if (genome.entry?.score_threshold != null) {
    const [lo, hi] = BOUNDS["entry.score_threshold"];
    if (genome.entry.score_threshold < lo || genome.entry.score_threshold > hi) {
      return { ok: false, reason: `entry.score_threshold ${genome.entry.score_threshold} outside [${lo},${hi}]` };
    }
  }
  if (genome.entry?.rank_pct_min != null) {
    const [lo, hi] = BOUNDS["entry.rank_pct_min"];
    if (genome.entry.rank_pct_min < lo || genome.entry.rank_pct_min > hi) {
      return { ok: false, reason: `entry.rank_pct_min ${genome.entry.rank_pct_min} outside [${lo},${hi}]` };
    }
  }
  if (genome.horizon_days != null && !VALID_HORIZONS.includes(genome.horizon_days)) {
    return { ok: false, reason: `horizon_days ${genome.horizon_days} not in {2,5,10,20}` };
  }
  if (genome.exit?.stop_mae_pctile != null) {
    const [lo, hi] = BOUNDS["exit.stop_mae_pctile"];
    if (genome.exit.stop_mae_pctile < lo || genome.exit.stop_mae_pctile > hi) {
      return { ok: false, reason: `exit.stop_mae_pctile ${genome.exit.stop_mae_pctile} outside [${lo},${hi}]` };
    }
  }
  if (genome.exit?.target_mfe_pctile != null) {
    const [lo, hi] = BOUNDS["exit.target_mfe_pctile"];
    if (genome.exit.target_mfe_pctile < lo || genome.exit.target_mfe_pctile > hi) {
      return { ok: false, reason: `exit.target_mfe_pctile ${genome.exit.target_mfe_pctile} outside [${lo},${hi}]` };
    }
  }
  if (genome.sizing?.cap_pct != null) {
    const [lo, hi] = BOUNDS["sizing.cap_pct"];
    if (genome.sizing.cap_pct < lo || genome.sizing.cap_pct > hi) {
      return { ok: false, reason: `sizing.cap_pct ${genome.sizing.cap_pct} outside [${lo},${hi}]` };
    }
  }
  return { ok: true };
}

// Counts top-level (dot-path) leaf differences between a base genome and a
// proposed one — used to enforce "one genome field per challenger" at the
// call site (learner tool), not structurally here.
export function genomeDiffCount(base: StrategyGenome, proposed: Partial<StrategyGenome>): number {
  const flatten = (obj: any, prefix = ""): Record<string, unknown> => {
    let out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) out = { ...out, ...flatten(v, path) };
      else out[path] = v;
    }
    return out;
  };
  const baseFlat = flatten(base);
  const proposedFlat = flatten(proposed);
  let diffs = 0;
  for (const [k, v] of Object.entries(proposedFlat)) {
    if (JSON.stringify(baseFlat[k]) !== JSON.stringify(v)) diffs++;
  }
  return diffs;
}

export function genomeHash(genome: StrategyGenome): string {
  return crypto.createHash("sha256").update(JSON.stringify(genome)).digest("hex");
}
