import type { Candle } from "@/lib/data/technicals";

export const CHART_PATTERN_SHADOW_VERSION = "double-reversal.close.v1";
export const CHART_PATTERN_CONFIG = Object.freeze({
  swingBars: 3,
  extremeTolerancePct: 0.02,
  minimumRetracementPct: 0.03,
  maxCandles: 60,
});

export type ChartPatternType = "double_top" | "double_bottom";
export type ChartPatternDetection = {
  patternType: ChartPatternType;
  swing1Date: string;
  swing1Price: number;
  swing2Date: string;
  swing2Price: number;
  necklineDate: string;
  necklinePrice: number;
  confirmationDate: string;
  confirmationPrice: number;
};

export type ChartPatternAttempt =
  | { status: "insufficient_candles"; candlesThroughDate: string | null }
  | { status: "no_pattern"; candlesThroughDate: string }
  | { status: "detected"; candlesThroughDate: string; pattern: ChartPatternDetection };

type Pivot = { index: number; price: number };

function pivots(closes: number[], kind: "high" | "low", radius: number): Pivot[] {
  const result: Pivot[] = [];
  for (let i = radius; i < closes.length - radius; i++) {
    const window = closes.slice(i - radius, i + radius + 1);
    const value = closes[i];
    const isPivot = kind === "high"
      ? window.every((candidate, offset) => offset === radius || value >= candidate)
      : window.every((candidate, offset) => offset === radius || value <= candidate);
    // Flat plateaus are not an unambiguous swing point.
    const tied = window.some((candidate, offset) => offset !== radius && candidate === value);
    if (isPivot && !tied) result.push({ index: i, price: value });
  }
  return result;
}
/**
 * Causal, close-only double reversal detector. Only completed, ordered bars are
 * used. Close-only geometry avoids mixing adjusted closes with raw OHLC around
 * splits in provider feeds. Confirmation must be the latest bar in the input.
 */
export function detectConfirmedDoubleReversal(input: Candle[]): ChartPatternAttempt {
  const candles = input
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((c, i, all) => i === 0 || c.date !== all[i - 1].date)
    .slice(-CHART_PATTERN_CONFIG.maxCandles);
  const through = candles.at(-1)?.date ?? null;
  const radius = CHART_PATTERN_CONFIG.swingBars;
  if (candles.length < Math.max(2 * radius + 1, 25)) return { status: "insufficient_candles", candlesThroughDate: through };

  const closes = candles.map((c) => c.close);
  const latest = candles.length - 1;
  // A pivot needs bars on both sides. The newest pivot used in a pattern must
  // have formed before confirmation; the final bar can only confirm it.
  const highs = pivots(closes, "high", radius).filter((p) => p.index < latest);
  const lows = pivots(closes, "low", radius).filter((p) => p.index < latest);

  const candidates: Array<{ pattern: ChartPatternDetection; confirmationIndex: number }> = [];
  for (let a = 0; a < highs.length; a++) {
    for (let b = a + 1; b < highs.length; b++) {
      const first = highs[a], second = highs[b];
      if (second.index - first.index < 2 * radius + 1) continue;
      const trough = lows.filter((p) => p.index > first.index && p.index < second.index)
        .sort((a, b) => a.price - b.price)[0];
      if (!trough) continue;
      const meanTop = (first.price + second.price) / 2;
      if (Math.abs(first.price - second.price) / meanTop > CHART_PATTERN_CONFIG.extremeTolerancePct) continue;
      if ((meanTop - trough.price) / meanTop < CHART_PATTERN_CONFIG.minimumRetracementPct) continue;
      if (closes[latest] >= trough.price) continue;
      candidates.push({
        confirmationIndex: latest,
        pattern: {
          patternType: "double_top", swing1Date: candles[first.index].date, swing1Price: first.price,
          swing2Date: candles[second.index].date, swing2Price: second.price,
          necklineDate: candles[trough.index].date, necklinePrice: trough.price,
          confirmationDate: candles[latest].date, confirmationPrice: closes[latest],
        },
      });
    }
  }
  for (let a = 0; a < lows.length; a++) {
    for (let b = a + 1; b < lows.length; b++) {
      const first = lows[a], second = lows[b];
      if (second.index - first.index < 2 * radius + 1) continue;
      const peak = highs.filter((p) => p.index > first.index && p.index < second.index)
        .sort((a, b) => b.price - a.price)[0];
      if (!peak) continue;
      const meanBottom = (first.price + second.price) / 2;
      if (Math.abs(first.price - second.price) / meanBottom > CHART_PATTERN_CONFIG.extremeTolerancePct) continue;
      if ((peak.price - meanBottom) / meanBottom < CHART_PATTERN_CONFIG.minimumRetracementPct) continue;
      if (closes[latest] <= peak.price) continue;
      candidates.push({
        confirmationIndex: latest,
        pattern: {
          patternType: "double_bottom", swing1Date: candles[first.index].date, swing1Price: first.price,
          swing2Date: candles[second.index].date, swing2Price: second.price,
          necklineDate: candles[peak.index].date, necklinePrice: peak.price,
          confirmationDate: candles[latest].date, confirmationPrice: closes[latest],
        },
      });
    }
  }
  const selected = candidates.sort((a, b) => b.pattern.swing2Date.localeCompare(a.pattern.swing2Date))[0];
  return selected
    ? { status: "detected", candlesThroughDate: through!, pattern: selected.pattern }
    : { status: "no_pattern", candlesThroughDate: through! };
}

