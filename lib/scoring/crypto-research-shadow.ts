import type { Candle } from "@/lib/data/technicals";

export type CryptoResearchShadow = {
  trendScore: number;
  structureScore: number;
  volatilityScore: number;
  atrPct: number;
  structuralStopPct: number;
  close: number;
  sessionDate: string;
};

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, low = 0, high = 100): number {
  return Math.max(low, Math.min(high, value));
}

function ema(values: number[], period: number): number {
  const start = average(values.slice(0, period));
  const alpha = 2 / (period + 1);
  return values.slice(period).reduce((result, value) => value * alpha + result * (1 - alpha), start);
}

/**
 * Daily-bar-only evidence for the crypto-native shadow lane. This is not an
 * executable score: its caller must still supply a broker quote/spread before
 * scoreCryptoShadow may admit it. Keeping daily evidence separate makes the
 * missing intraday/quote contract visible instead of silently borrowing equity
 * dimensions or inventing a mid-price.
 */
export function deriveCryptoResearchShadow(candles: readonly Candle[]): CryptoResearchShadow | null {
  const usable = candles.filter((candle) =>
    Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) && candle.close > 0 && candle.high >= candle.low && candle.low > 0,
  );
  if (usable.length < 51) return null;

  const closes = usable.map((candle) => candle.close);
  const close = closes.at(-1)!;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const recent = usable.slice(-20);
  const prior = usable.slice(-21, -1);
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const trueRanges = usable.slice(-20).map((candle, index) => {
    const previousClose = usable[usable.length - 21 + index]?.close ?? candle.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const atrPct = (average(trueRanges) / close) * 100;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;

  // Positive short/intermediate trend gets credit; no raw return is used as a
  // score because a violent one-day jump is execution risk, not alpha.
  const trendScore = clamp(50 + (close >= ema20 ? 20 : -20) + (ema20 >= ema50 ? 20 : -20) + ((close / ema50 - 1) * 200));
  // Reward a completed breakout/retest structure, not merely being close to a
  // high. The prior high excludes the current candle to prevent look-ahead.
  const structureScore = clamp(50 + (close >= priorHigh ? 25 : 0) + ((close - recentLow) / Math.max(recentHigh - recentLow, close * 0.001)) * 25);
  // A tradeable daily regime has meaningful but bounded movement. This is a
  // regime suitability measure, not a reward for maximum volatility.
  const volatilityScore = clamp(100 - Math.abs(atrPct - 4) * 16);
  const structuralStopPct = ((close - recentLow) / close) * 100;
  if (!Number.isFinite(structuralStopPct) || structuralStopPct <= 0) return null;

  return {
    trendScore: Math.round(trendScore * 100) / 100,
    structureScore: Math.round(structureScore * 100) / 100,
    volatilityScore: Math.round(volatilityScore * 100) / 100,
    atrPct: Math.round(atrPct * 100) / 100,
    structuralStopPct: Math.round(structuralStopPct * 100) / 100,
    close,
    sessionDate: usable.at(-1)!.date,
  };
}
