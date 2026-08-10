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
  // Extended indicators (v2 scoring upgrades)
  ema200: number | null;           // EMA(200), null if <200 candles
  macdLine: number | null;         // EMA12 - EMA26
  macdSignal: number | null;       // EMA9 of macdLine series
  macdHistogram: number | null;    // macdLine - macdSignal
  adx14: number | null;            // Average Directional Index (14), null if <28 candles
  rsVsSpy: number | null;          // stock 12M return / benchmark 12M return ratio
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

/** Compute MACD (12/26/9) from close prices. Null if <27 closes. */
function computeMACD(closes: number[]): { macdLine: number | null; macdSignal: number | null; macdHistogram: number | null } {
  const nil = { macdLine: null, macdSignal: null, macdHistogram: null };
  if (closes.length < 27) return nil;
  const ema12arr = computeEMA(closes, 12);
  const ema26arr = computeEMA(closes, 26);
  // ema12arr starts at index 11, ema26arr at index 25 — align by taking the tail
  const offset = ema12arr.length - ema26arr.length;
  const macdSeries: number[] = ema26arr.map((e26, i) => ema12arr[i + offset] - e26);
  if (macdSeries.length < 9) return nil;
  const signalArr = computeEMA(macdSeries, 9);
  if (signalArr.length === 0) return nil;
  const macdLine = macdSeries[macdSeries.length - 1];
  const macdSignal = signalArr[signalArr.length - 1];
  return {
    macdLine: parseFloat(macdLine.toFixed(4)),
    macdSignal: parseFloat(macdSignal.toFixed(4)),
    macdHistogram: parseFloat((macdLine - macdSignal).toFixed(4)),
  };
}

/** Compute Wilder ADX(14) from candles. Null if <28 candles. */
function computeADX14(candles: Candle[]): number | null {
  if (candles.length < 28) return null;
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  const period = 14;
  // Wilder smoothing (initial = simple sum, then rolling)
  let smoothTr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr: number[] = [];
  if (smoothTr > 0) {
    const diPlus = 100 * smoothPlus / smoothTr;
    const diMinus = 100 * smoothMinus / smoothTr;
    const denom = diPlus + diMinus;
    if (denom > 0) dxArr.push(100 * Math.abs(diPlus - diMinus) / denom);
  }
  for (let i = period; i < trs.length; i++) {
    smoothTr = smoothTr - smoothTr / period + trs[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i];
    if (!(smoothTr > 0)) continue;
    const diPlus = 100 * smoothPlus / smoothTr;
    const diMinus = 100 * smoothMinus / smoothTr;
    const denom = diPlus + diMinus;
    if (denom > 0) dxArr.push(100 * Math.abs(diPlus - diMinus) / denom);
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx * (period - 1) + dxArr[i]) / period;
  return Number.isFinite(adx) ? parseFloat(adx.toFixed(2)) : null;
}

