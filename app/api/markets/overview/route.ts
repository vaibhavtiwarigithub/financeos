import { NextResponse } from "next/server";
import {
  buildQuote,
  etCalendarDate,
  sessionCandidates,
  type Quote,
} from "@/lib/markets/daily-change";

export const revalidate = 300; // 5-minute Next.js route cache

export type IndexQuote = Quote;
export type SectorQuote = Quote;

export interface MarketOverview {
  indices: IndexQuote[];
  sectors: SectorQuote[];
  /** ET date of the session the closes belong to. null when nothing resolved. */
  sessionDate: string | null;
  /** ET date of the session the change is measured AGAINST. */
  priorCloseDate: string | null;
  /** When this payload's upstream fetch ran — NOT when the client received it. */
  fetchedAt: string;
  /** True when the payload is not a complete, current picture. */
  stale: boolean;
  /** Count of symbols that could not be resolved. */
  unavailableCount: number;
  /** Present when the whole route is degraded (e.g. no credentials, rate limit). */
  degraded?: string;
}

const INDEX_META: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  DIA: "Dow Jones",
  VIXY: "VIX Proxy (VIXY)",
};

const SECTOR_META: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLY: "Cons. Discretionary",
  XLP: "Cons. Staples",
  XLRE: "Real Estate",
  XLU: "Utilities",
  XLB: "Materials",
  XLC: "Comm. Services",
};

const ALL_SYMBOLS = [...Object.keys(INDEX_META), ...Object.keys(SECTOR_META)];
const MASSIVE_BASE = "https://api.massive.com";

// ---------------------------------------------------------------------------
// WHY GROUPED DAILY, NOT PER-SYMBOL /prev
// ---------------------------------------------------------------------------
// A daily change is close vs PRIOR close. The previous implementation fetched
// /v2/aggs/ticker/{sym}/prev per symbol and computed (c - o) / o — the session's
// INTRADAY move — then rendered it as "today". Verified live on the 2026-07-15
// session: XLRE's intraday was -0.11% (red) while its true daily was +0.18%
// (green), and XLK's intraday -1.91% vs true daily -1.11%. The sign can invert.
//
// The provider key is ALSO rate limited (~5 requests/minute, verified live:
// "You've exceeded the maximum requests per minute"). The old route fired 15
// parallel /prev calls, so ~10 of them failed on every cold cache and the
// zero-fallback painted each failure as a confident green +0.00% pill.
//
// The grouped endpoint returns EVERY US ticker's OHLC for one session in ONE
// request. Two calls (latest session + prior session) therefore serve all 15
// symbols, cost 2 requests instead of 16, keep every symbol on the SAME session,
// and fit inside the rate limit. Verified: grouped 2026-07-16 matches /prev for
// SPY (o 752.76 / c 750.72) and XLK (o 179 / c 177.52) exactly.
//
// TRADEOFF (deliberate, and disclosed in the UI via sessionDate): grouped for
// the CURRENT calendar date is refused until after midnight ET —
// "Attempted to request today's data before end of day" — so between the 4pm ET
// close and midnight the latest resolvable session is the previous one. The UI
// always states which session it is showing, so this is late, never wrong.
// ---------------------------------------------------------------------------

interface GroupedAgg {
  T?: string;
  o?: number;
  c?: number;
  t?: number;
}

interface GroupedResponse {
  results?: GroupedAgg[];
  status?: string;
  error?: string;
}

/** One resolved trading session: the closes we care about, keyed by symbol. */
interface Session {
  date: string;
  closes: Map<string, number>;
}

type GroupedOutcome =
  | { kind: "session"; session: Session }
  | { kind: "no-session" } // holiday, or not yet published for today
  | { kind: "error"; reason: string }; // rate limit / network / auth

// A past session's closes are immutable → cache the extracted map by date for
// the life of the process. Only the ~15 symbols we render are retained.
const sessionCache = new Map<string, Session>();

