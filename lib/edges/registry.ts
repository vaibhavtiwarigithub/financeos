// Edge/Factor Discovery P0 — the edge library. PRICE/VOLUME ONLY. MEASURE-ONLY.
// Every edge is a pure function of candles sliced to <= asOf (no look-ahead, no
// fundamentals). Returns null on insufficient data. Cross-sectional z-scoring is
// applied later (standardize.ts); these return RAW values.
import type { EdgeDef, EdgeContext } from "@/lib/edges/types";
import { computeTechnicals, scoreTechnicals } from "@/lib/data/technicals";

const closesOf = (ctx: EdgeContext) => ctx.candles.map(c => c.close);
const last = <T,>(a: T[]) => a[a.length - 1];

function sma(vals: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += vals[i];
  return s / period;
}

// Daily simple returns of a close series.
function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) r.push(closes[i] / closes[i - 1] - 1);
  }
  return r;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function emaAligned(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function wilderAtr(candles: EdgeContext["candles"], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = candles[i - 1].close;
    trs.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    ));
  }
  let atr = trs.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function macdHistogramAtr(ctx: EdgeContext): number | null {
  const closes = closesOf(ctx);
  const fast = emaAligned(closes, 12);
  const slow = emaAligned(closes, 26);
  const macd = closes
    .map((_, i) => fast[i] != null && slow[i] != null ? fast[i]! - slow[i]! : null)
    .filter((value): value is number => value != null);
  if (macd.length < 9) return null;
  const signal = emaAligned(macd, 9);
  const signalLatest = signal[signal.length - 1];
  const atr = wilderAtr(ctx.candles, 14);
  if (signalLatest == null || atr == null) return null;
  const histogram = macd[macd.length - 1] - signalLatest;
  const normalized = histogram / atr;
  return Number.isFinite(normalized) ? normalized : null;
}

