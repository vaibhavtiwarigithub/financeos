// Step 4 of features/walk-forward-ic-folds: point-in-time universe resolution.
//
// Answers one question: which symbols were tradeable and liquid ON a given
// as-of date, using only information knowable on that date?
//
// The existing lib/edges/universe.ts list is a hand-picked CURRENT-liquid set —
// its own header says so. Replaying today's survivors through past dates is
// survivorship bias: the names that blew up are simply absent, so every
// backward-looking IC is measured on a population selected for having survived.
// This module is the replacement, and it FAILS CLOSED. It never falls back to
// the curated list, because a silent fallback would reintroduce exactly the bias
// it exists to remove.
//
// Verified against the live provider 2026-07-28:
//   /v3/reference/tickers?date=<asOf>&active=true  -> OK at ANY date. Returns
//     names active ON that date, so later-delisted names are present and
//     not-yet-listed names are absent. This is the survivorship fix.
//   /v2/aggs/grouped/.../{date}                    -> OK to ~2 years back
//     (12410 tickers for 2026-07-24, 10704 for 2024-10-15), then
//     NOT_AUTHORIZED "past historical entitlements" for 2023-06-30.
//
// So membership is available at any date but LIQUIDITY is not. Rather than
// fabricate a rank outside the entitled window, this module refuses. See
// FEATURE_ARCHITECTURE.md Annex E for what that costs in as-of dates.

import crypto from "node:crypto";
import type { Market } from "@/lib/edges/types";

/** Bump when the selection RULES change. Snapshots are keyed by this. */
export const PIT_POLICY_VERSION = "us_pit_adv20_top400_v2";
export const PIT_ADV_WINDOW_SESSIONS = 20;
/** Persist one reusable ranked superset; experiments take deterministic prefixes. */
export const PIT_SNAPSHOT_SIZE = 400;

/** Massive `type` codes we accept. CS = common stock. */
const ELIGIBLE_TYPES = new Set(["CS"]);

/** Retry/backoff knobs. Injectable so tests can exercise 429 handling instantly. */
export interface RetryOpts { retries?: number; baseDelayMs?: number }

export interface PitTicker {
  ticker: string;
  type?: string | null;
  active?: boolean | null;
  delisted_utc?: string | null;
  primary_exchange?: string | null;
}

export interface PitMember {
  symbol: string;
  advValue: number;
  advRank: number;
  delistedAt: string | null;
}

export type PitUniverseResult =
  | {
      ok: true;
      market: Market;
      asOf: string;
      policyVersion: string;
      source: string;
      members: PitMember[];
      fingerprint: string;
    }
  | { ok: false; reason: string; detail: string };

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Common stock only, on a real exchange. Excludes ETFs, ADRs, warrants, units
 * and OTC — `lib/edges/universe.ts` also holds individual stocks only, so the
 * PIT set must not silently widen the population it replaces.
 */
export function isEligibleTicker(t: PitTicker): boolean {
  if (!t.ticker || !ELIGIBLE_TYPES.has(String(t.type ?? ""))) return false;
  const ex = String(t.primary_exchange ?? "");
  // XNAS/XNYS/ARCX/BATS etc. OTC Link and blank are excluded.
  if (!ex || ex === "OTC Link" || ex.startsWith("OTC")) return false;
  // Yahoo cannot resolve symbols carrying warrant/unit/preferred suffixes.
  if (/[.\-]W[SI]?$|[.\-]U$|[.\-]P[A-Z]?$/.test(t.ticker)) return false;
  return true;
}

/**
 * Top `size` by dollar volume. Ties break on symbol so the set is deterministic —
 * a snapshot that shuffled under equal ADV would break its own fingerprint.
 */
export function rankByLiquidity(
  rows: Array<{ symbol: string; advValue: number; delistedAt?: string | null }>,
  size: number,
): PitMember[] {
  return rows
    .filter((r) => Number.isFinite(r.advValue) && r.advValue > 0)
    .sort((a, b) => (b.advValue - a.advValue) || a.symbol.localeCompare(b.symbol))
    .slice(0, size)
    .map((r, i) => ({
      symbol: r.symbol,
      advValue: r.advValue,
      advRank: i + 1,
      delistedAt: r.delistedAt ?? null,
    }));
}

/** Mean point-in-time dollar volume across a complete session window. */
export function averageDollarVolume(
  sessions: Map<string, number>[],
): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const session of sessions) {
    for (const [symbol, value] of session) {
      if (!Number.isFinite(value) || value <= 0) continue;
      const prior = sums.get(symbol) ?? { sum: 0, n: 0 };
      prior.sum += value;
      prior.n += 1;
      sums.set(symbol, prior);
    }
  }
  const means = new Map<string, number>();
  for (const [symbol, value] of sums) {
    // A name must have traded in every session. Newly listed/suspended names do
    // not get a flattering average over only the days on which they appeared.
    if (value.n === sessions.length) means.set(symbol, value.sum / value.n);
  }
  return means;
}

