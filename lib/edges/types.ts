// Edge/Factor Discovery P0 — types. MEASURE-ONLY.
// An "edge" is a deterministic, price/volume-only function of a symbol's candle
// history as-of a date. No fundamentals, no LLM, no look-ahead: compute() only
// ever sees candles dated <= asOf. Returns null when data is insufficient.
import type { Candle } from "@/lib/data/technicals";

export type Market = "us" | "india";

export interface EdgeContext {
  symbol: string;
  market: Market;
  asOf: string;        // YYYY-MM-DD — candles are sliced to <= this date
  candles: Candle[];   // ascending, sliced to <= asOf
  benchmark: Candle[]; // ascending benchmark candles sliced to <= asOf
}

export interface EdgeDef {
  id: string;
  name: string;
  category: "technical" | "volume";
  expectedSign: 1 | -1;   // +1: higher raw = more attractive; -1: lower = better
  horizonDays: number;
  minCandles: number;
  rationale: string;
  dataSource: string;
  references: string[];
  /** Pure: raw edge value for this symbol as-of ctx.asOf, or null if insufficient. */
  compute: (ctx: EdgeContext) => number | null;
}

// One computed (symbol, edge) cell before/after cross-sectional standardization.
export interface EdgeCell {
  symbol: string;
  edgeId: string;
  raw: number;
  z: number | null;   // filled by standardize() across the cross-section
  source: string;     // candle provider
}
