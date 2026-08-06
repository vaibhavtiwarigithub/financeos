// Exit simulation over an actual price PATH — pure.
//
// MEASUREMENT ONLY. Simulates what an alternative exit rule would have done.
// Changes no stop, target, trail, time stop, order or live/paper exit.
//
// WHY A PATH AND NOT MAX-EXCURSION STATISTICS
// `exit-geometry-shadow.ts` classifies from MFE/MAE, which cannot order two
// events inside a window — it marks those `ambiguous` and excludes them. That is
// honest but it is fatal for a TRAILING stop, because a trail only ever triggers
// after a rise then a fall, so every case worth studying would be ambiguous.
// Replaying the bars resolves ordering exactly, and as a side effect resolves the
// ambiguity the excursion-based module has to refuse.
//
// WHAT IT STILL CANNOT SEE: intra-bar order. When one daily bar's low breaches
// the stop AND its high reaches the target, the sequence within that day is
// unknown. This assumes the STOP hit first — the pessimistic reading. That is
// deliberate: the optimistic assumption is how a backtest manufactures an edge,
// and a rule that only looks good under it is not a rule worth shipping.

export interface SimBar {
  date: string;
  high: number;
  low: number;
  close: number;
}

export interface PathGeometry {
  /** Initial stop distance below entry, as a fraction (0.075 = -7.5%). */
  stopPct: number;
  /** Target above entry. Omit for no target. */
  targetPct?: number;
  /**
   * Trailing distance below the highest HIGH seen since entry. Omit for none.
   * The trail never loosens: the effective stop is the max of the initial stop
   * and the trail, so it ratchets one way only.
   */
  trailPct?: number;
  /** Sessions held before the time stop fires. The live rule closes when age > this. */
  maxSessions: number;
}

export type PathExitReason = "stop" | "target" | "trail" | "time" | "unresolved";

export interface PathExit {
  reason: PathExitReason;
  /** Sessions after entry at which the exit happened. */
  sessions: number;
  /** Return from the entry close. Null only when unresolved. */
  ret: number | null;
  /** True when the exit bar was ambiguous intra-bar and the pessimistic branch was taken. */
  intrabarAmbiguous: boolean;
}

/**
 * Replay `bars` from an entry at `bars[0].close` under `geometry`.
 *
 * bars[0] is the ENTRY bar and is never evaluated for an exit — we enter at its
 * close, so that bar's range is already in the past. Evaluation starts at
 * bars[1], mirroring `computeEventOutcome`'s excursion window for the same
 * reason.
 */
export function simulateExit(bars: readonly SimBar[], geometry: PathGeometry): PathExit {
  if (bars.length < 2 || !(bars[0]?.close > 0) || geometry.maxSessions < 1) {
    return { reason: "unresolved", sessions: 0, ret: null, intrabarAmbiguous: false };
  }
  const entry = bars[0].close;
  const initialStop = entry * (1 - geometry.stopPct);
  const target = geometry.targetPct != null ? entry * (1 + geometry.targetPct) : null;

  let highestHigh = bars[0].high > 0 ? bars[0].high : entry;
  const last = Math.min(geometry.maxSessions, bars.length - 1);

  for (let i = 1; i <= last; i++) {
    const bar = bars[i];
    if (!(bar?.close > 0)) continue;

    // The trail is computed from the high seen BEFORE this bar. Using this
    // bar's own high would let the stop ratchet up on the same bar that then
    // breaches it — a look-ahead inside a single session.
    const trailStop = geometry.trailPct != null ? highestHigh * (1 - geometry.trailPct) : -Infinity;
    const effectiveStop = Math.max(initialStop, trailStop);

    const stopBreached = bar.low <= effectiveStop;
    const targetReached = target != null && bar.high >= target;

    if (stopBreached) {
      // Pessimistic on an ambiguous bar: stop first. Never the favourable branch.
      const isTrail = geometry.trailPct != null && trailStop > initialStop;
      return {
        reason: isTrail ? "trail" : "stop",
        sessions: i,
        ret: (effectiveStop - entry) / entry,
        intrabarAmbiguous: targetReached,
      };
    }
    if (targetReached) {
      return { reason: "target", sessions: i, ret: (target! - entry) / entry, intrabarAmbiguous: false };
    }

    if (bar.high > highestHigh) highestHigh = bar.high;
  }

  // Time stop — the live rule's dominant exit.
  const exitBar = bars[last];
  return {
    reason: "time",
    sessions: last,
    ret: (exitBar.close - entry) / entry,
    intrabarAmbiguous: false,
  };
}

