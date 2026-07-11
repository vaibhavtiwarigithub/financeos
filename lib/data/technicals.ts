/**
 * Deterministic Technical Indicators — Phase 0
 * All computed from OHLCV candles. No LLM, no API calls.
 */

export interface Candle {
  date: string;
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
}

export interface TechnicalResult {
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  priceVsEma20: "above" | "below" | null;
  priceVsEma50: "above" | "below" | null;
  volumeVsAvg20: number | null;  // ratio: 1.5 = 50% above avg
  trend20d: "up" | "down" | "flat" | null; // price today vs 20 days ago
  dataPoints: number;
  // Recent-bar / volatility diagnostics — optional so existing consumers that
  // destructure the older shape keep working. Populated by computeTechnicals;
  // consumed by the deterministic breakdown veto (see detectBreakdownVeto).
  atr14: number | null;            // Wilder ATR(14), price units. Null if <15 candles.
  lastReturnPct: number | null;    // single most-recent bar % change vs prev close
  lastRangeLocation: number | null; // where latest close sits in its bar range: 0=low, 1=high
  atrMultipleMove: number | null;  // |last bar move| / atr14 — how many ATRs the last bar moved
}

/** Compute EMA from close prices. period must be <= closes.length */
function computeEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const emas: number[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emas.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

/** Compute RSI(14) from close prices */
function computeRSI14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const period = 14;
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * 13 + gains[i]) / 14;
    avgLoss = (avgLoss * 13 + losses[i]) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

/**
 * Compute Wilder ATR(14) from candles (oldest first). Returns null if <15
 * candles (need 14 True-Range values, each of which needs a prior close).
 * TR = max(high-low, |high-prevClose|, |low-prevClose|) — captures gap risk,
 * which a plain high-low range misses.
 */
function computeATR14(candles: Candle[]): number | null {
  if (candles.length < 15) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * 13 + trs[i]) / 14;
  }
  return parseFloat(atr.toFixed(4));
}

/** Compute all technical indicators from candle array (oldest first) */
export function computeTechnicals(candles: Candle[]): TechnicalResult {
  const empty: TechnicalResult = { rsi14: null, ema20: null, ema50: null, priceVsEma20: null, priceVsEma50: null, volumeVsAvg20: null, trend20d: null, dataPoints: candles.length, atr14: null, lastReturnPct: null, lastRangeLocation: null, atrMultipleMove: null };
  if (candles.length < 15) return empty;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const latest = closes[closes.length - 1];

  const rsi14 = computeRSI14(closes);

  const ema20arr = computeEMA(closes, 20);
  const ema20 = ema20arr.length > 0 ? parseFloat(ema20arr[ema20arr.length - 1].toFixed(4)) : null;

  const ema50arr = candles.length >= 50 ? computeEMA(closes, 50) : [];
  const ema50 = ema50arr.length > 0 ? parseFloat(ema50arr[ema50arr.length - 1].toFixed(4)) : null;

  const priceVsEma20 = ema20 != null ? (latest > ema20 ? "above" : "below") : null;
  const priceVsEma50 = ema50 != null ? (latest > ema50 ? "above" : "below") : null;

  // Volume vs 20-day average
  const vol20 = volumes.slice(-21, -1);
  const avgVol20 = vol20.length > 0 ? vol20.reduce((a, b) => a + b, 0) / vol20.length : null;
  const volumeVsAvg20 = avgVol20 && avgVol20 > 0 ? parseFloat((volumes[volumes.length - 1] / avgVol20).toFixed(2)) : null;

  // 20-day trend
  let trend20d: "up" | "down" | "flat" | null = null;
  if (candles.length >= 21) {
    const price20dAgo = closes[closes.length - 21];
    const changePct = (latest - price20dAgo) / price20dAgo;
    trend20d = changePct > 0.03 ? "up" : changePct < -0.03 ? "down" : "flat";
  }

  // Recent-bar / volatility diagnostics — feed the breakdown veto. All from the
  // most-recent bar and the one before it, plus ATR(14) for volatility scaling.
  const atr14 = computeATR14(candles);
  const prevClose = closes[closes.length - 2];
  const lastReturnPct = prevClose > 0 ? parseFloat((((latest - prevClose) / prevClose) * 100).toFixed(4)) : null;

  const lastBar = candles[candles.length - 1];
  const lastRange = lastBar.high - lastBar.low;
  const lastRangeLocation = lastRange > 0 ? parseFloat(((lastBar.close - lastBar.low) / lastRange).toFixed(4)) : null;

  const atrMultipleMove = atr14 != null && atr14 > 0 ? parseFloat((Math.abs(latest - prevClose) / atr14).toFixed(4)) : null;

  return { rsi14, ema20, ema50, priceVsEma20, priceVsEma50, volumeVsAvg20, trend20d, dataPoints: candles.length, atr14, lastReturnPct, lastRangeLocation, atrMultipleMove };
}

// Piecewise-linear interpolation over (x, y) anchor points (x ascending).
// Continuous — avoids the score cliffs a bucketed if/else creates (e.g. RSI
// 59→+12 vs 60→+25 previously made a fairly-momentum stock jump 13 pts on a
// 1-point RSI move).
function lerpAnchors(x: number, anchors: [number, number][]): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

// RSI(14) → contribution, continuous. Same intent as the old buckets — momentum
// sweet spot ~60-72 (+25), oversold breakdown <35 (~-20), overbought warning
// >75 declining toward -15 — but interpolated so there are no cliffs.
const RSI_ANCHORS: [number, number][] = [
  [20, -20], [35, -16], [45, -5], [50, 2], [55, 12],
  [60, 25], [72, 25], [75, 6], [85, -10], [100, -15],
];

