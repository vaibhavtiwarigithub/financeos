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
  { id: "census-acs", name: "Census ACS 5-year", markets: ["austin", "phoenix"], cadence: "Annual", coverage: "Metro income, rent, and value estimates", role: "Economic and affordability context", officialUrl: "https://www.census.gov/data/developers/data-sets/acs-5year.html", state: "contract_pending" },
  { id: "hud-fmr", name: "HUD FMR / SAFMR", markets: ["austin", "phoenix"], cadence: "Annual", coverage: "Area rent-reference ranges", role: "Rental affordability reference", officialUrl: "https://www.huduser.gov/portal/dataset/fmr-api.html", state: "contract_pending" },
  { id: "rbi-hpi", name: "Reserve Bank of India HPI", markets: ["bengaluru"], cadence: "Quarterly", coverage: "Published Bengaluru HPI and policy context", role: "Independent price and financing reference", officialUrl: "https://data.rbi.org.in/", state: "manual_only" },
  { id: "nhb-residex", name: "NHB RESIDEX", markets: ["bengaluru"], cadence: "Quarterly", coverage: "Published housing, land, and rent indices", role: "Deep-link only pending written reuse permission", officialUrl: "https://residex.nhbonline.org.in/Dashboard/About", state: "deferred" },
];

export function marketById(id: string | undefined): PropertyMarket {
  return PROPERTY_MARKETS.find((market) => market.id === id) ?? PROPERTY_MARKETS[0];
}

export function sourcesForMarket(market: PropertyMarketId): PropertySource[] {
  return PROPERTY_SOURCES.filter((source) => source.markets.includes(market));
}
