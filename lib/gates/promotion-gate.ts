// Phase 2 promotion gate — deterministic, no LLM.
//
// Answers: does this edge formula's IC evidence (from edge_ic_history) clear the
// bar for insertion into strategy_policies?
//
// Four gates:
//   1. ≥ MIN_WINDOWS distinct IC windows
//   2. latest-window IC ≥ IC_MIN
//   3. latest-window Newey-West t_stat ≥ T_HURDLE, and DSR_z > 0 after deflating
//      for the number of variants tested. This is the trial-count adjustment
//      term ONLY — it is NOT a Deflated Sharpe Ratio; see t_margin_vs_trials.
//   4. IC estimate stability across windows (NOT walk-forward — see banner below)

// ⚠ THESE WINDOWS ARE NOT WALK-FORWARD FOLDS. Measured in prod 2026-07-27:
// every edge_ic_history row is an IC over history_days = 1000, and the six US
// windows span 16 calendar days end to end — so consecutive windows share ~98.4%
// of their underlying data. They are the same backtest re-run weekly with the
// end date nudged, not out-of-sample folds.
//
// Consequence: the cross-window check below measures ESTIMATE STABILITY (does the
// IC estimate hold when a couple more weeks are appended?), NOT out-of-sample
// decay. It is named accordingly. The genuine statistical evidence is the
// Newey-West t-stat WITHIN a single window, computed over that window's ~96
// as-of dates — that one is unaffected by the overlap.
//
// Real walk-forward requires the IC engine to emit disjoint folds (window k
// evaluated only on data after window k-1 ended). That is an edge-ic change,
// proposed in features/walk-forward-ic-folds/FEATURE_ARCHITECTURE.md — NOT
// approved, NOT implemented. Until it lands, nothing here may claim
// out-of-sample validation.
const MIN_WINDOWS = 3;   // distinct window_end values (deduped by caller)
const IC_MIN = 0.02;     // IC floor — matches classifyEdgeIC in lib/edges/ic.ts
const T_HURDLE = 2.0;    // priored-factor t-stat standard
const STABILITY_RATIO_MIN = 0.5; // latest IC must be ≥ 50% of earliest IC

/**
 * Canonical provider-regime key for one IC window, from its `providerCounts`.
 *
 * Why this exists: on 2026-08-18 the US edge/IC candle ladder moved to
 * Yahoo-first (lifting Massive's 2-year lookback cap). IC computed on Yahoo bars
 * is not the same measurement as IC computed on Massive/EODHD/TwelveData bars,
 * yet both land in `edge_ic_history` and this gate reads a 1000-day window — so
 * a promotion evaluated across the boundary would compare a Yahoo latest window
 * against a Massive earliest window and call the difference "stability".
 *
 * DOMINANT provider, not the exact count map: `{eodhd:20, massive:6}` and
 * `{eodhd:19, massive:7}` are the same regime, and keying on the full map would
 * over-segment on ordinary run-to-run jitter and starve the gate of windows.
 * Ties break alphabetically so the key is deterministic.
 */
