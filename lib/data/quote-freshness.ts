// W1 — the money-path freshness boundary.
//
// Why this exists: `getQuote` and `fetchIndiaQuote` have always returned a
// correct `stale` flag. Every caller on the fill path simply dropped it. On
// 2026-08-13 that produced a paper BUY of LNC at 35.39 priced off a price_cache
// row from 2026-05-26 (79 days stale) while LNC actually traded at 45.28 — and
// the row was stamped `quality_status: 'ok'`. Fifteen US fills were affected,
// errors up to 19.6%, $424.53 of unrecorded value on a $10k book.
//
// The rule: a quote is not a price until it has proven its freshness. Callers
// receive `AcceptedQuote` or a typed rejection — never a bare number. Provenance
// (source + the quote's own retrievedAt) rides along so it can be persisted on
// the fill instead of reconstructed later, which is what made the incident
// unattributable in the first place.
//
// Fails closed by construction: anything unknown, unparseable, or stale is a
// rejection. There is no "assume fresh" branch.

/** Minimal shape shared by DeterministicQuote (US) and IndiaQuote. */
export interface FreshnessCandidate {
  price?: number | null;
  source?: string | null;
  retrievedAt?: string | null;
  stale?: boolean | null;
}

export interface AcceptedQuote {
  price: number;
  source: string;
  /** The quote's own observation time — NOT the time we happened to read it. */
  retrievedAt: string;
}

export type QuoteRejectionReason =
  | "price_unavailable"       // no quote, non-positive price, or source 'unavailable'
  | "quote_stale"             // provider/adapter marked it stale
  | "quote_provenance_missing" // no usable source or timestamp to persist
  | "quote_timestamp_invalid"; // unparseable or future-dated

export interface QuoteRejection {
  ok: false;
  reason: QuoteRejectionReason;
  detail: string;
}

export type QuoteVerdict = ({ ok: true } & AcceptedQuote) | QuoteRejection;

/** Clock skew we tolerate before treating a future timestamp as broken. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Accept a quote for money-path use, or reject it with a reason.
 *
 * Deliberately strict about provenance as well as staleness: a quote we cannot
 * attribute is a quote we cannot audit, and the whole point of this boundary is
 * that a bad fill stays explicable afterwards.
 */
export function assertFreshQuote(
  quote: FreshnessCandidate | null | undefined,
  symbol: string,
): QuoteVerdict {
  if (!quote) {
    return { ok: false, reason: "price_unavailable", detail: `${symbol}: no quote returned` };
  }

  const price = Number(quote.price);
  const source = typeof quote.source === "string" ? quote.source.trim() : "";
  if (source === "unavailable" || !Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      reason: "price_unavailable",
      detail: `${symbol}: source=${source || "none"} price=${quote.price ?? "null"}`,
    };
  }

  if (!source) {
    return { ok: false, reason: "quote_provenance_missing", detail: `${symbol}: quote has no source` };
  }

  const retrievedAt = typeof quote.retrievedAt === "string" ? quote.retrievedAt.trim() : "";
  if (!retrievedAt) {
    return { ok: false, reason: "quote_provenance_missing", detail: `${symbol}: quote has no retrievedAt` };
  }

  const observedMs = Date.parse(retrievedAt);
  if (!Number.isFinite(observedMs)) {
    return { ok: false, reason: "quote_timestamp_invalid", detail: `${symbol}: unparseable retrievedAt '${retrievedAt}'` };
  }
  if (observedMs > Date.now() + FUTURE_SKEW_MS) {
    return { ok: false, reason: "quote_timestamp_invalid", detail: `${symbol}: retrievedAt '${retrievedAt}' is in the future` };
  }

  // The adapters own the staleness rule (market-hours aware). Trust their verdict,
  // but treat an ABSENT verdict as stale rather than fresh — an adapter that
  // forgot to set the flag must not be read as an all-clear.
  if (quote.stale !== false) {
    const ageDays = (Date.now() - observedMs) / 86_400_000;
    return {
      ok: false,
      reason: "quote_stale",
      detail: `${symbol}: quote from ${source} as-of ${retrievedAt} (${ageDays.toFixed(1)}d old) is stale or unverified`,
    };
  }

  return { ok: true, price, source, retrievedAt };
}
