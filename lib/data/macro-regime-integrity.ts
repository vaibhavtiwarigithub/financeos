export type MacroSignal = "green" | "yellow" | "orange" | "red";

export interface MacroIndicatorEvidence {
  name: string;
  value: number | null;
  signal: MacroSignal;
  description: string;
  weight: number;
}

export const MACRO_INDICATOR_WEIGHTS = Object.freeze({
  "Yield Curve (10Y-2Y)": 3,
  "Sahm Rule": 3,
  "Nonfarm Payrolls": 2,
  "Real GDP Growth": 2,
  "CPI Inflation": 1,
  "Retail Sales": 2,
  "Federal Funds Rate": 2,
  "Durable Goods Orders": 1,
} as const);

export const MACRO_INDICATOR_UNIVERSE = Object.keys(MACRO_INDICATOR_WEIGHTS).length;
export const MACRO_STRUCTURAL_WEIGHT = Object.values(MACRO_INDICATOR_WEIGHTS)
  .reduce((sum, weight) => sum + weight, 0);
export const MIN_MACRO_INDICATORS = 6;
export const MIN_MACRO_WEIGHT_COVERAGE = 0.75;

const SIGNAL_ORDINAL: Record<MacroSignal, number> = {
  green: 0, yellow: 1, orange: 2, red: 3,
};

export interface MacroIntegrity {
  validIndicators: MacroIndicatorEvidence[];
  indicatorsAvailable: number;
  availableWeight: number;
  dataConfidence: number;
  usable: boolean;
  reason: string | null;
}

/** Validate the complete structural input contract; missing inputs are never
 * silently renormalized away and duplicate/unknown dimensions add no weight. */
export function assessMacroIndicators(raw: unknown): MacroIntegrity {
  const rawIsArray = Array.isArray(raw);
  const rows = rawIsArray ? raw : [];
  const seen = new Set<string>();
  const validIndicators: MacroIndicatorEvidence[] = [];

  for (const candidate of rows) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const name = String(row.name ?? "");
    const expectedWeight = MACRO_INDICATOR_WEIGHTS[name as keyof typeof MACRO_INDICATOR_WEIGHTS];
    const signal = String(row.signal ?? "") as MacroSignal;
    if (!expectedWeight || !(signal in SIGNAL_ORDINAL) || seen.has(name)) continue;
    if (Number(row.weight) !== expectedWeight) continue;
    seen.add(name);
    validIndicators.push({
      name,
      value: row.value == null ? null : Number(row.value),
      signal,
      description: String(row.description ?? ""),
      weight: expectedWeight,
    });
  }

  const availableWeight = validIndicators.reduce((sum, row) => sum + row.weight, 0);
  const dataConfidence = availableWeight / MACRO_STRUCTURAL_WEIGHT;
  const indicatorsAvailable = validIndicators.length;
  const usable = indicatorsAvailable >= MIN_MACRO_INDICATORS
    && dataConfidence >= MIN_MACRO_WEIGHT_COVERAGE;
  const reason = usable ? null
    : !rawIsArray ? "unverifiable raw_indicators (expected an array)"
    : `coverage ${indicatorsAvailable}/${MACRO_INDICATOR_UNIVERSE}, structural weight ${(dataConfidence * 100).toFixed(0)}% `
      + `(requires >=${MIN_MACRO_INDICATORS} indicators and >=${Math.round(MIN_MACRO_WEIGHT_COVERAGE * 100)}%)`;

  return { validIndicators, indicatorsAvailable, availableWeight, dataConfidence, usable, reason };
}

export function computeMacroRegime(raw: unknown): {
  danger_score: number | null;
  regime: "green" | "yellow" | "orange" | "red" | "unknown";
  signals_triggered: number;
  indicators_available: number;
  data_confidence: number;
  unavailable_reason: string | null;
} {
  const integrity = assessMacroIndicators(raw);
  const signals_triggered = integrity.validIndicators
    .filter((indicator) => indicator.signal !== "green").length;
  if (!integrity.usable) {
    return {
      danger_score: null,
      regime: "unknown",
      signals_triggered: 0,
      indicators_available: integrity.indicatorsAvailable,
      data_confidence: integrity.dataConfidence,
      unavailable_reason: integrity.reason,
    };
  }

  const numerator = integrity.validIndicators.reduce(
    (sum, indicator) => sum + SIGNAL_ORDINAL[indicator.signal] * indicator.weight,
    0,
  );
  // Structural denominator is always all applicable dimensions. Missing inputs
  // contribute no danger points; confidence separately exposes that absence.
  const danger_score = Math.round((numerator / (3 * MACRO_STRUCTURAL_WEIGHT)) * 100);
  let regime: "green" | "yellow" | "orange" | "red" = "green";
  if (danger_score >= 60) regime = "red";
  else if (danger_score >= 40) regime = "orange";
  else if (danger_score >= 20) regime = "yellow";

  const highSignals = integrity.validIndicators.filter(
    (indicator) => indicator.weight === 3 && (indicator.signal === "red" || indicator.signal === "orange"),
  );
  if (highSignals.length >= 2 && regime === "yellow") regime = "orange";

  return {
    danger_score,
    regime,
    signals_triggered,
    indicators_available: integrity.indicatorsAvailable,
    data_confidence: integrity.dataConfidence,
    unavailable_reason: null,
  };
}
