import type { PropertyMarketId } from "@/lib/property/registry";
import { countiesForMarket } from "@/lib/property/registry";
import { PropertySourceUnavailableError } from "@/lib/property/sources";

export type PropertyCountyObservation = {
  sourceKey: "census-acs";
  market: Exclude<PropertyMarketId, "bengaluru">;
  countyFips: string;
  metric: "median_household_income" | "median_gross_rent" | "median_home_value" | "rental_vacancy_rate";
  nativeUnit: "USD" | "percent";
  value: number;
  asOf: string;
  sourceVersion: string;
};

const ACS_VINTAGE = "2024";
const ACS_FIELDS = "NAME,B19013_001E,B25064_001E,B25077_001E,B25002_001E,B25004_001E";
const STATE_FIPS: Record<Exclude<PropertyMarketId, "bengaluru">, string> = { austin: "48", phoenix: "04" };

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 1_000_000_000 ? parsed : null;
}

/**
 * Annual ACS 5-year context, deliberately separate from market observations.
 * It is not a price feed and cannot produce a property or ZIP valuation.
 */
export class CensusAcsCountyAdapter {
  readonly sourceKey = "census-acs" as const;
  constructor(private readonly key = () => process.env.CENSUS_API_KEY?.trim() ?? "") {}
  supportsMarket(market: PropertyMarketId): market is Exclude<PropertyMarketId, "bengaluru"> { return market === "austin" || market === "phoenix"; }

  async fetch(input: { market: Exclude<PropertyMarketId, "bengaluru">; fetchText: (url: string, init?: RequestInit) => Promise<{ body: string; lastModified: string | null }> }): Promise<PropertyCountyObservation[]> {
    const key = this.key();
    if (!key) throw new PropertySourceUnavailableError("census_api_key_unconfigured", "Census ACS is unavailable: CENSUS_API_KEY is not configured on the server");
    const state = STATE_FIPS[input.market];
    let body: string;
    try {
      ({ body } = await input.fetchText(`https://api.census.gov/data/${ACS_VINTAGE}/acs/acs5?get=${ACS_FIELDS}&for=county:*&in=state:${state}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) }));
    } catch {
      throw new PropertySourceUnavailableError("census_transport_unavailable", "Census ACS county context is temporarily unavailable");
    }
    let rows: unknown; try { rows = JSON.parse(body); } catch { throw new PropertySourceUnavailableError("census_invalid_response", "Census ACS returned invalid JSON"); }
    if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) throw new PropertySourceUnavailableError("census_invalid_response", "Census ACS returned no tabular data");
    const header = rows[0].map(String); const required = ["B19013_001E", "B25064_001E", "B25077_001E", "B25002_001E", "B25004_001E", "state", "county"];
    if (required.some((name) => !header.includes(name))) throw new PropertySourceUnavailableError("census_invalid_response", "Census ACS response is missing required fields");
    const index = (name: string) => header.indexOf(name);
    const eligible = new Set(countiesForMarket(input.market).map((county) => county.countyFips));
    const asOf = `${ACS_VINTAGE}-12-31`; const sourceVersion = `ACS 5-year ${ACS_VINTAGE}`;
    const result: PropertyCountyObservation[] = [];
    for (const row of rows.slice(1)) {
      if (!Array.isArray(row)) continue;
      const countyFips = `${String(row[index("state")]).padStart(2, "0")}${String(row[index("county")]).padStart(3, "0")}`;
      if (!eligible.has(countyFips)) continue;
      const add = (metric: PropertyCountyObservation["metric"], raw: unknown, nativeUnit: PropertyCountyObservation["nativeUnit"]) => { const value = numeric(raw); if (value != null) result.push({ sourceKey: this.sourceKey, market: input.market, countyFips, metric, nativeUnit, value, asOf, sourceVersion }); };
      add("median_household_income", row[index("B19013_001E")], "USD");
      add("median_gross_rent", row[index("B25064_001E")], "USD");
      add("median_home_value", row[index("B25077_001E")], "USD");
      const total = numeric(row[index("B25002_001E")]); const vacant = numeric(row[index("B25004_001E")]);
      if (total && vacant != null) result.push({ sourceKey: this.sourceKey, market: input.market, countyFips, metric: "rental_vacancy_rate", nativeUnit: "percent", value: vacant / total * 100, asOf, sourceVersion });
    }
    return result;
  }
}

export const COUNTY_PROPERTY_ADAPTERS = [new CensusAcsCountyAdapter()];
