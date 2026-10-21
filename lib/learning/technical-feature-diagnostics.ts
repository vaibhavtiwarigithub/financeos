import { computeSpearmanIC } from "@/lib/validation/feature-check";
import { sessionDistanceT, SCORE_STATISTICS_VERSION } from "@/lib/score-variants/core";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import { fingerprint } from "@/lib/analytics/alpha-diagnostic-contract";

export type FeaturePoint = { id: number; symbol: string; day: string; ts: string; formula: string; family?: string; technical: Record<string, unknown>; outcome: number };
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const varies = (v: number[]) => v.length > 1 && v.some((n) => n !== v[0]);
const flag = (v: number | null, test: (n: number) => boolean) => v == null ? null : Number(test(v));
export type DiagnosticDefinition = { id: string; binary: boolean; value: (t: Record<string, unknown>) => number | null };
const histogramAtr = (t: Record<string, unknown>) => {
  const hist = number(t.macdHistogram), atr = number(t.atr14);
  return hist != null && atr != null && atr > 0 ? hist / atr : null;
};
const bullCross = (t: Record<string, unknown>, above: boolean) => {
  const line = number(t.macdLine);
  if (line == null || !["bullish", "bearish", "none"].includes(String(t.macdSignalCross))) return null;
  return Number(t.macdSignalCross === "bullish" && (above ? line > 0 : line < 0));
};
/** Frozen family: changing a threshold/operator means a NEW diagnostic version.
 * Crossovers require explicitly recorded consecutive-candle state, not an
 * inference from sparse daily research observations.
 */
export const TECHNICAL_DIAGNOSTIC_VERSION = "rsi-macd-fixed-family-v2-stratified";
export const TECHNICAL_FEATURES: readonly DiagnosticDefinition[] = [
  { id: "rsi14_level", binary: false, value: (t) => number(t.rsi14) },
  { id: "rsi14_below30", binary: true, value: (t) => flag(number(t.rsi14), (v) => v < 30) },
  { id: "rsi14_50_to70", binary: true, value: (t) => flag(number(t.rsi14), (v) => v >= 50 && v <= 70) },
  { id: "rsi14_above70", binary: true, value: (t) => flag(number(t.rsi14), (v) => v > 70) },
  { id: "macd_histogram_atr", binary: false, value: histogramAtr },
  { id: "macd_above_signal", binary: true, value: (t) => flag(number(t.macdHistogram), (v) => v > 0) },
  { id: "macd_line_above_zero", binary: true, value: (t) => flag(number(t.macdLine), (v) => v > 0) },
  { id: "macd_bull_cross_below_zero", binary: true, value: (t) => bullCross(t, false) },
  { id: "macd_bull_cross_above_zero", binary: true, value: (t) => bullCross(t, true) },
];

export function technicalFeatureDiagnostics(points: readonly FeaturePoint[], market: "us" | "india", horizon: number, singleSymbol: boolean, definitions: readonly DiagnosticDefinition[] = TECHNICAL_FEATURES) {
  const groups = [...new Set(points.map((p) => JSON.stringify([p.formula, p.family ?? "legacy/unknown"])))].sort();
  return groups.flatMap((group) => {
    const [formula, family] = JSON.parse(group) as [string, string];
    // Fix the observation slot BEFORE checking feature availability. Otherwise
    // an earlier complete run silently replaces a later missing measurement.
    const slots = new Map<string, FeaturePoint>();
    for (const p of [...points].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id)) {
      if (p.formula !== formula || (p.family ?? "legacy/unknown") !== family || !Number.isFinite(p.outcome)) continue;
      slots.set(`${p.day}:${p.symbol}`, p);
    }
    const frozenSlots = [...slots.values()].sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol));
    return definitions.map((def) => {
    let rows = frozenSlots.flatMap((p) => {
      const value = def.value(p.technical);
      return value == null || !Number.isFinite(value) ? [] : [{ ...p, value }];
    });
    const availablePoints = rows.length;
    if (singleSymbol) {
      let lastDay: string | null = null;
      rows = rows.filter((r) => {
        if (lastDay != null) {
          try { if (expectedMarketSessionsBetween(market, lastDay, r.day).length < horizon) return false; }
          catch { return false; }
        }
        lastDay = r.day; return true;
      });
    }
    const dates = new Map<string, typeof rows>();
    for (const r of rows) { const items = dates.get(r.day) ?? []; items.push(r); dates.set(r.day, items); }
    const sessionIcs: Array<{ day: string; value: number }> = [];
    if (!singleSymbol) for (const [day, items] of dates) {
      if (items.length < 5 || !varies(items.map((r) => r.value)) || !varies(items.map((r) => r.outcome))) continue;
      const ic = computeSpearmanIC(items.map((r) => r.value), items.map((r) => r.outcome));
      if (ic) sessionIcs.push({ day, value: ic.ic });
    }
    const ic = singleSymbol
      ? rows.length >= 5 && varies(rows.map((r) => r.value)) && varies(rows.map((r) => r.outcome))
        ? computeSpearmanIC(rows.map((r) => r.value), rows.map((r) => r.outcome))?.ic ?? null : null
      : mean(sessionIcs.map((r) => r.value));
    const enough = !singleSymbol && sessionIcs.length >= 20 && sessionIcs.length / horizon >= 12;
    const triggered = def.binary ? rows.filter((r) => r.value === 1) : [];
    const control = def.binary ? rows.filter((r) => r.value === 0) : [];
    const triggeredMean = mean(triggered.map((r) => r.outcome)), controlMean = mean(control.map((r) => r.outcome));
    return {
      feature: def.id, binary: def.binary, formula, family, availablePoints, observations: rows.length,
      statisticsVersion: SCORE_STATISTICS_VERSION,
      mode: singleSymbol ? "nonoverlapping_time_series" : "cross_sectional",
      qualifyingDates: singleSymbol ? rows.length : sessionIcs.length,
      rankIc: ic, descriptiveT: enough ? sessionDistanceT(sessionIcs, horizon, market) : null,
      triggered: triggered.length, control: control.length, triggeredMean, controlMean,
      contrast: triggeredMean != null && controlMean != null ? triggeredMean - controlMean : null,
      state: enough ? "exploratory_only" : "insufficient_evidence",
      sampleHash: fingerprint(rows.map((r) => ({ id: r.id, symbol: r.symbol, day: r.day, value: r.value, outcome: r.outcome, formula, family }))),
    };
  });
  });
}