export function providerRegimeKey(counts: Record<string, number> | null | undefined): string {
  if (!counts || typeof counts !== "object") return "unknown";
  const entries = Object.entries(counts)
    .map(([name, n]) => [name, Number(n)] as const)
    .filter(([name, n]) => !!name && Number.isFinite(n) && n > 0);
  if (entries.length === 0) return "unknown";
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

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

// Which t-stat represents the edge? Measured against real prod data 2026-07-27,
// all three plausible choices were tried and two are unusable:
//
//   max(tStats)     — cherry-picks the luckiest of N windows. dma_trend_slope@20d
//                     reads 2.83 as a max and 0.55 as its latest window. Upward
//                     biased by exactly the order-statistic effect the DSR gate
//                     exists to correct, so using it made the gate self-defeating.
//   mean/SE(ICs)    — pooling assumes independent windows. These are ROLLING and
//                     overlapping, so the IC series is autocorrelated and the SE
//                     collapses: an India edge with 3 windows scored t = 13.77.
//   latest window   — unbiased and no cherry-pick, at the cost of using one
//                     window's worth of data. Underpowered, which fails CLOSED.
//
// We take the latest. It also matches the "recent evidence governs" philosophy in
// this file. Correctly pooling overlapping windows (a
// Newey-West correction across windows rather than within one) is the real fix
// and is deferred until there is enough non-overlapping history to justify it.
export interface GateInput {
  /** mean_ic per window_end in ascending chronological order (≥ 1 element). */
  ics: number[];
  /** Newey-West t_stat per window_end, same order as ics. */
  tStats: number[];
  /** backtest_experiments.variants_run — minimum 1, used for DSR penalty. */
  trialsRun: number;
  /**
   * Provider-regime key per window, same order as `ics`. Optional: when absent
   * the gate behaves exactly as before (no segmentation).
   *
   * When present, ONLY the trailing run of windows sharing the latest window's
   * regime is evaluated. Older windows from a different regime are DROPPED, not
   * blended — mixing them makes the stability check compare two different
   * measurements. Dropping can leave fewer than MIN_WINDOWS, which fails CLOSED
   * with its own reason: after a provider change the correct answer is "not
   * enough clean evidence yet", not a promotion on mixed data.
   */
  providerRegimes?: string[];
}

export interface GateResult {
  pass: boolean;
  /**
   * `t_latest − E[max t over trialsRun]`. Must be > 0 to pass.
   *
   * NOT the Bailey/López de Prado Deflated Sharpe Ratio, despite an earlier
   * comment in this file saying so. This is only the trial-count adjustment
   * term. Real DSR additionally accounts for sample length and the skew and
   * kurtosis of the return series, and is computed on cost-adjusted STRATEGY
   * RETURNS — not on an information coefficient. Do not persist this value to
   * a column named `dsr`, and do not describe it as DSR anywhere.
   */
  t_margin_vs_trials: number | null;
  /** Newey-West t-stat of the LATEST window — never the max across windows. */
  t_stat_latest: number | null;
  /**
   * IC estimate held up as data was appended. NOT out-of-sample validation —
   * the windows overlap ~98%. See the banner at the top of this file.
   */
  ic_stability_pass: boolean;
  /** Number of IC windows evaluated (AFTER provider-regime segmentation). */
  sample_n: number;
  /** Regime the evaluated windows share, when segmentation was applied. */
  provider_regime?: string;
  /** Windows discarded for belonging to an older provider regime. */
  windows_dropped_other_regime?: number;
  /** Non-empty when pass=false. Each entry is a machine-readable failure code. */
  reasons: string[];
}

export function evaluateGate(input: GateInput): GateResult {
  const { trialsRun } = input;
  let ics = input.ics;
  let tStats = input.tStats;
  const reasons: string[] = [];
  let providerRegime: string | undefined;
  let windowsDropped: number | undefined;

  // Provider-regime segmentation, before any statistic is computed.
  const regimes = input.providerRegimes;
  if (regimes) {
    if (regimes.length !== ics.length) {
      return {
        pass: false, t_margin_vs_trials: null, t_stat_latest: null,
        ic_stability_pass: false, sample_n: ics.length,
        reasons: ["invalid_gate_input"],
      };
    }
    const latest = regimes[regimes.length - 1];
    providerRegime = latest;
    if (!latest || latest === "unknown") {
      // A window that cannot name the data it was computed on cannot be
      // segmented, and therefore cannot be trusted to be like-for-like.
      return {
        pass: false, t_margin_vs_trials: null, t_stat_latest: null,
        ic_stability_pass: false, sample_n: ics.length,
        provider_regime: latest || "unknown", windows_dropped_other_regime: 0,
        reasons: ["provider_regime_unknown"],
      };
    }
    let start = regimes.length;
    while (start > 0 && regimes[start - 1] === latest) start--;
    windowsDropped = start;
    if (start > 0) {
      ics = ics.slice(start);
      tStats = tStats.slice(start);
    }
    if (ics.length < MIN_WINDOWS) {
      return {
        pass: false, t_margin_vs_trials: null, t_stat_latest: null,
        ic_stability_pass: false, sample_n: ics.length,
        provider_regime: latest, windows_dropped_other_regime: windowsDropped,
        reasons: [`insufficient_windows_in_provider_regime:${ics.length}<${MIN_WINDOWS}:${latest}`],
      };
    }
  }

  const n = ics.length;

  if (
    tStats.length !== n ||
    !Number.isFinite(trialsRun) ||
    !Number.isInteger(trialsRun) ||
    trialsRun < 1
  ) {
    return {
      pass: false,
      t_margin_vs_trials: null,
      t_stat_latest: null,
      ic_stability_pass: false,
      sample_n: n,
      provider_regime: providerRegime,
      windows_dropped_other_regime: windowsDropped,
      reasons: ["invalid_gate_input"],
    };
  }

  if (n < MIN_WINDOWS) {
    return {
      pass: false,
      t_margin_vs_trials: null,
      t_stat_latest: null,
      ic_stability_pass: false,
      sample_n: n,
      provider_regime: providerRegime,
      windows_dropped_other_regime: windowsDropped,
      reasons: [`insufficient_windows:${n}<${MIN_WINDOWS}`],
    };
  }

  const icLatest = ics[n - 1];
  const icEarliest = ics[0];
  const tStatLatest = tStats[n - 1];

  // Gate 1: IC floor in latest window
  if (!Number.isFinite(icLatest) || icLatest < IC_MIN) {
    reasons.push(`ic_below_floor:latest=${icLatest?.toFixed(4)}<${IC_MIN}`);
  }

  // Gate 2: raw t-stat hurdle
  if (!Number.isFinite(tStatLatest) || tStatLatest < T_HURDLE) {
    reasons.push(`t_stat_below_hurdle:latest=${tStatLatest?.toFixed(2)}<${T_HURDLE}`);
  }

  // Gate 3: DSR — deflate t_stat for selection bias from variants_run
  const eMaxT = expectedMaxTStat(Math.max(1, trialsRun));
  const tMargin = Number.isFinite(tStatLatest) ? tStatLatest - eMaxT : null;
  if (tMargin === null || tMargin <= 0) {
    reasons.push(`trial_adjusted_t_failed:t_margin_vs_trials=${tMargin?.toFixed(2) ?? "null"}<=0 (eMaxT=${eMaxT.toFixed(2)},trials=${trialsRun})`);
  }

  // Gate 4: stability — IC positive in both endpoints and not halved
  const icStabilityPass =
    Number.isFinite(icLatest) &&
    Number.isFinite(icEarliest) &&
    icLatest > 0 &&
    icEarliest > 0 &&
    icLatest >= STABILITY_RATIO_MIN * icEarliest;
  if (!icStabilityPass) {
    reasons.push(
      `ic_stability_failed:earliest=${icEarliest?.toFixed(4)},latest=${icLatest?.toFixed(4)},ratio_min=${STABILITY_RATIO_MIN}`,
    );
  }

  return {
    pass: reasons.length === 0,
    t_margin_vs_trials: tMargin,
    t_stat_latest: Number.isFinite(tStatLatest) ? tStatLatest : null,
    ic_stability_pass: icStabilityPass,
    sample_n: n,
    provider_regime: providerRegime,
    windows_dropped_other_regime: windowsDropped,
    reasons,
  };
}
