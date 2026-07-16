// Server-side India market adapter (allowlisted, paced, fail-soft).
//
// The browser must NEVER call a provider directly. This module runs server-side
// only: it fetches India index/sector/constituent quotes from Yahoo's auth-free
// chart endpoint (an UNOFFICIAL fallback — never described as an authoritative
// NSE feed), validates them, and returns provenance-stamped rows. Kite/Upstox
// personal tiers give execution only, no market quotes, so Yahoo is the sole
// allowlisted source here.
//
// The parse/validate core (`toAdapterQuote`) is a PURE function so it can be
// fixture-tested for success / partial / throttle / stale / bad-currency /
// non-finite without touching the network.

// Only these hosts may ever be contacted by this adapter. Guarded at call time so
// a symbol string can never be coerced into an off-allowlist URL.
export const YAHOO_ALLOWED_HOSTS = [
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
] as const;

// India index/sector quotes are index points denominated in INR on Yahoo. A
// quote whose currency is anything else is a symbol/semantics mismatch and is
// rejected rather than displayed.
export const EXPECTED_CURRENCY = "INR";

// A quote observed longer ago than this is kept but flagged `stale` (never
// silently presented as live). 15 min mirrors the US quote staleness threshold.
export const STALE_MS = 15 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8000;

export type QuoteReason =
  | "ok"
  | "no_data"
  | "throttled"
  | "http_error"
  | "network_error"
  | "bad_currency"
  | "non_finite";

export interface AdapterQuote {
  symbol: string;
  ok: boolean;
  price: number | null;
  changePct: number | null;
  observedAt: string | null; // ISO — provider's regularMarketTime
  quality: "fresh" | "stale";
  source: "yahoo";
  reasonCode: QuoteReason;
}

// Minimal shape of Yahoo's chart `meta` we depend on.
export interface YahooChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number; // unix seconds
  currency?: string;
}

// The outcome of a single network attempt, decoupled from parsing so the pure
// core below can be exhaustively unit-tested.
export type FetchOutcome =
  | { kind: "ok"; meta: YahooChartMeta }
  | { kind: "throttled" }
  | { kind: "http_error"; status: number }
  | { kind: "network_error" }
  | { kind: "no_data" };

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * PURE: map a single fetch outcome into a validated, provenance-stamped quote.
 * Every non-ok path returns `ok:false` with a specific reasonCode; the caller
 * excludes non-ok rows from display and folds them into the snapshot's coverage
 * accounting. `now` is injectable so staleness is deterministic in tests.
 */
export function toAdapterQuote(
  symbol: string,
  outcome: FetchOutcome,
  now: number = Date.now(),
): AdapterQuote {
  const base = {
    symbol,
    price: null as number | null,
    changePct: null as number | null,
    observedAt: null as string | null,
    quality: "stale" as "fresh" | "stale",
    source: "yahoo" as const,
  };

  if (outcome.kind === "throttled") return { ...base, ok: false, reasonCode: "throttled" };
  if (outcome.kind === "http_error") return { ...base, ok: false, reasonCode: "http_error" };
  if (outcome.kind === "network_error") return { ...base, ok: false, reasonCode: "network_error" };
  if (outcome.kind === "no_data") return { ...base, ok: false, reasonCode: "no_data" };

  const m = outcome.meta;

  // Currency/basis validation — reject a symbol that resolved to the wrong market.
  if (m.currency != null && m.currency !== EXPECTED_CURRENCY) {
    return { ...base, ok: false, reasonCode: "bad_currency" };
  }

  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose;
  if (!isFiniteNum(price) || price <= 0 || !isFiniteNum(prev) || prev <= 0) {
    return { ...base, ok: false, reasonCode: "non_finite" };
  }

  const changePct = ((price - prev) / prev) * 100;
  if (!isFiniteNum(changePct)) {
    return { ...base, ok: false, reasonCode: "non_finite" };
  }

  const observedAtMs = isFiniteNum(m.regularMarketTime) ? m.regularMarketTime * 1000 : null;
  const observedAt = observedAtMs != null ? new Date(observedAtMs).toISOString() : null;
  const quality: "fresh" | "stale" =
    observedAtMs != null && now - observedAtMs <= STALE_MS ? "fresh" : "stale";

  return {
    symbol,
    ok: true,
    price: Math.round(price * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    observedAt,
    quality,
    source: "yahoo",
    reasonCode: "ok",
  };
}

// ── Network layer (server-only) ──────────────────────────────────────────────

// Fetch one symbol's chart meta from the auth-free Yahoo chart endpoint and map
// it to a FetchOutcome. The URL host is fixed to the allowlist; only the symbol
// (URL-encoded) varies.
async function fetchYahooChart(symbol: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchOutcome> {
  const url = `https://${YAHOO_ALLOWED_HOSTS[0]}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) return { kind: "throttled" };
    if (!res.ok) return { kind: "http_error", status: res.status };
    const meta = (await res.json())?.chart?.result?.[0]?.meta as YahooChartMeta | undefined;
    if (!meta || meta.regularMarketPrice == null) return { kind: "no_data" };
    return { kind: "ok", meta };
  } catch {
    return { kind: "network_error" };
  }
}

/** Fetch + validate a single symbol into an AdapterQuote (server-only). */
export async function fetchQuote(symbol: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<AdapterQuote> {
  const outcome = await fetchYahooChart(symbol, timeoutMs);
  return toAdapterQuote(symbol, outcome);
}

/**
 * Fetch many symbols with bounded concurrency and a small inter-batch pace, so a
 * page/cron fill never bursts the unofficial provider. Order is preserved.
 */
export async function fetchQuotes(
  symbols: string[],
  opts: { concurrency?: number; pacingMs?: number; timeoutMs?: number } = {},
): Promise<AdapterQuote[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const pacingMs = opts.pacingMs ?? 150;
  const timeoutMs = Math.max(500, opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const out: AdapterQuote[] = new Array(symbols.length);
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const rows = await Promise.all(batch.map((s) => fetchQuote(s, timeoutMs)));
    rows.forEach((r, j) => { out[i + j] = r; });
    if (i + concurrency < symbols.length && pacingMs > 0) {
      await new Promise((r) => setTimeout(r, pacingMs));
    }
  }
  return out;
}
