export type PropertyMarketId = "austin" | "phoenix" | "bengaluru";

export type PropertyMarket = {
  id: PropertyMarketId;
  label: string;
  region: string;
  country: "US" | "IN";
  currency: "USD" | "INR";
  localUnit: string;
  scope: string;
};

export type PropertyMetroCounty = {
  market: Exclude<PropertyMarketId, "bengaluru">;
  countyFips: string;
  countyName: string;
};

export type PropertySource = {
  id: string;
  name: string;
  markets: PropertyMarketId[];
  cadence: string;
  coverage: string;
  role: string;
  officialUrl: string;
  state: "active" | "contract_pending" | "manual_only" | "deferred";
};

export const PROPERTY_MARKETS: PropertyMarket[] = [
  {
    id: "austin",
    label: "Austin",
    region: "Central Texas",
    country: "US",
    currency: "USD",
    localUnit: "Metro, county, ZIP",
    scope: "Austin Metro and an owner-managed ZIP watchlist",
  },
  {
    id: "phoenix",
    label: "Phoenix",
    region: "Arizona Metro",
    country: "US",
    currency: "USD",
    localUnit: "Metro, county, ZIP",
    scope: "Phoenix Metro and an owner-managed ZIP watchlist",
  },
  {
    id: "bengaluru",
    label: "Bengaluru",
    region: "Karnataka",
    country: "IN",
    currency: "INR",
    localUnit: "City, locality, PIN, ward",
    scope: "Bengaluru and an owner-managed locality registry",
  },
];

export const PROPERTY_SOURCES: PropertySource[] = [
  { id: "fhfa-hpi", name: "FHFA House Price Index", markets: ["austin", "phoenix"], cadence: "Quarterly", coverage: "Published metro price trends", role: "Repeat-sales price context", officialUrl: "https://www.fhfa.gov/data/hpi", state: "active" },
  { id: "fred-mortgage", name: "Freddie Mac via FRED", markets: ["austin", "phoenix"], cadence: "Weekly", coverage: "US national mortgage-rate context", role: "Affordability context", officialUrl: "https://fred.stlouisfed.org/series/MORTGAGE30US", state: "active" },
  { id: "bls-laus", name: "BLS Local Area Unemployment", markets: ["austin", "phoenix"], cadence: "Monthly", coverage: "Metro unemployment rate, preliminary and revised", role: "Employment context", officialUrl: "https://www.bls.gov/lau/", state: "active" },
  { id: "redfin-data-center", name: "Redfin Data Center", markets: ["austin", "phoenix"], cadence: "Weekly metro / monthly ZIP", coverage: "Published aggregate market conditions", role: "Inventory and demand context", officialUrl: "https://www.redfin.com/news/data-center/", state: "contract_pending" },
  { id: "census-acs", name: "Census ACS 5-year", markets: ["austin", "phoenix"], cadence: "Annual", coverage: "Every declared metro county: income, rent, value and vacancy context", role: "County affordability context, not sale-price evidence", officialUrl: "https://www.census.gov/data/developers/data-sets/acs-5year.html", state: "contract_pending" },
  { id: "hud-fmr", name: "HUD FMR / SAFMR", markets: ["austin", "phoenix"], cadence: "Annual", coverage: "Metro FMR by bedroom count; no ZIP or property estimate", role: "Area rental affordability reference; server token required", officialUrl: "https://www.huduser.gov/portal/dataset/fmr-api.html", state: "contract_pending" },
  { id: "rbi-hpi", name: "Reserve Bank of India HPI", markets: ["bengaluru"], cadence: "Quarterly", coverage: "Published Bengaluru HPI and policy context", role: "Independent price and financing reference", officialUrl: "https://data.rbi.org.in/", state: "contract_pending" },
  { id: "nhb-residex", name: "NHB RESIDEX", markets: ["bengaluru"], cadence: "Quarterly", coverage: "Published housing, land, and rent indices", role: "Deep-link only pending written reuse permission", officialUrl: "https://residex.nhbonline.org.in/Dashboard/About", state: "deferred" },
];

// Coverage is explicit rather than inferred from a city label. FHFA/BLS/FRED
// are MSA-level, while county evidence must carry its own FIPS scope.
export const PROPERTY_METRO_COUNTIES: PropertyMetroCounty[] = [
  { market: "austin", countyFips: "48021", countyName: "Bastrop County" },
  { market: "austin", countyFips: "48055", countyName: "Caldwell County" },
  { market: "austin", countyFips: "48209", countyName: "Hays County" },
  { market: "austin", countyFips: "48453", countyName: "Travis County" },
  { market: "austin", countyFips: "48491", countyName: "Williamson County" },
  { market: "phoenix", countyFips: "04013", countyName: "Maricopa County" },
  { market: "phoenix", countyFips: "04021", countyName: "Pinal County" },
];

export function countiesForMarket(market: PropertyMarketId): PropertyMetroCounty[] {
  return market === "bengaluru" ? [] : PROPERTY_METRO_COUNTIES.filter((county) => county.market === market);
}

export function marketById(id: string | undefined): PropertyMarket {
  return PROPERTY_MARKETS.find((market) => market.id === id) ?? PROPERTY_MARKETS[0];
}

export function sourcesForMarket(market: PropertyMarketId): PropertySource[] {
  return PROPERTY_SOURCES.filter((source) => source.markets.includes(market));
}