async function fetchGroupedSession(date: string, apiKey: string): Promise<GroupedOutcome> {
  const cached = sessionCache.get(date);
  if (cached) return { kind: "session", session: cached };

  const url = `${MASSIVE_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${apiKey}`;
  let res: Response;
  try {
    // Immutable once published, so cache hard. This also keeps provider calls to
    // ~2 per 5-minute route-cache window, well inside the rate limit.
    res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      next: { revalidate: 3600 },
    });
  } catch {
    return { kind: "error", reason: "market data provider timed out or was unreachable" };
  }

  if (res.status === 429) {
    return { kind: "error", reason: "market data provider rate limit exceeded — try again shortly" };
  }
  if (res.status === 403) {
    // Either "today before end of day" or a genuine entitlement gap. Both mean
    // "no session here" — walk back rather than fail.
    return { kind: "no-session" };
  }
  if (!res.ok) {
    return { kind: "error", reason: `market data provider returned HTTP ${res.status}` };
  }

  let data: GroupedResponse;
  try {
    data = await res.json();
  } catch {
    return { kind: "error", reason: "market data provider returned an unreadable response" };
  }

  // The provider signals rate limiting with a 200 + ERROR body as well as 429.
  if (data.status === "ERROR") {
    return {
      kind: "error",
      reason: /maximum requests per minute/i.test(data.error ?? "")
        ? "market data provider rate limit exceeded — try again shortly"
        : data.error ?? "market data provider returned an error",
    };
  }
  // A market holiday returns 200 with no `results`.
  if (!data.results || data.results.length === 0) return { kind: "no-session" };

  const wanted = new Set(ALL_SYMBOLS);
  const closes = new Map<string, number>();
  for (const r of data.results) {
    if (r.T && r.c != null && wanted.has(r.T)) closes.set(r.T, r.c);
  }
  if (closes.size === 0) return { kind: "no-session" };

  const session: Session = { date, closes };
  sessionCache.set(date, session);
  return { kind: "session", session };
}

/**
 * Resolve the latest published session and the one before it, walking back from
 * today's ET date. Normally 2 requests; 3 when today is a weekday whose session
 * has not published yet. Stops early on a hard error so a rate limit surfaces as
 * a rate limit instead of an endless walk.
 */
async function resolveSessions(
  apiKey: string
): Promise<{ latest: Session; prior: Session } | { error: string }> {
  const today = etCalendarDate(Date.now());
  const found: Session[] = [];
  let lastError: string | null = null;

  for (const date of sessionCandidates(today, 8)) {
    const outcome = await fetchGroupedSession(date, apiKey);
    if (outcome.kind === "error") {
      lastError = outcome.reason;
      break;
    }
    if (outcome.kind === "session") {
      found.push(outcome.session);
      if (found.length === 2) return { latest: found[0], prior: found[1] };
    }
  }
  return {
    error:
      lastError ??
      "could not resolve two consecutive trading sessions from the market data provider",
  };
}

function degradedOverview(degraded: string): MarketOverview {
  const unavailable = (meta: Record<string, string>): Quote[] =>
    Object.entries(meta).map(([symbol, name]) => buildQuote(symbol, name, null, null, degraded));
  return {
    indices: unavailable(INDEX_META),
    sectors: unavailable(SECTOR_META),
    sessionDate: null,
    priorCloseDate: null,
    fetchedAt: new Date().toISOString(),
    stale: true,
    unavailableCount: ALL_SYMBOLS.length,
    degraded,
  };
}

// In-memory cache as a secondary layer (supplements the Next.js route cache).
let cache: { data: MarketOverview; ts: number } | null = null;
const MEM_CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET() {
  if (cache && Date.now() - cache.ts < MEM_CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    // Never cached — must clear the moment the key lands.
    return NextResponse.json(
      degradedOverview("MASSIVE_API_KEY is not configured — no market data provider available")
    );
  }

  const resolved = await resolveSessions(apiKey);
  if ("error" in resolved) {
    // Not cached: a transient rate limit must not be frozen in for 5 minutes.
    return NextResponse.json(degradedOverview(resolved.error));
  }

  const { latest, prior } = resolved;

  const toQuote = (symbol: string, name: string): Quote => {
    const close = latest.closes.get(symbol);
    return buildQuote(
      symbol,
      name,
      close == null ? null : { symbol, close, sessionDate: latest.date },
      prior.closes.get(symbol) ?? null,
      close == null ? "symbol not present in the provider's session data" : undefined
    );
  };

  const indices = Object.entries(INDEX_META).map(([s, n]) => toQuote(s, n));
  const sectors = Object.entries(SECTOR_META).map(([s, n]) => toQuote(s, n));
  const unavailableCount = [...indices, ...sectors].filter((q) => q.status === "unavailable").length;

  const overview: MarketOverview = {
    indices,
    sectors,
    sessionDate: latest.date,
    priorCloseDate: prior.date,
    fetchedAt: new Date().toISOString(),
    stale: unavailableCount > 0,
    unavailableCount,
  };

  cache = { data: overview, ts: Date.now() };
  return NextResponse.json(overview);
}