/**
 * Deterministic hash of the member set. Same policy + market + date + symbols
 * must always produce the same value, so a re-run that silently changed the
 * population is detectable rather than invisible.
 */
export function universeFingerprint(
  market: Market,
  asOf: string,
  policyVersion: string,
  members: Array<Pick<PitMember, "symbol" | "advValue" | "advRank">>,
): string {
  const ranked = [...members]
    .sort((a, b) => a.advRank - b.advRank)
    .map((member) =>
      `${member.advRank}:${member.symbol}:${member.advValue.toPrecision(12)}`,
    );
  const payload = [market, asOf, policyVersion, ...ranked].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * Massive's aggregate entitlement is ~2 years; membership is not limited but
 * liquidity is. Checked BEFORE any network call so a refusal is cheap and the
 * reason is precise.
 */
export function liquidityAvailableFor(asOf: string, today = new Date()): boolean {
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(asOfMs)) return false;
  const twoYearsAgo = Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), today.getUTCDate());
  return asOfMs >= twoYearsAgo && asOfMs <= today.getTime();
}

// ── provider calls ───────────────────────────────────────────────────────────

const BASE = "https://api.massive.com";

/**
 * Measured 2026-07-28: the plan allows ~5 requests per minute, then returns 429.
 * A membership walk is ~10 pages, so without backoff this module can never
 * complete a single as-of date — the walk aborts and every run refuses with
 * `membership_incomplete`. Retrying a 429 is therefore required for the module
 * to function at all, not an optimisation.
 *
 * Only 429 and 5xx are retried. A 403 (entitlement) or 400 (bad request) is a
 * permanent answer and retrying it would just burn the quota.
 */
async function getJson(url: string, opts?: { retries?: number; baseDelayMs?: number }): Promise<any | null> {
  const retries = opts?.retries ?? 4;
  const base = opts?.baseDelayMs ?? 13_000; // just over the 5/min window
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) return null; // permanent
      if (attempt === retries) return null;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : base * Math.pow(1.5, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    } catch {
      if (attempt === retries) return null;
      await new Promise((r) => setTimeout(r, base));
    }
  }
  return null;
}

/**
 * Every common stock active ON `asOf`, following pagination.
 *
 * `complete` is load-bearing. The membership set runs to ~10k tickers, so a full
 * page walk is ~10 requests and the plan DOES rate-limit — a 429 mid-walk was
 * observed while verifying this on 2026-07-28. An aborted walk yields a smaller
 * universe that looks perfectly valid: fewer names, a different fingerprint, a
 * different IC, and no error anywhere. Callers must refuse on `complete: false`
 * rather than rank whatever arrived.
 */
export async function fetchPitMembership(
  asOf: string,
  apiKey: string,
  retry?: RetryOpts,
): Promise<{ tickers: PitTicker[]; complete: boolean; pages: number }> {
  const out: PitTicker[] = [];
  let url = `${BASE}/v3/reference/tickers?market=stocks&date=${asOf}&active=true&limit=1000&apiKey=${apiKey}`;
  const MAX_PAGES = 30;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const j = await getJson(url, retry);
    // Null means transport failure, HTTP error, or a rate limit. Either way we
    // do not know what we missed, so the walk is incomplete — never partial.
    if (!j || j.status === "NOT_AUTHORIZED") {
      return { tickers: out, complete: false, pages };
    }
    for (const r of j.results ?? []) out.push(r as PitTicker);
    pages++;
    url = j.next_url ? `${j.next_url}&apiKey=${apiKey}` : "";
  }

  // Hitting the page ceiling with a next_url still pending is also incomplete.
  return { tickers: out, complete: !url, pages };
}

/** Whole-market OHLCV for one session in ONE call — close x volume per ticker. */
export async function fetchGroupedDollarVolume(
  date: string,
  apiKey: string,
  retry?: RetryOpts,
): Promise<Map<string, number> | null> {
  const j = await getJson(
    `${BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${apiKey}`,
    retry,
  );
  if (!j || j.status === "NOT_AUTHORIZED" || !Array.isArray(j.results)) return null;
  const m = new Map<string, number>();
  for (const r of j.results) {
    const sym = r.T, close = r.c, vol = r.v;
    if (typeof sym === "string" && Number.isFinite(close) && Number.isFinite(vol)) {
      m.set(sym, close * vol);
    }
  }
  return m;
}

// ── resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the PIT universe for one market/date. FAILS CLOSED — every refusal is
 * a named reason, never a fallback to the curated current-liquid list.
 *
 * India: refused. Massive carries no NSE listings (verified 2026-07-28 —
 * searching RELIANCE returns only US-listed and OTC instruments), so India has
 * no PIT membership source until the NSE index-archive path (5D) is built.
 */
