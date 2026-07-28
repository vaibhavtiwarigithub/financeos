// Phase 2 promotion gate — deterministic, no LLM.
//
// Answers: does this edge formula's IC evidence (from edge_ic_history) clear the
// bar for insertion into strategy_policies?
//
// Three gates:
//   1. t_stat > T_HURDLE (Newey-West corrected — priors need t≈2)
//   2. DSR_z > 0  (deflates t_stat for number of variants tested, Bailey 2014)
//   3. Walk-forward: IC positive in latest window, not decayed >50% from earliest
//
// "metal" shape note: sentiment.news_tone now includes "metal" — no impact here.

const MIN_WINDOWS = 3;   // minimum independent IC runs before gate evaluates
const IC_MIN = 0.02;     // IC floor — matches classifyEdgeIC in lib/edges/ic.ts
const T_HURDLE = 2.0;    // priored-factor t-stat standard
const WF_RATIO_MIN = 0.5; // latest IC must be ≥ 50% of earliest IC

// Inverse normal CDF (Abramowitz & Stegun 26.2.23, max error 4.5e-4).
// Used only for DSR E_max_t computation — this precision is sufficient.
function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < 0.5) {
    const t = Math.sqrt(-2 * Math.log(p));
    const num = 2.515517 + 0.802853 * t + 0.010328 * t * t;
    const den = 1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t;
    return -(t - num / den);
  }
  return -normInv(1 - p);
}

// Expected maximum t-stat for S independent trials (order statistics).
// Bailey 2014 §3: E[max SR over S trials] ≈ Φ⁻¹(1 − 1/(2S))
// For S=1 → 0 (no penalty), S=5 → 1.28, S=10 → 1.64, S=20 → 1.96.
function expectedMaxTStat(trials: number): number {
  if (trials <= 1) return 0;
  return normInv(1 - 1 / (2 * Math.max(1, trials)));
}

export interface GateInput {
  /** mean_ic per window_end in ascending chronological order (≥ 1 element). */
  ics: number[];
  /** Newey-West t_stat per window_end, same order as ics. */
  tStats: number[];
  /** backtest_experiments.variants_run — minimum 1, used for DSR penalty. */
  trialsRun: number;
}

export interface GateResult {
  pass: boolean;
  /** DSR z-score: t_best − E_max_t. Must be > 0 to pass. */
  dsr_z: number | null;
  t_stat_best: number | null;
  walk_forward_pass: boolean;
  /** Number of IC windows evaluated. */
  sample_n: number;
  /** Non-empty when pass=false. Each entry is a machine-readable failure code. */
  reasons: string[];
}

export function evaluateGate(input: GateInput): GateResult {
  const { ics, tStats, trialsRun } = input;
  const n = ics.length;
  const reasons: string[] = [];

  if (n < MIN_WINDOWS) {
    return {
      pass: false,
      dsr_z: null,
      t_stat_best: null,
      walk_forward_pass: false,
      sample_n: n,
      reasons: [`insufficient_windows:${n}<${MIN_WINDOWS}`],
    };
  }

  const icLatest = ics[n - 1];
  const icEarliest = ics[0];
  const tStatBest = Math.max(...tStats);

  // Gate 1: IC floor in latest window
  if (!Number.isFinite(icLatest) || icLatest < IC_MIN) {
    reasons.push(`ic_below_floor:latest=${icLatest?.toFixed(4)}<${IC_MIN}`);
  }

  // Gate 2: raw t-stat hurdle
  if (!Number.isFinite(tStatBest) || tStatBest < T_HURDLE) {
    reasons.push(`t_stat_below_hurdle:best=${tStatBest?.toFixed(2)}<${T_HURDLE}`);
  }

  // Gate 3: DSR — deflate t_stat for selection bias from variants_run
  const eMaxT = expectedMaxTStat(Math.max(1, trialsRun));
  const dsrZ = Number.isFinite(tStatBest) ? tStatBest - eMaxT : null;
  if (dsrZ === null || dsrZ <= 0) {
    reasons.push(`dsr_failed:dsr_z=${dsrZ?.toFixed(2) ?? "null"}<=0 (eMaxT=${eMaxT.toFixed(2)},trials=${trialsRun})`);
  }

  // Gate 4: walk-forward — IC positive and not decaying >50%
  const walkForwardPass =
    Number.isFinite(icLatest) &&
    Number.isFinite(icEarliest) &&
    icLatest > 0 &&
    icEarliest > 0 &&
    icLatest >= WF_RATIO_MIN * icEarliest;
  if (!walkForwardPass) {
    reasons.push(
      `walk_forward_failed:earliest=${icEarliest?.toFixed(4)},latest=${icLatest?.toFixed(4)},ratio_min=${WF_RATIO_MIN}`,
    );
  }

  return {
    pass: reasons.length === 0,
    dsr_z: dsrZ,
    t_stat_best: Number.isFinite(tStatBest) ? tStatBest : null,
    walk_forward_pass: walkForwardPass,
    sample_n: n,
    reasons,
  };
}
