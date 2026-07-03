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

/** Compute all technical indicators from candle array (oldest first) */
export function computeTechnicals(candles: Candle[]): TechnicalResult {
  const empty: TechnicalResult = { rsi14: null, ema20: null, ema50: null, priceVsEma20: null, priceVsEma50: null, volumeVsAvg20: null, trend20d: null, dataPoints: candles.length };
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

  return { rsi14, ema20, ema50, priceVsEma20, priceVsEma50, volumeVsAvg20, trend20d, dataPoints: candles.length };
}

/**
 * Score technicals 0-100 deterministically.
 * No LLM involved. Based on RSI, EMA position, volume, trend.
 */
export function scoreTechnicals(t: TechnicalResult): number {
  if (t.dataPoints < 15) return 50; // insufficient data → neutral

  let score = 50; // baseline neutral

  // RSI contribution (±25 pts)
  if (t.rsi14 != null) {
    if (t.rsi14 >= 60 && t.rsi14 < 75) score += 25;       // momentum zone
    else if (t.rsi14 >= 50 && t.rsi14 < 60) score += 12;  // mild bullish
    else if (t.rsi14 >= 40 && t.rsi14 < 50) score -= 5;   // mild bearish
    else if (t.rsi14 < 35) score -= 20;                    // oversold/breakdown
    else if (t.rsi14 >= 75) score -= 10;                   // overbought warning
  }

  // EMA50 position (±15 pts)
  if (t.priceVsEma50 === "above") score += 15;
  else if (t.priceVsEma50 === "below") score -= 15;

  // EMA20 position (±10 pts)
  if (t.priceVsEma20 === "above") score += 10;
  else if (t.priceVsEma20 === "below") score -= 10;

  // 20-day trend (±10 pts)
  if (t.trend20d === "up") score += 10;
  else if (t.trend20d === "down") score -= 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}
