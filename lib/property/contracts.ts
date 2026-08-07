import type { PropertyMarketId } from "@/lib/property/registry";

export type PropertyMetric =
  | "price_index" | "rent_index" | "inventory" | "days_on_market"
  | "mortgage_rate" | "employment" | "income";

export type PropertyObservation = {
  sourceKey: string;
  market: PropertyMarketId;
  metric: PropertyMetric;
  nativeUnit: string;
  value: number;
  asOf: string;
  publishedAt: string | null;
  sourceVersion: string | null;
  revisionState: "initial" | "revised";
};

/**
 * An adapter can normalize an official release but cannot make an activation
 * decision. The future worker must require an active, audited source record.
 */
export interface PropertySourceAdapter {
  readonly sourceKey: string;
  fetch(input: { market: PropertyMarketId; since: string | null }): Promise<PropertyObservation[]>;
}

export type PropertyForecast = {
  market: PropertyMarketId;
  metric: "price_index" | "rent_index" | "mortgage_rate";
  horizonDays: number;
  cutoffAt: string;
  lower: number;
  base: number;
  upper: number;
  modelVersion: string;
  state: "shadow" | "retired";
};
