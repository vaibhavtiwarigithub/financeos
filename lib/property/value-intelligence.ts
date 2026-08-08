import { buildPropertyBaselineForecast, inferPeriodsForward, type SeriesPoint } from "./forecast";

export const VALUE_KINDS = ["purchase_price", "owner_estimate", "documented_appraisal", "observed_sale", "county_appraised_reference", "county_assessed_reference", "owner_comparable"] as const;
export type ValueKind = typeof VALUE_KINDS[number];
export const VALUE_PROVENANCE = ["owner_entered", "owner_document", "official_reference"] as const;
export type ValueProvenance = typeof VALUE_PROVENANCE[number];

export type ValueEvidencePayload = { amount: number; sourceLabel?: string; rationale?: string };
export type ValueScenario = { horizonYears: 1 | 3 | 5; lower: number; base: number; upper: number; method: string; sourcePoints: number };

export function indexAdjustedReference(amount: number, baseIndex: number, latestIndex: number): number | null {
  if (![amount, baseIndex, latestIndex].every((value) => Number.isFinite(value) && value > 0)) return null;
  return amount * latestIndex / baseIndex;
}

export function buildValueScenarios(reference: number, points: SeriesPoint[]): ValueScenario[] {
  if (!Number.isFinite(reference) || reference <= 0 || points.length < 6) return [];
  const latest = points[points.length - 1]?.value;
  if (!Number.isFinite(latest) || latest <= 0) return [];
  return ([1, 3, 5] as const).flatMap((horizonYears) => {
    const periods = inferPeriodsForward(points, horizonYears * 365);
    if (!periods) return [];
    const forecast = buildPropertyBaselineForecast(points, periods);
    if (!forecast) return [];
    return [{ horizonYears, lower: reference * forecast.lower / latest, base: reference * forecast.base / latest, upper: reference * forecast.upper / latest, method: forecast.method, sourcePoints: forecast.sampleSize }];
  });
}
