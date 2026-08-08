import type { PropertyMarketId } from "@/lib/property/registry";

export type PropertyMetric =
  | "price_index" | "rent_index" | "inventory" | "days_on_market"
  | "mortgage_rate" | "employment" | "unemployment_rate" | "income"
  // HUD FMR is an area affordability reference, not a rent index, comp, or
  // property-level rent estimate. Keeping it distinct prevents a future
  // forecast or underwriting path from treating it as observed market rent.
  | "rent_reference_studio" | "rent_reference_one_bedroom"
  | "rent_reference_two_bedroom" | "rent_reference_three_bedroom"
  | "rent_reference_four_bedroom";

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
  /**
   * Whether this source can cover a market AT ALL.
   *
   * Kept separate from returning zero rows so the collector can report
   * `not_applicable` instead of `success`. FHFA, FRED and BLS are US-only; a run
   * that reported "success, 0 rows" for Bengaluru made a structural coverage gap
   * look like a source that simply had nothing new, which is the dishonest
   * market-local reporting the feature contract forbids.
   */
  supportsMarket(market: PropertyMarketId): boolean;
  fetch(input: {
    market: PropertyMarketId;
    since: string | null;
    fetchText: (url: string, init?: RequestInit) => Promise<{ body: string; lastModified: string | null }>;
  }): Promise<PropertyObservation[]>;
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
