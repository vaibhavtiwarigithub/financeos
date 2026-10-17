// Pure candle -> feature math for the leveraged-ETF L1 shadow. Deliberately
// separate from lib/data/technicals.ts (which is scoring-oriented and returns
// categorical trend/no realized-vol/no dollar-volume) so this measure-only
// module has no path back into the scorer.
import type { Candle } from "@/lib/data/technicals";

export interface LeveragedShadowFeatures {
  realizedVol20dPct: number | null; // annualized stdev of daily returns, 20 sessions
  atr14Pct: number | null;          // Wilder ATR(14) as a % of the latest close
  trend20dPct: number | null;       // close[-1] vs close[-21], %
  dollarVolume: number | null;      // latest close * latest volume
}

/** SOXX/QQQ are observable proxies, not the funds' exact licensed target indices. */
export function computeLeveragedPathFeatures(
  etfCandles: Candle[], underlyingCandles: Candle[], direction: "long" | "inverse",
): { proxyTrackingRms20dPct: number | null; maxAbsOvernightGap20dPct: number | null } {
  const underlying = new Map(underlyingCandles.filter(c => Number.isFinite(c.close) && c.close > 0).map(c => [c.date, c]));
  const etfValid = etfCandles.filter(c => Number.isFinite(c.close) && c.close > 0);
  const aligned = etfValid.slice(-21);
  let proxyTrackingRms20dPct: number | null = null;
  // Require all 21 of the ETF's latest sessions to have a matching proxy bar.
  // Dropping an unmatched day would compare a multi-day ETF move to 3x a
  // multi-day proxy move, which is not the fund's daily-reset objective.
  if (aligned.length === 21 && aligned.every(c => underlying.has(c.date))) {
    const sign = direction === "inverse" ? -1 : 1;
    const errors: number[] = [];
    for (let i = 1; i < aligned.length; i++) {
      const prevEtf = aligned[i - 1], curEtf = aligned[i];
      const prevUnderlying = underlying.get(prevEtf.date)!, curUnderlying = underlying.get(curEtf.date)!;
      const etfReturn = curEtf.close / prevEtf.close - 1;
      const proxyReturn = sign * 3 * (curUnderlying.close / prevUnderlying.close - 1);
      errors.push((etfReturn - proxyReturn) * 100);
    }
    proxyTrackingRms20dPct = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length);
  }
  const etf = etfCandles.filter(c => Number.isFinite(c.close) && c.close > 0).slice(-21);
  let maxAbsOvernightGap20dPct: number | null = null;
  if (etf.length === 21 && etf.slice(1).every(c => Number.isFinite(c.open) && c.open > 0)) {
    maxAbsOvernightGap20dPct = Math.max(...etf.slice(1).map((c, i) => Math.abs(c.open / etf[i].close - 1) * 100));
  }
  return { proxyTrackingRms20dPct, maxAbsOvernightGap20dPct };
}

/** Wilder ATR(14) in price units. Mirrors lib/data/technicals.ts's atr14 so the
 * two never silently diverge on the same math; kept local because that module
 * returns it bundled with scoring-only fields this caller doesn't want. */
function atr14(candles: Candle[]): number | null {
  if (candles.length < 15) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const first14 = trueRanges.slice(0, 14);
  let atr = first14.reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < trueRanges.length; i++) atr = (atr * 13 + trueRanges[i]) / 14;
  return Number.isFinite(atr) ? atr : null;
}

const TRADING_DAYS_PER_YEAR = 252;

export function computeLeveragedShadowFeatures(candles: Candle[]): LeveragedShadowFeatures {
  const valid = candles.filter(c => Number.isFinite(c.close) && c.close > 0);
  const out: LeveragedShadowFeatures = { realizedVol20dPct: null, atr14Pct: null, trend20dPct: null, dollarVolume: null };
  if (valid.length === 0) return out;

  const last = valid[valid.length - 1];
  if (Number.isFinite(last.volume) && last.volume >= 0) out.dollarVolume = last.close * last.volume;

  if (valid.length >= 21) {
    const base = valid[valid.length - 21].close;
    if (base > 0) out.trend20dPct = ((last.close - base) / base) * 100;
  }

  if (valid.length >= 21) {
    const window = valid.slice(-21);
    const returns: number[] = [];
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1].close > 0) returns.push((window[i].close - window[i - 1].close) / window[i - 1].close);
    }
    if (returns.length >= 20) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      out.realizedVol20dPct = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
    }
  }

  const a = atr14(valid);
  if (a != null && last.close > 0) out.atr14Pct = (a / last.close) * 100;

  return out;
}

/** Pearson correlation of trailing-20-session daily returns between two
 * candle series. Informational only (owner asked to "understand the
 * relationship" between SOXL/TQQQ) -- never gates sizing or entry; the
 * leveraged-sleeve 5% NAV cap already bounds duplicate-factor risk
 * regardless of the measured correlation. */
export function correlation20d(a: Candle[], b: Candle[]): number | null {
  const returns = (candles: Candle[]): number[] => {
    const valid = candles.filter(c => Number.isFinite(c.close) && c.close > 0);
    if (valid.length < 21) return [];
    const window = valid.slice(-21);
    const out: number[] = [];
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1].close > 0) out.push((window[i].close - window[i - 1].close) / window[i - 1].close);
    }
    return out;
  };
  const ra = returns(a), rb = returns(b);
  if (ra.length < 20 || rb.length < 20 || ra.length !== rb.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (va <= 0 || vb <= 0) return null;
  const r = cov / Math.sqrt(va * vb);
  return Number.isFinite(r) ? r : null;
}