export async function resolvePitUniverse(opts: {
  market: Market;
  asOf: string;
  size: number;
  minSymbols: number;
  apiKey?: string;
  today?: Date;
  retry?: RetryOpts;
  /** Exactly 20 market sessions ending at asOf, all knowable on that date. */
  liquidityDates?: string[];
  /** Shared across dates so overlapping ADV windows do not repeat provider calls. */
  liquidityCache?: Map<string, Promise<Map<string, number> | null>>;
}): Promise<PitUniverseResult> {
  const { market, asOf, size, minSymbols } = opts;
  const apiKey = opts.apiKey ?? process.env.MASSIVE_API_KEY ?? "";

  if (market !== "us") {
    return {
      ok: false,
      reason: "universe_not_point_in_time",
      detail:
        `No point-in-time membership source for market=${market}. Massive carries no NSE ` +
        `listings; the NSE index-archive path (5D) is not built. India evidence is ` +
        `diagnostic-only and must not be promoted.`,
    };
  }
  if (!apiKey) {
    return { ok: false, reason: "provider_unconfigured", detail: "MASSIVE_API_KEY is not set." };
  }
  const liquidityDates = opts.liquidityDates ?? [];
  if (
    liquidityDates.length !== PIT_ADV_WINDOW_SESSIONS ||
    liquidityDates[liquidityDates.length - 1] !== asOf ||
    liquidityDates.some((date, i) => (i > 0 && date <= liquidityDates[i - 1]) || date > asOf)
  ) {
    return {
      ok: false,
      reason: "liquidity_window_invalid",
      detail:
        `Expected ${PIT_ADV_WINDOW_SESSIONS} strictly ascending market sessions ending ` +
        `at ${asOf}; received ${liquidityDates.length}.`,
    };
  }
  if (liquidityDates.some((date) => !liquidityAvailableFor(date, opts.today))) {
    return {
      ok: false,
      reason: "liquidity_not_available_for_date",
      detail:
        `At least one session in the trailing ${PIT_ADV_WINDOW_SESSIONS}-session window ` +
        `ending ${asOf} is outside the grouped-aggregate entitlement. Membership is ` +
        `resolvable, but a later liquidity window will not be substituted.`,
    };
  }

  const membership = await fetchPitMembership(asOf, apiKey, opts.retry);
  if (!membership.tickers.length) {
    return { ok: false, reason: "membership_unavailable", detail: `No PIT membership returned for ${asOf}.` };
  }
  // A truncated page walk is NOT a smaller universe — it is an unknown one. A
  // 429 partway through would otherwise yield a plausible-looking snapshot with
  // a different population and a different fingerprint, silently.
  if (!membership.complete) {
    return {
      ok: false,
      reason: "membership_incomplete",
      detail:
        `Pagination stopped after ${membership.pages} page(s) with ${membership.tickers.length} ` +
        `tickers for ${asOf} (rate limit, transport error, or page ceiling). Refusing rather ` +
        `than ranking a partial universe.`,
    };
  }

  const eligible = membership.tickers.filter(isEligibleTicker);
  const cache = opts.liquidityCache ?? new Map<string, Promise<Map<string, number> | null>>();
  const daily: Array<Map<string, number> | null> = [];
  for (const date of liquidityDates) {
    let pending = cache.get(date);
    if (!pending) {
      pending = fetchGroupedDollarVolume(date, apiKey, opts.retry);
      cache.set(date, pending);
    }
    // Sequential on a cold cache: the free provider is ~5 calls/minute. Shared
    // cached promises make overlapping windows cheap without a request burst.
    daily.push(await pending);
  }
  if (daily.some((row) => row === null)) {
    return {
      ok: false,
      reason: "liquidity_unavailable",
      detail:
        `At least one grouped aggregate was unavailable in the trailing ` +
        `${PIT_ADV_WINDOW_SESSIONS}-session window ending ${asOf}.`,
    };
  }
  const dollarVol = averageDollarVolume(daily as Map<string, number>[]);

  const ranked = rankByLiquidity(
    eligible.map((t) => ({
      symbol: t.ticker,
      advValue: dollarVol.get(t.ticker) ?? 0,
      delistedAt: t.delisted_utc ? t.delisted_utc.slice(0, 10) : null,
    })),
    size,
  );

  if (ranked.length < minSymbols) {
    return {
      ok: false,
      reason: "universe_below_min_symbols",
      detail: `Resolved ${ranked.length} eligible liquid names for ${asOf}, below the ${minSymbols} floor.`,
    };
  }

  return {
    ok: true,
    market,
    asOf,
    policyVersion: PIT_POLICY_VERSION,
    source: "massive_pit_tickers_trailing_adv20",
    members: ranked,
    fingerprint: universeFingerprint(market, asOf, PIT_POLICY_VERSION, ranked),
  };
}