/** Compute all technical indicators from candle array (oldest first) */
export function computeTechnicals(candles: Candle[], benchmarkCloses?: number[]): TechnicalResult {
  const empty: TechnicalResult = { rsi14: null, ema20: null, ema50: null, priceVsEma20: null, priceVsEma50: null, volumeVsAvg20: null, trend20d: null, dataPoints: candles.length, atr14: null, lastReturnPct: null, lastRangeLocation: null, atrMultipleMove: null, ema200: null, macdLine: null, macdSignal: null, macdHistogram: null, adx14: null, rsVsSpy: null };
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

  // EMA-200 — long-term trend filter
  const ema200arr = candles.length >= 200 ? computeEMA(closes, 200) : [];
  const ema200 = ema200arr.length > 0 ? parseFloat(ema200arr[ema200arr.length - 1].toFixed(4)) : null;

  // MACD (12/26/9)
  const { macdLine, macdSignal, macdHistogram } = computeMACD(closes);

  // ADX(14)
  const adx14 = computeADX14(candles);

  // RS vs benchmark: (stock 12M return) / (benchmark 12M return), up to 252 bars
  let rsVsSpy: number | null = null;
  if (benchmarkCloses && benchmarkCloses.length >= 252) {
    const window = Math.min(candles.length, benchmarkCloses.length, 252);
    if (window >= 2) {
      const stockFirst = closes[closes.length - window];
      const stockLast = latest;
      const benchFirst = benchmarkCloses[benchmarkCloses.length - window];
      const benchLast = benchmarkCloses[benchmarkCloses.length - 1];
      if (stockFirst > 0 && benchFirst > 0 && benchLast > 0) {
        const stockReturn = stockLast / stockFirst - 1;
        const benchReturn = benchLast / benchFirst - 1;
        // Avoid division by near-zero benchmark
        if (Math.abs(benchReturn) > 0.001) {
          rsVsSpy = parseFloat((stockReturn / benchReturn).toFixed(3));
        }
      }
    }
  }

  return { rsi14, ema20, ema50, priceVsEma20, priceVsEma50, volumeVsAvg20, trend20d, dataPoints: candles.length, atr14, lastReturnPct, lastRangeLocation, atrMultipleMove, ema200, macdLine, macdSignal, macdHistogram, adx14, rsVsSpy };
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
 * Vetoes when either strong condition fires. A weak close is returned separately
 * as a warning. Exported for unit tests and auditability.
 */
export function detectBreakdownVeto(t: TechnicalResult): { vetoed: boolean; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];

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

  // Close in the bottom quartile remains diagnostic context, not a hard veto.
  if (t.lastReturnPct != null && t.lastReturnPct < 0 && t.lastRangeLocation != null && t.lastRangeLocation <= VETO_CLOSE_LOCATION) {
    // Diagnostic only. Production outcome labels did not support treating an
    // ordinary weak close as equivalent to an ATR/volume-confirmed breakdown.
    warnings.push(`Weak close: finished at ${(t.lastRangeLocation * 100).toFixed(0)}% of bar range (bottom quartile) on a down day`);
  }

  return { vetoed: reasons.length > 0, reasons, warnings };
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

  // EMA-200 position (±10 pts) — long-term trend filter
  const latest200 = t.ema200;
  if (latest200 != null) {
    // Use ema20 as a proxy for latest price (both are from same candle series)
    const refClose = t.ema20; // not exact but directionally correct; ema200 is used as a relative marker
    // ponytail: use ema50 > ema200 as the proxy since ema20 may lag; simpler direction read
    if (t.priceVsEma50 != null) {
      // We know price vs ema50 and ema50 vs ema200 — use ema50 as bridge
      if (t.ema50 != null) {
        if (t.ema50 > latest200) score += 10; // price > EMA50 > EMA200 = bullish structure
        else score -= 10;
      }
    } else if (refClose != null) {
      if (refClose > latest200) score += 10;
      else score -= 10;
    }
  }

  // MACD histogram confirmation (±5 pts)
  if (t.macdHistogram != null) {
    if (t.macdHistogram > 0) score += 5;
    else score -= 5;
  }

  // RS vs benchmark (±8 pts) — outperforming the market = institutional support
  if (t.rsVsSpy != null) {
    if (t.rsVsSpy > 1.1) score += 8;
    else if (t.rsVsSpy > 1.0) score += 4;
    else if (t.rsVsSpy < 0.9) score -= 8;
    else if (t.rsVsSpy < 1.0) score -= 4;
  }

  // ADX trend-strength multiplier — not additive, scales the delta from neutral.
  // Trending market (ADX>25): momentum signals count more.
  // Ranging market (ADX<20): dampen momentum component by 25%.
  if (t.adx14 != null) {
    const delta = score - 50;
    if (t.adx14 >= 25) {
      score = 50 + Math.round(delta * 1.15);
    } else if (t.adx14 < 20) {
      score = 50 + Math.round(delta * 0.75);
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
