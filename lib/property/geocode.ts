export type PropertyAddress = {
  addressLine: string;
  city: string;
  region: string;
  postalCode: string;
};

export type PropertyGeocode = {
  state: "resolved" | "no_match" | "ambiguous" | "unavailable";
  source: "us_census";
  asOf: string;
  matchedAddress?: string;
  postalCode?: string;
  countyName?: string;
  countyGeoid?: string;
};

type CensusMatch = {
  matchedAddress?: string;
  addressComponents?: { zip?: string };
  geographies?: Record<string, Array<{ NAME?: string; GEOID?: string }>>;
};

export function parseCensusGeocode(payload: unknown, asOf = new Date().toISOString()): PropertyGeocode {
  const matches = (payload as { result?: { addressMatches?: CensusMatch[] } })?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return { state: "no_match", source: "us_census", asOf };
  if (matches.length > 1) return { state: "ambiguous", source: "us_census", asOf };
  const match = matches[0];
  const counties = match.geographies?.Counties ?? match.geographies?.counties ?? [];
  return {
    state: "resolved",
    source: "us_census",
    asOf,
    matchedAddress: match.matchedAddress,
    postalCode: match.addressComponents?.zip,
    countyName: counties[0]?.NAME,
    countyGeoid: counties[0]?.GEOID,
  };
}

export async function geocodeUsPropertyAddress(address: PropertyAddress): Promise<PropertyGeocode> {
  const query = `${address.addressLine}, ${address.city}, ${address.region} ${address.postalCode}`;
  const url = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
  url.searchParams.set("address", query);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  url.searchParams.set("format", "json");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return { state: "unavailable", source: "us_census", asOf: new Date().toISOString() };
    return parseCensusGeocode(await response.json());
  } catch {
    return { state: "unavailable", source: "us_census", asOf: new Date().toISOString() };
  }
}