/** Student-t two-sided 95% interval for small independent-block samples. */
export function studentT95Critical(df: number): number {
  const table = [
    0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (!Number.isInteger(df) || df < 1) return Number.POSITIVE_INFINITY;
  if (df < table.length) return table[df];
  // Cornish-Fisher expansion around the standard-normal 97.5th percentile.
  // Unlike substituting 1.96, this retains the heavier small-sample tail for df>30.
  const z = 1.959963984540054;
  const d = df;
  return z
    + (z ** 3 + z) / (4 * d)
    + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * d ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * d ** 3);
}

export function summarizeIndependentPatternBlocks(blockMeans: number[]) {
  const values = blockMeans.filter(Number.isFinite);
  if (values.length < 2) return { blocks: values.length, mean: values.length ? values[0] : null, ciLower: null, ciUpper: null, status: "insufficient" as const };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = studentT95Critical(values.length - 1) * Math.sqrt(variance / values.length);
  const ciLower = mean - margin, ciUpper = mean + margin;
  const status = values.length < 20 ? "insufficient" as const : ciLower > 0 ? "validated" as const : ciUpper < 0 ? "contradicted" as const : "undetermined" as const;
  return { blocks: values.length, mean, ciLower, ciUpper, status };
}

export function summarizeChartPatternEvidence(input: {
  sessions: string[];
  events: Array<{ session: string; patternType: ChartPatternType; benchmarkNeutralReturn: number | null }>;
  horizonDays: number;
}) {
  const sessionIndex = new Map([...new Set(input.sessions)].sort().map((session, index) => [session, index]));
  const bySession = new Map<number, number[]>();
  let maturedEvents = 0;
  for (const event of input.events) {
    const index = sessionIndex.get(event.session);
    const value = event.benchmarkNeutralReturn;
    if (index == null || value == null || !Number.isFinite(value)) continue;
    maturedEvents++;
    const signedReturn = event.patternType === "double_bottom" ? value : -value;
    const values = bySession.get(index) ?? [];
    values.push(signedReturn);
    bySession.set(index, values);
  }
  const byBlock = new Map<number, number[]>();
  for (const [sessionIndex, values] of bySession) {
    const block = Math.floor(sessionIndex / input.horizonDays);
    const sessions = byBlock.get(block) ?? [];
    sessions.push(values.reduce((sum, value) => sum + value, 0) / values.length);
    byBlock.set(block, sessions);
  }
  const blockMeans = [...byBlock.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    events: input.events.length,
    maturedEvents,
    independentBlocks: summarizeIndependentPatternBlocks(blockMeans),
  };
}
