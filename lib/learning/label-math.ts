// Pure label computation extracted from label-maturation/route.ts — no DB, no
// fetch, so it's directly unit-testable against a hand-built candle fixture.

export interface LabelCandle { date: string; close: number; high: number; low: number }

export interface ComputedLabel {
  fwdReturn: number;
  benchmarkNeutralReturn: number | null;
  maxAdverseExcursion: number;
  maxFavorableExcursion: number;
  entryPrice: number;
  exitPrice: number;
  entryAtr: number | null;
  entryAtrPct: number | null;
  maxAdverseExcursionAtr: number | null;
  maxFavorableExcursionAtr: number | null;
}

export const LABEL_COST_HAIRCUT = 0.001; // 10bps round-trip

// candlesAfterEntry: candles strictly AFTER the entry date, chronological, at
// least horizonDays long (caller is responsible for maturity — this just computes).
export function computeLabel(
  entryPrice: number,
  candlesAfterEntry: LabelCandle[],
  horizonDays: number,
  benchmarkReturn?: number | null,
  entryAtr?: number | null
): ComputedLabel | null {
  if (entryPrice <= 0 || candlesAfterEntry.length < horizonDays) return null;

  const window = candlesAfterEntry.slice(0, horizonDays);
  const exitPrice = window[window.length - 1].close;
  const fwdReturn = (exitPrice - entryPrice) / entryPrice - LABEL_COST_HAIRCUT;
  const mae = Math.min(...window.map(c => (c.low - entryPrice) / entryPrice), 0);
  const mfe = Math.max(...window.map(c => (c.high - entryPrice) / entryPrice), 0);
  const validEntryAtr = entryAtr != null && Number.isFinite(entryAtr) && entryAtr > 0 ? entryAtr : null;

  return {
    fwdReturn,
    benchmarkNeutralReturn: benchmarkReturn != null ? fwdReturn - benchmarkReturn : null,
    maxAdverseExcursion: mae,
    maxFavorableExcursion: mfe,
    entryPrice,
    exitPrice,
    entryAtr: validEntryAtr,
    entryAtrPct: validEntryAtr != null ? validEntryAtr / entryPrice : null,
    maxAdverseExcursionAtr: validEntryAtr != null
      ? Math.min(...window.map(c => (c.low - entryPrice) / validEntryAtr), 0)
      : null,
    maxFavorableExcursionAtr: validEntryAtr != null
      ? Math.max(...window.map(c => (c.high - entryPrice) / validEntryAtr), 0)
      : null,
  };
}
