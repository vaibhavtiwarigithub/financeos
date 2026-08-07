import type { PropertyObservation, PropertySourceAdapter } from "@/lib/property/contracts";
import type { PropertyMarketId } from "@/lib/property/registry";

const FHFA_MASTER = "https://www.fhfa.gov/hpi/download/monthly/hpi_master.json";
const FRED_MORTGAGE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US";

// ── Per-invocation fetch cache ───────────────────────────────────────────────
// FHFA's master JSON is a multi-megabyte national file, and FRED's CSV is the
// whole MORTGAGE30US history. Both were being downloaded once PER MARKET, so a
// three-market run pulled the same two payloads three times each — nine network
// fetches where three would do, with `cache: "no-store"` explicitly defeating
// Next's own caching. That is the "cache one bounded fetch per invocation" rule
// in the feature contract, and it was not being met.
//
// Deliberately per-invocation rather than time-based: a cache with a TTL would
// silently serve a stale national file into a later scheduled run, which is the
// kind of quiet staleness this codebase has been bitten by before. This map is
// cleared at the start of every collection run and never outlives it.
const runCache = new Map<string, Promise<{ body: string; lastModified: string | null }>>();

/** Clear the per-invocation cache. MUST be called once at the start of a run. */
export function beginPropertyCollectionRun(): void {
  runCache.clear();
}

/** Bytes fetched from the network this run, per URL — for honest run accounting. */
export function propertyRunFetchCount(): number {
  return runCache.size;
}

async function cachedFetch(url: string, init?: RequestInit): Promise<{ body: string; lastModified: string | null }> {
  const key = `${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
  let hit = runCache.get(key);
  if (!hit) {
    hit = (async () => {
      const response = await fetch(url, { ...init, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { body: await response.text(), lastModified: response.headers.get("last-modified") };
    })();
    runCache.set(key, hit);
  }
  return hit;
}

/**
 * Should a row be kept, given the newest `as_of` already stored?
 *
 * A plain `as_of <= since` filter suppresses REVISIONS: the source republishes
 * the same period with a corrected value, the collector drops it because the
 * date is not newer, and the revision machinery in the schema — a
 * `revision_state` column and a uniqueness key that includes it — can never fire.
 * The feature contract calls this out explicitly, and every adapter had it.
 *
 * A revised row is therefore always admitted. The database's unique index
 * (NULLS NOT DISTINCT over source/geography/metric/as_of/revision_state/version)
 * is what prevents an actual duplicate, and an unchanged revision simply
 * conflicts and is ignored.
 */
export function keepObservation(asOf: string, since: string | null, revisionState: "initial" | "revised"): boolean {
  if (revisionState === "revised") return true;
  return !since || asOf > since;
}

function quarterEnd(year: number, quarter: number): string {
  const month = quarter * 3;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
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

export class FredMortgageAdapter implements PropertySourceAdapter {
  readonly sourceKey = "fred-mortgage";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: { market: PropertyMarketId; since: string | null }): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const { body, lastModified } = await cachedFetch(FRED_MORTGAGE, { signal: AbortSignal.timeout(20_000) });
    const rows = parseSimpleCsv(body).slice(1);
    return rows.flatMap(([date, raw]) => {
      const value = Number(raw);
      if (!date || !Number.isFinite(value)) return [];
      if (!keepObservation(date, input.since, "initial")) return [];
      return [{ sourceKey: this.sourceKey, market: input.market, metric: "mortgage_rate" as const, nativeUnit: "percent", value, asOf: date, publishedAt: null, sourceVersion: lastModified, revisionState: "initial" as const }];
    });
  }
}

type FhfaRow = { hpi_type?: string; hpi_flavor?: string; frequency?: string; level?: string; place_name?: string; place_id?: string | number; yr?: number; period?: number; index_nsa?: number | null; index_sa?: number | null };

const FHFA_MARKET_MATCH: Record<Exclude<PropertyMarketId, "bengaluru">, RegExp> = {
  austin: /Austin-Round Rock/i,
  phoenix: /Phoenix-Mesa/i,
};

export class FhfaHpiAdapter implements PropertySourceAdapter {
  readonly sourceKey = "fhfa-hpi";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: { market: PropertyMarketId; since: string | null }): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const { body, lastModified } = await cachedFetch(FHFA_MASTER, { signal: AbortSignal.timeout(30_000) });
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

const BLS_SERIES: Record<Exclude<PropertyMarketId, "bengaluru">, string> = { austin: "LAUMT481242000000003", phoenix: "LAUMT043806000000003" };
export class BlsLausAdapter implements PropertySourceAdapter {
  readonly sourceKey = "bls-laus";
  supportsMarket(market: PropertyMarketId): boolean { return market !== "bengaluru"; }
  async fetch(input: { market: PropertyMarketId; since: string | null }): Promise<PropertyObservation[]> {
    if (!this.supportsMarket(input.market)) return [];
    const year = new Date().getUTCFullYear();
    const { body } = await cachedFetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seriesid: [BLS_SERIES[input.market as Exclude<PropertyMarketId, "bengaluru">]], startyear: String(year - 5), endyear: String(year) }), signal: AbortSignal.timeout(20_000) });
    const json = JSON.parse(body) as any; const series = json?.Results?.series?.[0]?.data;
    if (!Array.isArray(series)) throw new Error("BLS response missing series data");
    return series.flatMap((row: any) => {
      const month = Number(String(row.period ?? "").replace("M", "")); const yearValue = Number(row.year); const value = Number(row.value);
      if (!Number.isFinite(value) || month < 1 || month > 12 || !Number.isInteger(yearValue)) return [];
      const asOf = new Date(Date.UTC(yearValue, month, 0)).toISOString().slice(0, 10);
      const preliminary = Array.isArray(row.footnotes) && row.footnotes.some((f: any) => /preliminary/i.test(f?.text ?? ""));
      // Revisions are admitted regardless of `since` - see keepObservation.
      if (!keepObservation(asOf, input.since, preliminary ? "initial" : "revised")) return [];
      return [{ sourceKey: this.sourceKey, market: input.market, metric: "unemployment_rate" as const, nativeUnit: "percent", value, asOf, publishedAt: null, sourceVersion: preliminary ? "preliminary" : "revised", revisionState: preliminary ? "initial" as const : "revised" as const }];
    });
  }
}

export const ACTIVE_PROPERTY_ADAPTERS: PropertySourceAdapter[] = [new FhfaHpiAdapter(), new FredMortgageAdapter(), new BlsLausAdapter()];
