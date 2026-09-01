// Deterministic NAV / benchmark marking layer.
//
// WHY THIS EXISTS. `lib/simulation/portfolio-simulator.ts` returns endingCash,
// positions, fills, rejections and realizedPnl — it produces NO daily NAV path.
// Sharpe, Sortino, maximum drawdown, benchmark alpha and stress-day correlation
// are therefore uncomputable from the simulator alone. An earlier draft of
// features/external-strategy-discovery cited it as able to produce those metrics.
// It cannot; independent review caught that, and this module is the missing seam.
//
// Alpha Lab A6 solved the same problem privately inside
// lib/analytics/alpha-diagnostics-portfolio.ts. This module is the shared,
// spec-agnostic version so replay does not become a second implementation.
//
// MEASURE-ONLY.

export interface DailyMark {
  session: string;
  /** Close per symbol for this session. A missing symbol is missing information. */
  prices: Record<string, number>;
  /** Benchmark close, or null when the benchmark has no bar for this session. */
  benchClose: number | null;
}

export interface NavPoint {
  session: string;
  cash: number;
  positionsValue: number;
  nav: number;
  benchNav: number | null;
  drawdownPct: number;
}

export interface HoldingsAt {
  session: string;
  cash: number;
  positions: Array<{ symbol: string; quantity: number; costBasis: number }>;
}

export interface NavSeries {
  points: NavPoint[];
  totalReturnPct: number | null;
  benchTotalReturnPct: number | null;
  netExcessReturnPp: number | null;
  maxDrawdownPct: number;
  /** Annualised, 252 sessions. Null when fewer than 2 points or zero variance. */
  sharpe: number | null;
  /** Downside-deviation variant. Null under the same conditions. */
  sortino: number | null;
  /** Return correlation with the benchmark on the WORST benchmark days.
   *  Low average correlation is not enough — correlations rise under stress. */
  stressCorrelation: number | null;
  meanCashUtilization: number;
  /** Sessions where a held symbol had no price and was carried at cost. */
  unpricedSessions: number;
}

const SESSIONS_PER_YEAR = 252;
/** Worst decile of benchmark sessions defines "stress". */
const STRESS_QUANTILE = 0.1;

function pctChange(a: number, b: number): number | null {
  return b === 0 ? null : ((a - b) / b) * 100;
}

/**
 * Mark a holdings path to market, session by session.
 *
 * A held symbol with no price for a session is carried at COST BASIS, never
 * marked to zero — a missing quote is missing information, not a wipeout. Those
 * sessions are counted in `unpricedSessions` so the caller can judge whether the
 * series is trustworthy rather than discovering it silently.
 */
export function markNavSeries(
  holdings: readonly HoldingsAt[],
  marks: readonly DailyMark[],
): NavSeries {
  const bySession = new Map(marks.map((m) => [m.session, m]));
  const points: NavPoint[] = [];
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  let unpricedSessions = 0;
  let utilizationSum = 0;

  for (const h of holdings) {
    const mark = bySession.get(h.session);
    let positionsValue = 0;
    let unpricedHere = false;
    for (const p of h.positions) {
      const px = mark?.prices?.[p.symbol];
      if (typeof px === "number" && Number.isFinite(px) && px > 0) {
        positionsValue += px * p.quantity;
      } else {
        positionsValue += p.costBasis * p.quantity;
        unpricedHere = true;
      }
    }
    if (unpricedHere) unpricedSessions++;

    const nav = h.cash + positionsValue;
    peak = Math.max(peak, nav);
    const drawdownPct = peak > 0 ? ((peak - nav) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    utilizationSum += nav > 0 ? positionsValue / nav : 0;

    points.push({
      session: h.session,
      cash: h.cash,
      positionsValue,
      nav,
      benchNav: mark?.benchClose ?? null,
      drawdownPct,
    });
  }

  if (points.length < 2) {
    return {
      points, totalReturnPct: null, benchTotalReturnPct: null,
      netExcessReturnPp: null, maxDrawdownPct, sharpe: null, sortino: null,
      stressCorrelation: null,
      meanCashUtilization: points.length ? utilizationSum / points.length : 0,
      unpricedSessions,
    };
  }

  const totalReturnPct = pctChange(points[points.length - 1].nav, points[0].nav);

  // The benchmark is measured over the sessions where it actually has bars, and
  // the excess is only reported when both endpoints exist. A benchmark gap must
  // never silently shorten or lengthen the portfolio's own window.
  const withBench = points.filter((p) => p.benchNav != null);
  const benchTotalReturnPct = withBench.length >= 2
    ? pctChange(withBench[withBench.length - 1].benchNav!, withBench[0].benchNav!)
    : null;
  const netExcessReturnPp = totalReturnPct != null && benchTotalReturnPct != null
    ? totalReturnPct - benchTotalReturnPct : null;

  const navReturns = dailyReturns(points.map((p) => p.nav));
  const sharpe = annualisedSharpe(navReturns);
  const sortino = annualisedSortino(navReturns);

  return {
    points, totalReturnPct, benchTotalReturnPct, netExcessReturnPp,
    maxDrawdownPct, sharpe, sortino,
    stressCorrelation: stressCorrelationOf(points),
    meanCashUtilization: utilizationSum / points.length,
    unpricedSessions,
  };
}

function dailyReturns(levels: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i - 1] > 0) out.push((levels[i] - levels[i - 1]) / levels[i - 1]);
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function annualisedSharpe(rets: number[]): number | null {
  if (rets.length < 2) return null;
  const m = mean(rets);
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1));
  // Zero variance is undefined, not infinite skill.
  return sd > 0 ? (m / sd) * Math.sqrt(SESSIONS_PER_YEAR) : null;
}

function annualisedSortino(rets: number[]): number | null {
  if (rets.length < 2) return null;
  const m = mean(rets);
  const downside = rets.filter((r) => r < 0);
  if (downside.length === 0) return null; // no downside observed: undefined, not perfect
  const dd = Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length);
  return dd > 0 ? (m / dd) * Math.sqrt(SESSIONS_PER_YEAR) : null;
}

/**
 * Correlation between portfolio and benchmark returns on the WORST benchmark
 * sessions.
 *
 * Reported because average correlation understates joint risk: a pair can look
 * decorrelated overall and still lose together in every stressed session, which
 * is exactly when it matters.
 */
function stressCorrelationOf(points: NavPoint[]): number | null {
  const paired: Array<{ p: number; b: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], cur = points[i];
    if (prev.benchNav == null || cur.benchNav == null) continue;
    if (prev.nav <= 0 || prev.benchNav <= 0) continue;
    paired.push({
      p: (cur.nav - prev.nav) / prev.nav,
      b: (cur.benchNav - prev.benchNav) / prev.benchNav,
    });
  }
  if (paired.length < 4) return null;
  const cutoffCount = Math.max(2, Math.floor(paired.length * STRESS_QUANTILE));
  const worst = [...paired].sort((x, y) => x.b - y.b).slice(0, cutoffCount);
  if (worst.length < 2) return null;

  const mp = mean(worst.map((w) => w.p));
  const mb = mean(worst.map((w) => w.b));
  let num = 0, dp = 0, db = 0;
  for (const w of worst) {
    const a = w.p - mp, c = w.b - mb;
    num += a * c; dp += a * a; db += c * c;
  }
  const den = Math.sqrt(dp * db);
  return den > 0 ? num / den : null;
}