export interface PathGeometryResult {
  label: string;
  geometry: PathGeometry;
  n: number;
  stop: number;
  target: number;
  trail: number;
  time: number;
  unresolved: number;
  intrabarAmbiguous: number;
  meanReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgSessions: number | null;
  baseline: boolean;
}

export function evaluatePathGeometry(
  paths: readonly (readonly SimBar[])[],
  geometry: PathGeometry,
  label: string,
  baseline = false,
): PathGeometryResult {
  const counts = { stop: 0, target: 0, trail: 0, time: 0, unresolved: 0 };
  let intrabarAmbiguous = 0;
  const returns: number[] = [];
  const sessions: number[] = [];

  for (const bars of paths) {
    const exit = simulateExit(bars, geometry);
    counts[exit.reason]++;
    if (exit.intrabarAmbiguous) intrabarAmbiguous++;
    if (exit.ret != null) { returns.push(exit.ret); sessions.push(exit.sessions); }
  }

  const sorted = [...returns].sort((a, b) => a - b);
  const n = returns.length;
  return {
    label, geometry, n: paths.length, ...counts, intrabarAmbiguous,
    meanReturn: n ? returns.reduce((s, x) => s + x, 0) / n : null,
    medianReturn: n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null,
    winRate: n ? returns.filter((x) => x > 0).length / n : null,
    avgSessions: sessions.length ? sessions.reduce((s, x) => s + x, 0) / sessions.length : null,
    baseline,
  };
}

/**
 * Candidates. The first is the LIVE rule as configured: a -7.5% initial stop
 * that trails 7.5% below the running high, a +19.2% target, and a 10-session
 * clock. Every alternative is judged against it.
 *
 * The trail variants are the point. Measured 2026-08-06: only 11-19% of
 * profitable positions were still near their high at the horizon, while 53-63%
 * had surrendered 70%+ of the move — and a 7.5% trail is wider than the entire
 * 2-4% excursion typical of this holding window, so it can essentially never
 * protect a gain.
 */
export const PATH_CANDIDATES: readonly { geometry: PathGeometry; label: string; baseline?: boolean }[] = [
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.075, maxSessions: 10 }, label: "LIVE: stop 7.5% / trail 7.5% / target 19.2% / 10d", baseline: true },
  { geometry: { stopPct: 0.075, targetPct: 0.192, maxSessions: 10 }, label: "no trail (isolates the trail's effect)" },
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.040, maxSessions: 10 }, label: "trail 4.0%" },
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.025, maxSessions: 10 }, label: "trail 2.5%" },
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.015, maxSessions: 10 }, label: "trail 1.5%" },
  { geometry: { stopPct: 0.075, targetPct: 0.060, trailPct: 0.025, maxSessions: 10 }, label: "trail 2.5% + target 6%" },
  { geometry: { stopPct: 0.050, targetPct: 0.060, trailPct: 0.025, maxSessions: 10 }, label: "stop 5% / trail 2.5% / target 6%" },
  // Horizon variants: the clock and the geometry currently disagree about
  // whether the thesis is a two-week trade or a multi-month swing.
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.075, maxSessions: 5 }, label: "LIVE geometry, 5-session clock" },
  { geometry: { stopPct: 0.075, targetPct: 0.192, trailPct: 0.075, maxSessions: 20 }, label: "LIVE geometry, 20-session clock" },
  { geometry: { stopPct: 0.075, targetPct: 0.060, trailPct: 0.025, maxSessions: 20 }, label: "trail 2.5% + target 6%, 20-session clock" },
];