function signedAdx(ctx: EdgeContext, period = 14): number | null {
  if (ctx.candles.length < period * 2) return null;
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < ctx.candles.length; i++) {
    const current = ctx.candles[i];
    const previous = ctx.candles[i - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }

  let smoothedTr = trs.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedPlus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedMinus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dx: number[] = [];
  let latestPlusDi = 0;
  let latestMinusDi = 0;

  for (let i = period - 1; i < trs.length; i++) {
    if (i >= period) {
      smoothedTr = smoothedTr - smoothedTr / period + trs[i];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[i];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[i];
    }
    if (!(smoothedTr > 0)) continue;
    latestPlusDi = 100 * smoothedPlus / smoothedTr;
    latestMinusDi = 100 * smoothedMinus / smoothedTr;
    const denominator = latestPlusDi + latestMinusDi;
    if (denominator > 0) dx.push(100 * Math.abs(latestPlusDi - latestMinusDi) / denominator);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  const signed = (latestPlusDi >= latestMinusDi ? 1 : -1) * adx / 100;
  return Number.isFinite(signed) ? signed : null;
}

const TRADING_YEAR = 252;

export const EDGES: EdgeDef[] = [
  {
    id: "kairos_technical_score_v1",
    name: "Kairos technical composite v1",
    category: "technical",
    expectedSign: 1,
    horizonDays: 10,
    minCandles: 50,
    rationale: "The exact production technical composite as a measure-only edge: RSI(14), EMA20/50 position, 20-day trend, directional volume confirmation, and the breakdown veto.",
    dataSource: "daily adjusted candles",
    references: ["Kairos Decision 51; lib/data/technicals.ts"],
    compute: (ctx) => scoreTechnicals(computeTechnicals(ctx.candles)),
  },
  {
    id: "macd_atr_12_26_9",
    name: "ATR-normalized MACD histogram (12/26/9)",
    category: "technical",
    expectedSign: 1,
    horizonDays: 10,
    minCandles: 35,
    rationale: "MACD trend acceleration normalized by the stock's own Wilder ATR so nominal price and volatility scale do not dominate the cross-section.",
    dataSource: "daily adjusted OHLC candles",
    references: ["Appel MACD; Wilder ATR"],
    compute: macdHistogramAtr,
  },
  {
    id: "signed_adx_14",
    name: "Signed ADX(14) trend strength",
    category: "technical",
    expectedSign: 1,
    horizonDays: 10,
    minCandles: 28,
    rationale: "Wilder ADX trend strength signed positive when +DI exceeds -DI and negative otherwise; tests whether trend strength adds information beyond EMA position.",
    dataSource: "daily adjusted OHLC candles",
    references: ["Wilder ADX/DMI"],
    compute: signedAdx,
  },
  {
    id: "mom_12_1",
    name: "12-1 Momentum (skip last month)",
    category: "technical",
    expectedSign: 1,
    horizonDays: 21,
    minCandles: 253,
    rationale: "Cross-sectional momentum: past 12-month return excluding the most recent month persists (Jegadeesh-Titman); skipping the last month avoids short-term reversal.",
    dataSource: "daily adjusted candles",
    references: ["Jegadeesh & Titman 1993", "Asness/AQR momentum"],
    compute: (ctx) => {
      const c = closesOf(ctx); const n = c.length;
      if (n < 253) return null;
      const c21 = c[n - 22], c252 = c[n - 253];
      return c252 > 0 ? c21 / c252 - 1 : null;
    },
  },
  {
    id: "rel_strength_6m",
    name: "Relative strength vs benchmark (6m)",
    category: "technical",
    expectedSign: 1,
    horizonDays: 21,
    minCandles: 127,
    rationale: "6-month return minus the market benchmark's 6-month return — long-only relative strength; leaders tend to keep leading.",
    dataSource: "daily adjusted candles + benchmark",
    references: ["Relative strength / cross-sectional momentum"],
    compute: (ctx) => {
      const c = closesOf(ctx); const b = ctx.benchmark.map(x => x.close);
      if (c.length < 127 || b.length < 127) return null;
      const sym = c[c.length - 1] / c[c.length - 127] - 1;
      const bench = b[b.length - 1] / b[b.length - 127] - 1;
      return sym - bench;
    },
  },
  {
    id: "dma_trend_slope",
    name: "50/200 DMA trend + slope",
    category: "technical",
    expectedSign: 1,
    horizonDays: 20,
    minCandles: 220,
    rationale: "Trend regime: SMA50 above SMA200 (golden-cross state) plus the 20-day slope of SMA50 — captures established, still-accelerating uptrends.",
    dataSource: "daily adjusted candles",
    references: ["Trend-following / moving-average regime literature"],
    compute: (ctx) => {
      const c = closesOf(ctx); const n = c.length;
      if (n < 220) return null;
      const sma50 = sma(c, 50, n - 1);
      const sma200 = sma(c, 200, n - 1);
      const sma50Prev = sma(c, 50, n - 21);
      if (sma50 == null || sma200 == null || sma50Prev == null || sma200 <= 0 || sma50Prev <= 0) return null;
      const trend = sma50 / sma200 - 1;
      const slope = sma50 / sma50Prev - 1;
      return trend + slope;
    },
  },
  {
    id: "vol_adj_mom_6m",
    name: "Volatility-adjusted momentum (6m)",
    category: "technical",
    expectedSign: 1,
    horizonDays: 21,
    minCandles: 127,
    rationale: "6-month return divided by realized volatility (63d, annualized) — risk-adjusted momentum favors steady trends over lottery-like spikes.",
    dataSource: "daily adjusted candles",
    references: ["Risk-adjusted momentum"],
    compute: (ctx) => {
      const c = closesOf(ctx); const n = c.length;
      if (n < 127) return null;
      const ret = c[n - 1] / c[n - 127] - 1;
      const rets63 = dailyReturns(c.slice(n - 64));
      const vol = stdev(rets63) * Math.sqrt(TRADING_YEAR);
      return vol > 0 ? ret / vol : null;
    },
  },
  {
    id: "st_reversal_uptrend",
    name: "Short-term reversal in uptrend",
    category: "technical",
    expectedSign: 1,
    horizonDays: 5,
    minCandles: 51,
    rationale: "In an uptrend (close > SMA50), a short-term (5-day) pullback tends to bounce — buy the dip within the trend. Value = negative 5-day return; only applies while trending.",
    dataSource: "daily adjusted candles",
    references: ["Short-term reversal; Connors/Alvarez pullback"],
    compute: (ctx) => {
      const c = closesOf(ctx); const n = c.length;
      if (n < 51) return null;
      const sma50 = sma(c, 50, n - 1);
      if (sma50 == null || last(c) <= sma50) return null; // not in uptrend → N/A
      const ret5 = c[n - 6] > 0 ? c[n - 1] / c[n - 6] - 1 : null;
      return ret5 == null ? null : -ret5;
    },
  },
  {
    id: "high_52w_proximity",
    name: "52-week-high proximity",
    category: "technical",
    expectedSign: 1,
    horizonDays: 20,
    minCandles: 252,
    rationale: "Closeness to the 52-week high (close / max high over 252d). Nearness-to-high predicts continuation (George & Hwang 52-week-high momentum).",
    dataSource: "daily adjusted candles",
    references: ["George & Hwang 2004 (52-week high)"],
    compute: (ctx) => {
      const n = ctx.candles.length;
      if (n < 252) return null;
      const win = ctx.candles.slice(n - 252);
      const hh = Math.max(...win.map(c => c.high));
      const close = last(ctx.candles).close;
      return hh > 0 ? close / hh : null;
    },
  },
  {
    id: "volume_breakout",
    name: "Volume breakout (today vs 20d avg)",
    category: "volume",
    expectedSign: 1,
    horizonDays: 10,
    minCandles: 21,
    rationale: "Today's volume relative to its 20-day average — a surge signals conviction/accumulation. Computed ONLY when the last 21 volumes are all present and positive (else null: incomplete volume data).",
    dataSource: "daily candles (volume)",
    references: ["Volume confirmation / accumulation"],
    compute: (ctx) => {
      const n = ctx.candles.length;
      if (n < 21) return null;
      const win = ctx.candles.slice(n - 21); // today + prior 20
      if (win.some(c => !Number.isFinite(c.volume) || c.volume <= 0)) return null; // incomplete
      const today = win[win.length - 1].volume;
      const prior20 = win.slice(0, 20).map(c => c.volume);
      const avg = prior20.reduce((a, b) => a + b, 0) / prior20.length;
      return avg > 0 ? today / avg : null;
    },
  },
  {
    id: "low_realized_vol",
    name: "Low realized volatility (63d)",
    category: "technical",
    expectedSign: -1, // lower vol = more attractive (low-vol anomaly)
    horizonDays: 20,
    minCandles: 64,
    rationale: "Realized daily volatility over 63 days, annualized. The low-volatility anomaly: lower-vol names have historically earned better risk-adjusted returns. expected_sign = -1 (lower is better).",
    dataSource: "daily adjusted candles",
    references: ["Low-volatility anomaly (Baker, Bradley & Wurgler)"],
    compute: (ctx) => {
      const c = closesOf(ctx); const n = c.length;
      if (n < 64) return null;
      const rets = dailyReturns(c.slice(n - 64));
      return stdev(rets) * Math.sqrt(TRADING_YEAR);
    },
  },
];

export const EDGE_BY_ID: Record<string, EdgeDef> = Object.fromEntries(EDGES.map(e => [e.id, e]));