// Breakdown-veto thresholds. These are deliberately conservative defaults, NOT
// fitted values. They MUST be validated prospectively per liquidity bucket
// (large-cap ATR% behaves very differently from micro-cap / meme names) before
// being trusted as a hard gate — a 2.5-ATR bar is routine noise in some names
// and a genuine regime break in others. Treat as v0 guardrails, not final.
const VETO_ATR_MULTIPLE = 2.5;     // last bar moved >= 2.5 ATRs (abnormal move)
const VETO_HV_RETURN_PCT = -7;     // single-bar drop of >= 7%
const VETO_HV_VOLUME_RATIO = 1.5;  // on >= 1.5x average volume (volume shock)
const VETO_CLOSE_LOCATION = 0.25;  // close in the bottom quartile of the bar's range

/**
 * Deterministic breakdown veto. Detects the crash / meme-breakdown pattern that
 * momentum scoring rewards by accident: after a sharp high-volume reversal RSI
 * decays back into the "preferred" band, price still sits just above EMA20, and
 * heavy selling volume gets read as bullish confirmation — producing a false
 * high score. This runs as a hard gate BEFORE any momentum math.
 *
 * Vetoes when ANY condition fires. Exported so it can be unit-tested and reused
 * by an exit/quarantine monitor. Returns the fired reasons for auditability.
 */
export function detectBreakdownVeto(t: TechnicalResult): { vetoed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1) Volatility-adjusted crash: an abnormally large down-move relative to the
  //    stock's own recent volatility (ATR). Down day AND >= 2.5 ATRs of range.
  if (t.lastReturnPct != null && t.lastReturnPct < 0 && t.atrMultipleMove != null && t.atrMultipleMove >= VETO_ATR_MULTIPLE) {
    reasons.push(`Volatility-adjusted crash: last bar fell ${t.atrMultipleMove.toFixed(1)} ATRs (>= ${VETO_ATR_MULTIPLE})`);
  }

  // 2) High-volume breakdown: a big single-bar drop on a volume shock — the
  //    classic distribution / capitulation bar that momentum wrongly confirms.
  if (t.lastReturnPct != null && t.lastReturnPct <= VETO_HV_RETURN_PCT && t.volumeVsAvg20 != null && t.volumeVsAvg20 >= VETO_HV_VOLUME_RATIO) {
    reasons.push(`High-volume breakdown: ${t.lastReturnPct.toFixed(1)}% drop on ${t.volumeVsAvg20.toFixed(1)}x volume`);
  }

  // 3) Close in bottom quartile after a down day: sellers controlled the close,
  //    price finished near the low of its range — weak, not a dip to buy.
  if (t.lastReturnPct != null && t.lastReturnPct < 0 && t.lastRangeLocation != null && t.lastRangeLocation <= VETO_CLOSE_LOCATION) {
    reasons.push(`Weak close: finished at ${(t.lastRangeLocation * 100).toFixed(0)}% of bar range (bottom quartile) on a down day`);
  }

  return { vetoed: reasons.length > 0, reasons };
}

/** Score cap applied when the breakdown veto fires (quarantine, not zero). */
const BREAKDOWN_VETO_SCORE_CAP = 20;

/**
 * Score technicals 0-100 deterministically.
 * No LLM involved. Based on RSI, EMA position, trend, and volume confirmation.
 */
export function scoreTechnicals(t: TechnicalResult): number {
  if (t.dataPoints < 15) return 50; // insufficient data → neutral

  // Crash / meme-breakdown veto — runs FIRST, before any momentum math. After a
  // sharp high-volume reversal the momentum signals turn falsely bullish (RSI
  // decays into the sweet spot, price clings just above EMA20, trend still
  // positive, heavy sell volume misread as confirmation), which previously
  // scored a -12% high-volume reversal a 100. When the deterministic veto fires
  // we hard-cap the score at 20 to quarantine the name. Not 0: downstream
  // availability logic treats 0 specially, and 20 is an unambiguous "broken"
  // read that still flows through normal scoring/ranking.
  if (detectBreakdownVeto(t).vetoed) {
    return BREAKDOWN_VETO_SCORE_CAP;
  }

  let score = 50; // baseline neutral

  // RSI contribution (continuous, ~±25 pts)
  if (t.rsi14 != null) score += lerpAnchors(t.rsi14, RSI_ANCHORS);

  // EMA50 position (±15 pts)
  if (t.priceVsEma50 === "above") score += 15;
  else if (t.priceVsEma50 === "below") score -= 15;

  // EMA20 position (±10 pts)
  if (t.priceVsEma20 === "above") score += 10;
  else if (t.priceVsEma20 === "below") score -= 10;

  // 20-day trend (±10 pts)
  if (t.trend20d === "up") score += 10;
  else if (t.trend20d === "down") score -= 10;

  // Volume confirmation (±8 pts) — was computed but never scored. Elevated
  // volume CONFIRMS the prevailing direction: a move up on heavy volume is
  // stronger conviction, a decline on heavy volume is more bearish. Direction
  // read from EMA20 position / 20d trend; a neutral/conflicting context applies
  // no volume effect (volume is directionless on its own).
  if (t.volumeVsAvg20 != null) {
    const bullish = t.priceVsEma20 === "above" || t.trend20d === "up";
    const bearish = t.priceVsEma20 === "below" || t.trend20d === "down";
    if (bullish && !bearish) {
      if (t.volumeVsAvg20 >= 1.5) score += 8;
      else if (t.volumeVsAvg20 >= 1.2) score += 4;
    } else if (bearish && !bullish) {
      if (t.volumeVsAvg20 >= 1.5) score -= 8;
      else if (t.volumeVsAvg20 >= 1.2) score -= 4;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
