import type { PropertyObservation, PropertySourceAdapter } from "@/lib/property/contracts";
import type { PropertyMarketId } from "@/lib/property/registry";

const FHFA_MASTER = "https://www.fhfa.gov/hpi/download/monthly/hpi_master.json";
const FRED_MORTGAGE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US";

export function createPropertyCollectionRun() {
  // Invocation-owned. Overlapping owner/cron requests cannot clear or share
  // one another's provider-call ledger through module-global state.
  const cache = new Map<string, Promise<{ body: string; lastModified: string | null }>>();
  return {
    fetchCount: () => cache.size,
    fetchText: async (url: string, init?: RequestInit): Promise<{ body: string; lastModified: string | null }> => {
      const key = `${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = (async () => {
          const response = await fetch(url, { ...init, cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return { body: await response.text(), lastModified: response.headers.get("last-modified") };
        })();
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

export function keepObservation(asOf: string, since: string | null, revisionState: "initial" | "revised"): boolean {
  if (revisionState === "revised") return true;
  return !since || asOf > since;
}

function quarterEnd(year: number, quarter: number): string {
  return new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
}

function parseSimpleCsv(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(line => {
    const cells: string[] = []; let value = ""; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(value); value = ""; }
      else value += char;
    }
    cells.push(value); return cells;
  });
}

type AdapterInput = Parameters<PropertySourceAdapter["fetch"]>[0];

export class PropertySourceUnavailableError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PropertySourceUnavailableError";
  }
}

export class FredMortgageAdapter implements PropertySourceAdapter {
  readonly sourceKey = "fred-mortgage";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: AdapterInput): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const { body, lastModified } = await input.fetchText(FRED_MORTGAGE, { signal: AbortSignal.timeout(20_000) });
    return parseSimpleCsv(body).slice(1).flatMap(([date, raw]) => {
      const value = Number(raw);
      if (!date || !Number.isFinite(value) || !keepObservation(date, input.since, "initial")) return [];
      return [{ sourceKey: this.sourceKey, market: input.market, metric: "mortgage_rate" as const, nativeUnit: "percent", value, asOf: date, publishedAt: null, sourceVersion: lastModified, revisionState: "initial" as const }];
    });
  }
}

type FhfaRow = { hpi_flavor?: string; frequency?: string; place_name?: string; yr?: number; period?: number; index_nsa?: number | null };
const FHFA_MARKET_MATCH: Record<Exclude<PropertyMarketId, "bengaluru">, RegExp> = {
  austin: /Austin-Round Rock/i,
  phoenix: /Phoenix-Mesa/i,
};

export class FhfaHpiAdapter implements PropertySourceAdapter {
  readonly sourceKey = "fhfa-hpi";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: AdapterInput): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const { body, lastModified } = await input.fetchText(FHFA_MASTER, { signal: AbortSignal.timeout(30_000) });
    const rows = JSON.parse(body) as FhfaRow[];
    const matcher = FHFA_MARKET_MATCH[input.market as Exclude<PropertyMarketId, "bengaluru">];
    return rows.flatMap(row => {
      if (row.frequency !== "quarterly" || !matcher.test(row.place_name ?? "") || row.hpi_flavor !== "all-transactions") return [];
      const value = Number(row.index_nsa); const year = Number(row.yr); const quarter = Number(row.period);
      if (!Number.isFinite(value) || !Number.isInteger(year) || quarter < 1 || quarter > 4) return [];
      const asOf = quarterEnd(year, quarter);
      if (!keepObservation(asOf, input.since, "initial")) return [];
      return [{ sourceKey: this.sourceKey, market: input.market, metric: "price_index" as const, nativeUnit: "FHFA index", value, asOf, publishedAt: null, sourceVersion: lastModified, revisionState: "initial" as const }];
    });
  }
}

const BLS_SERIES: Record<Exclude<PropertyMarketId, "bengaluru">, string> = {
  austin: "LAUMT481242000000003",
  phoenix: "LAUMT043806000000003",
};
// BLS permits a bounded 20-year request without a registration key. Retaining
// that full window gives future shadows enough local context while remaining
// below the provider's documented request horizon.
export const BLS_HISTORY_YEARS = 20;

export class BlsLausAdapter implements PropertySourceAdapter {
  readonly sourceKey = "bls-laus";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: AdapterInput): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const year = new Date().getUTCFullYear();
    const { body } = await input.fetchText("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesid: [BLS_SERIES[input.market as Exclude<PropertyMarketId, "bengaluru">]], startyear: String(year - (BLS_HISTORY_YEARS - 1)), endyear: String(year) }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = JSON.parse(body) as any; const series = json?.Results?.series?.[0]?.data;
    if (!Array.isArray(series)) throw new Error("BLS response missing series data");
    return series.flatMap((row: any) => {
      const month = Number(String(row.period ?? "").replace("M", "")); const yearValue = Number(row.year); const value = Number(row.value);
      if (!Number.isFinite(value) || month < 1 || month > 12 || !Number.isInteger(yearValue)) return [];
      const asOf = new Date(Date.UTC(yearValue, month, 0)).toISOString().slice(0, 10);
      const preliminary = Array.isArray(row.footnotes) && row.footnotes.some((f: any) => /preliminary/i.test(f?.text ?? ""));
      const revisionState = preliminary ? "initial" as const : "revised" as const;
      if (!keepObservation(asOf, input.since, revisionState)) return [];
      return [{ sourceKey: this.sourceKey, market: input.market, metric: "unemployment_rate" as const, nativeUnit: "percent", value, asOf, publishedAt: null, sourceVersion: preliminary ? "preliminary" : "revised", revisionState }];
    });
  }
}

const HUD_FMR_BASE = "https://www.huduser.gov/hudapi/public/fmr/data";
const HUD_FMR_ENTITY: Record<Exclude<PropertyMarketId, "bengaluru">, string> = {
  // HUD Metro FMR area identifiers use the documented METRO<CBSA>M<CBSA>
  // form. These are Austin-Round Rock-Georgetown and Phoenix-Mesa-Chandler.
  austin: "METRO12420M12420",
  phoenix: "METRO38060M38060",
};

type HudFmrPayload = {
  data?: {
    year?: string | number;
    basicdata?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
};

const HUD_BEDROOMS = [
  ["Efficiency", "studio", "rent_reference_studio"], ["One-Bedroom", "one_bedroom", "rent_reference_one_bedroom"],
  ["Two-Bedroom", "two_bedroom", "rent_reference_two_bedroom"], ["Three-Bedroom", "three_bedroom", "rent_reference_three_bedroom"],
  ["Four-Bedroom", "four_bedroom", "rent_reference_four_bedroom"],
] as const;

/**
 * Official HUD Fair Market Rent data, deliberately bounded to the two current
 * US metro workspaces. This describes an area-level affordability reference;
 * it must never become a property rent estimate or valuation input.
 */
export class HudFmrAdapter implements PropertySourceAdapter {
  readonly sourceKey = "hud-fmr";
  constructor(private readonly token = () => process.env.HUD_FMR_API_TOKEN?.trim() ?? "") {}
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }

  async fetch(input: AdapterInput): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const token = this.token();
    if (!token) throw new PropertySourceUnavailableError(
      "hud_fmr_token_unconfigured",
      "HUD FMR is unavailable: HUD_FMR_API_TOKEN is not configured on the server",
    );
    const entity = HUD_FMR_ENTITY[input.market as Exclude<PropertyMarketId, "bengaluru">];
    const { body, lastModified } = await input.fetchText(`${HUD_FMR_BASE}/${entity}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = JSON.parse(body) as HudFmrPayload;
    const year = Number(payload.data?.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new PropertySourceUnavailableError("hud_fmr_invalid_response", "HUD FMR response has no valid FMR year");
    }
    // Metro FMR is returned as one object. If HUD marks a metro as SAFMR, the
    // response may include a ZIP array; this bounded adapter intentionally uses
    // only its explicit MSA-level row and never accepts a ZIP or address.
    const basic = Array.isArray(payload.data?.basicdata)
      ? payload.data?.basicdata.find((row) => row["zip_code"] === "MSA level")
      : payload.data?.basicdata;
    if (!basic || typeof basic !== "object") {
      throw new PropertySourceUnavailableError("hud_fmr_invalid_response", "HUD FMR response has no metro reference values");
    }
    const asOf = `${year}-10-01`;
    if (!keepObservation(asOf, input.since, "initial")) return [];
    return HUD_BEDROOMS.flatMap(([field, bedroom, metric]) => {
      const value = Number(basic[field]);
      if (!Number.isFinite(value) || value <= 0) return [];
      return [{
        sourceKey: this.sourceKey,
        market: input.market,
        metric,
        nativeUnit: `USD/month ${bedroom}`,
        value,
        asOf,
        publishedAt: null,
        sourceVersion: `HUD FMR ${year}`,
        revisionState: "initial" as const,
      }];
    });
  }
}

export const ACTIVE_PROPERTY_ADAPTERS: PropertySourceAdapter[] = [new FhfaHpiAdapter(), new FredMortgageAdapter(), new BlsLausAdapter(), new HudFmrAdapter()];
