// Pure math for the global-spillover shadow (Phase 0 — measure-only).
// A session's close-to-close % change, computed the same way regardless of
// which foreign index or US/India cash market it comes from, so every series
// in exogenous_observations is directly comparable.
import type { Candle } from "@/lib/data/technicals";

export interface SessionChange {
  sessionDate: string;   // the LATER of the two sessions (the one being measured)
  priorDate: string;
  close: number;
  priorClose: number;
  changePct: number;
}

/** Close-to-close % change of the most recent completed session vs the one
 * before it. Returns null if there aren't at least 2 candles or either close
 * is non-positive — never divides by zero or fabricates a change from one bar. */
export function latestSessionChangePct(candles: Candle[]): SessionChange | null {
  const valid = candles.filter(c => Number.isFinite(c.close) && c.close > 0 && c.date);
  if (valid.length < 2) return null;
  const last = valid[valid.length - 1];
  const prior = valid[valid.length - 2];
  if (prior.close <= 0) return null;
  return {
    sessionDate: last.date,
    priorDate: prior.date,
    close: last.close,
    priorClose: prior.close,
    changePct: ((last.close - prior.close) / prior.close) * 100,
  };
}
