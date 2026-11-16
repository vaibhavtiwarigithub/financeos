import "server-only";

export type SymbolReturnsArchiveQuery = {
  market: "us" | "india";
  since: string;
  until: string;
  symbols?: readonly string[];
  mode?: "raw" | "rotation";
  sort?: "id_asc" | "available_at_asc" | "available_at_desc";
  availableAtOrBefore?: string;
  /** Explicit bounded market/date scan used by policy-event impact evaluation. */
  marketWide?: boolean;
  /** Preserve an existing caller-level `.limit()` without silently paginating past it. */
  resultLimit?: number;
};

export class SymbolReturnsArchiveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SymbolReturnsArchiveError";
  }
}

const PAGE_SIZE = 5_000;
const MAX_ROWS_PER_READ = 100_000;
const INGEST_BATCH_SIZE = 10;

export function symbolDailyReturnsArchiveReadsEnabled(): boolean {
  return process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS === "true";
}

export async function mirrorSymbolDailyReturns<T extends Record<string, unknown>>(
  rows: readonly T[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ configured: boolean; accepted: number; inserted: number }> {
  const endpoint = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  const token = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  if (!endpoint || !token) return { configured: false, accepted: 0, inserted: 0 };
  if (token.length < 32) throw new SymbolReturnsArchiveError("Daily-return archive token is invalid");
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/v1/symbol-daily-returns/ingest", endpoint);
  let accepted = 0;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += INGEST_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INGEST_BATCH_SIZE);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ rows: batch }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SymbolReturnsArchiveError("Daily-return archive writer is unavailable");
    }
    if (!response.ok) throw new SymbolReturnsArchiveError("Daily-return archive rejected the mirror batch", response.status);
    let result: { accepted?: unknown; inserted?: unknown };
    try { result = await response.json() as typeof result; }
    catch { throw new SymbolReturnsArchiveError("Daily-return archive writer returned invalid data", response.status); }
    if (result.accepted !== batch.length || !Number.isSafeInteger(result.inserted)
      || Number(result.inserted) < 0 || Number(result.inserted) > batch.length) {
      throw new SymbolReturnsArchiveError("Daily-return archive writer acknowledgement is inconsistent", response.status);
    }
    accepted += Number(result.accepted);
    inserted += Number(result.inserted);
  }
  return { configured: true, accepted, inserted };
}

/**
 * Read only from a fully parity-verified D1 mirror. Any missing configuration,
 * incomplete mirror, query error, or page inconsistency throws; callers must
 * not turn an archive failure into an empty successful result.
 */
export async function readSymbolDailyReturnsArchive<T extends object>(
  query: SymbolReturnsArchiveQuery,
  options: { maxRows?: number; fetchImpl?: typeof fetch } = {},
): Promise<T[]> {
  const endpoint = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  const token = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  if (!endpoint || !token || token.length < 32) throw new SymbolReturnsArchiveError("Verified daily-return archive is not configured");
  const maxRows = options.maxRows ?? MAX_ROWS_PER_READ;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS_PER_READ) {
    throw new SymbolReturnsArchiveError("Daily-return archive read exceeds the application row budget");
  }
  if (query.resultLimit !== undefined && (!Number.isSafeInteger(query.resultLimit) || query.resultLimit < 1 || query.resultLimit > maxRows)) {
    throw new SymbolReturnsArchiveError("Daily-return archive result limit is invalid");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/v1/symbol-daily-returns", endpoint);
  url.searchParams.set("market", query.market);
  url.searchParams.set("since", query.since);
  url.searchParams.set("until", query.until);
  if (query.mode) url.searchParams.set("mode", query.mode);
  if (query.sort) url.searchParams.set("sort", query.sort);
  if (query.availableAtOrBefore) url.searchParams.set("availableAtOrBefore", query.availableAtOrBefore);
  if (query.marketWide) url.searchParams.set("marketWide", "true");
  for (const symbol of query.symbols ?? []) url.searchParams.append("symbol", symbol);

  const rows: T[] = [];
  while (true) {
    const remaining = Math.min(maxRows - rows.length, (query.resultLimit ?? maxRows) - rows.length);
    if (remaining <= 0) {
      if (query.resultLimit !== undefined && rows.length === query.resultLimit) return rows;
      throw new SymbolReturnsArchiveError("Daily-return archive result exceeds the application row budget");
    }
    const limit = Math.min(PAGE_SIZE, remaining);
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", String(limit));
    pageUrl.searchParams.set("offset", String(rows.length));
    let response: Response;
    try {
      response = await fetchImpl(pageUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SymbolReturnsArchiveError("Daily-return archive is unavailable");
    }
    if (!response.ok) {
      throw new SymbolReturnsArchiveError("Daily-return archive rejected the query", response.status);
    }
    let page: { rows?: unknown; hasMore?: unknown; offset?: unknown; limit?: unknown };
    try {
      page = await response.json() as typeof page;
    } catch {
      throw new SymbolReturnsArchiveError("Daily-return archive returned invalid data", response.status);
    }
    if (!Array.isArray(page.rows) || page.offset !== rows.length || page.limit !== limit
      || typeof page.hasMore !== "boolean" || page.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new SymbolReturnsArchiveError("Daily-return archive page contract mismatch", response.status);
    }
    if (page.rows.length > limit || rows.length + page.rows.length > maxRows) {
      throw new SymbolReturnsArchiveError("Daily-return archive exceeded the application row budget");
    }
    rows.push(...page.rows as unknown as T[]);
    if (query.resultLimit !== undefined && rows.length === query.resultLimit) return rows;
    if (!page.hasMore) return rows;
    if (page.rows.length !== limit) throw new SymbolReturnsArchiveError("Daily-return archive pagination is inconsistent");
  }
}

/** Use the bounded archive only after an explicit operator rollout flag. Once
 * enabled, errors stay visible and never fall back to an incomplete Postgres
 * result that could hide a missing archive page. */
export async function readSymbolDailyReturnsOr<T extends object>(
  query: SymbolReturnsArchiveQuery,
  supabaseRead: () => Promise<T[]>,
  options: { maxRows?: number; fetchImpl?: typeof fetch } = {},
): Promise<T[]> {
  if (!symbolDailyReturnsArchiveReadsEnabled()) return supabaseRead();
  return readSymbolDailyReturnsArchive<T>(query, options);
}
