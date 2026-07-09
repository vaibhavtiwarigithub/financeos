// Edge/Factor Discovery P0 — the edge library. PRICE/VOLUME ONLY. MEASURE-ONLY.
// Every edge is a pure function of candles sliced to <= asOf (no look-ahead, no
// fundamentals). Returns null on insufficient data. Cross-sectional z-scoring is
// applied later (standardize.ts); these return RAW values.
import type { EdgeDef, EdgeContext } from "@/lib/edges/types";

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

const TRADING_YEAR = 252;

export const EDGES: EdgeDef[] = [
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
