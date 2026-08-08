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

export class BlsLausAdapter implements PropertySourceAdapter {
  readonly sourceKey = "bls-laus";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: AdapterInput): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const year = new Date().getUTCFullYear();
    const { body } = await input.fetchText("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesid: [BLS_SERIES[input.market as Exclude<PropertyMarketId, "bengaluru">]], startyear: String(year - 5), endyear: String(year) }),
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

export const ACTIVE_PROPERTY_ADAPTERS: PropertySourceAdapter[] = [new FhfaHpiAdapter(), new FredMortgageAdapter(), new BlsLausAdapter()];
