/**
 * Deterministic Quote Adapter — Phase 0
 * All prices come from real market APIs with timestamp + source provenance.
 * Never calls an LLM for price data.
 */

import { avCachedFetch } from "@/lib/av-cache";
import { expectedNewestSession } from "@/lib/data/completed-candles";
import { fetchYahooQuotes } from "@/lib/india-data";

export type QuoteSource = "massive" | "alpha_vantage" | "price_cache" | "yahoo" | "unavailable";

export interface DeterministicQuote {
  symbol: string;
  price: number;        // mid price
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePct: number | null;
  source: QuoteSource;
  retrievedAt: string;
  stale: boolean;       // true if > 15 min old during market hours
  /** Session low (day.l from Massive snapshot). Used by PositionMonitor to check
   *  intraday stop touches — a stop hit during the session is real even if price
   *  recovered by close. Null when source can't provide OHLC (AV, price_cache). */
  dayLow?: number | null;
  /** Session high (day.h). Stored for trailing-stop anchor accuracy. */
  dayHigh?: number | null;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours() + et.getMinutes() / 60;
  return h >= 9.5 && h < 16;
}

function isStale(retrievedAt: string): boolean {
  const age = Date.now() - new Date(retrievedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return true;
  // Outside market hours an EOD close is valid, but not indefinitely. Four
  // calendar days covers ordinary weekends and one-day exchange holidays while
  // refusing an abandoned cache row as today's executable paper-exit price.
  if (!isMarketHours()) return age > 4 * 86_400_000;
  return age > STALE_THRESHOLD_MS;
}

/** Fetch a real-time quote from Alpha Vantage GLOBAL_QUOTE (direct HTTP, no MCP).
 * Day-cached — AV free tier is 25 calls/day and this was previously calling
 * uncached on every page load (e.g. up to 26 symbols per Live Portfolio
 * refresh), exhausting the daily budget almost immediately. */
async function fetchAVQuote(symbol: string, avKey: string): Promise<DeterministicQuote | null> {
  if (!avKey) return null;
  const retrievedAt = new Date().toISOString();
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${avKey}`;
    const json = await avCachedFetch(`GLOBAL_QUOTE:${symbol}`, url);
    const q = json?.["Global Quote"];
    if (!q || !q["05. price"]) return null;

    const price = parseFloat(q["05. price"]);
    const change = parseFloat(q["09. change"] ?? "0");
    const changePct = parseFloat((q["10. change percent"] ?? "0").replace("%", ""));
    if (price <= 0) return null;

    return {
      symbol,
      price,
      bid: null,   // AV GLOBAL_QUOTE doesn't provide bid/ask
      ask: null,
      change,
      changePct,
      source: "alpha_vantage",
      retrievedAt,
      stale: false,
    };
  } catch {
    return null;
  }
}

/**
 * Batch-fetch quotes for many symbols in ONE Massive HTTP call via the
 * "Full Market Snapshot" endpoint's `tickers` filter (Polygon-compatible
 * `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=A,B,C`), instead of
 * one Alpha Vantage call per symbol. This is the primary batch path — AV
 * (25 calls/day free tier) can't cover a ~26-symbol Live Portfolio refresh
 * in a single page load, so every symbol past the first ~25 came back
 * "unavailable" and fell back to avgCost (0% P&L, "—" day change).
 * Massive is already used elsewhere in this repo (app/api/markets/overview,
 * app/api/markets/quote(s)) via the same prev-day-bar pattern.
 */
async function fetchMassiveBatchQuotes(
  symbols: string[],
  apiKey: string
): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  if (!apiKey || symbols.length === 0) return results;

  // API allows up to 250 tickers per call; batch in chunks to be safe.
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 100) chunks.push(symbols.slice(i, i + 100));

  // Helper: parse one Massive tickers response into results, return symbols found.
  const parseTickers = (tickers: any[], retrievedAt: string): string[] => {
    const found: string[] = [];
    for (const t of tickers) {
      const sym = t?.ticker;
      if (!sym) continue;
      // Which field supplied the price decides whether this is a CURRENT-session
      // observation or last session's close wearing today's timestamp. `day`/`min`
      // are current-session; `prevDay` is by definition the previous close, so it
      // must never be stamped fresh (2026-08-17: it was, unconditionally).
      const dayClose = t?.day?.c;
      const minClose = t?.min?.c;
      const prevClose0 = t?.prevDay?.c;
      const price = dayClose ?? minClose ?? prevClose0;
      if (!price || price <= 0) continue;
      const fromPrevDay = dayClose == null && minClose == null && prevClose0 != null;
      const prevClose = t?.prevDay?.c;
      const change = t?.todaysChange ?? (prevClose ? price - prevClose : null);
      const changePct = t?.todaysChangePerc ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : null);
      results[sym] = {
        symbol: sym, price,
        bid: t?.lastQuote?.p ?? null, ask: t?.lastQuote?.P ?? null,
        change: change ?? null, changePct: changePct ?? null,
        source: "massive", retrievedAt, stale: fromPrevDay,
        dayLow:  typeof t?.day?.l === "number" && t.day.l > 0 ? t.day.l : null,
        dayHigh: typeof t?.day?.h === "number" && t.day.h > 0 ? t.day.h : null,
      };
      found.push(sym);
    }
    return found;
  };

  for (const chunk of chunks) {
    const retrievedAt = new Date().toISOString();
    // stocks pass first; ETF pass only for symbols still missing.
    // /markets/stocks silently omits ETFs (VOO, XAR, …) which caused them to
    // fall through to AV on every request. The /etfs endpoint uses the same
    // response shape so parseTickers handles both.
    // The `/markets/etfs` pass that used to run here was removed 2026-08-18: that
    // endpoint returns HTTP 404 (it does not exist), so it never resolved a
    // single ETF. `getSettledDailyQuotes` below covers ETFs correctly — XAR and
    // VOO are both present in the grouped-daily feed.
    try {
      const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(chunk.join(","))}&apiKey=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        // NEVER swallow this. On 2026-08-18 the deployed key was found to be
        // 403 NOT_AUTHORIZED for every snapshot endpoint, so this "primary batch
        // path" had been returning zero US quotes on every call — silently, for
        // an unknown period. The book then fell through to a stale price_cache
        // bar that was mislabelled fresh, and the US NAV was overstated enough
        // to flip its sign. An entitlement failure must be loud.
        console.error(
          `[quotes] Massive snapshot HTTP ${res.status} for ${chunk.length} symbol(s) — ` +
          `no live US quotes from this path. ${res.status === 403
            ? "Key is NOT ENTITLED to /v2/snapshot; settled daily bars come from getSettledDailyQuotes instead."
            : "Transient or upstream error."}`
        );
        continue;
      }
      const data = await res.json();
      parseTickers(data?.tickers ?? [], retrievedAt);
    } catch (err) {
      console.error(`[quotes] Massive snapshot fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

/**
 * Settled daily bars for a whole market in ONE call.
 *
 * WHY THIS EXISTS. The deployed `MASSIVE_API_KEY` is not entitled to any
 * `/v2/snapshot` endpoint (403 NOT_AUTHORIZED) or `/v2/last/trade`, so the
 * snapshot batch path above resolves NOTHING for US symbols. Verified against
 * the live API on 2026-08-18. What the key IS entitled to:
 *
 *   /v2/aggs/grouped/locale/us/market/stocks/{date}   -> 200, 12,549 tickers
 *   /v2/aggs/ticker/{sym}/prev                        -> 200
 *   /v2/aggs/ticker/{sym}/range/1/day/...             -> 200 (DELAYED)
 *
 * The grouped endpoint returns every US ticker's settled OHLCV for one session
 * in a single request — strictly better than the per-symbol snapshot for
 * post-close work, and it includes ETFs (XAR, VOO), so no second pass is needed.
 *
 * SCOPE. These are SETTLED DAILY bars, not intraday. This is exactly right for
 * post-close consumers (PositionMonitor marks/stops/targets at 16:15 ET) and
 * WRONG for intraday callers like the Live Portfolio refresh — which is why this
 * is a separate function and not a blanket replacement inside `getBatchQuotes`.
 *
 * Freshness is not asserted here beyond the requested session: the caller asks
 * for `expectedNewestSession`, and a bar returned for that date IS that session.
 */
export async function fetchMassiveGroupedDaily(
  sessionDate: string,
  symbols: string[],
  apiKey: string,
): Promise<Record<string, DeterministicQuote>> {
  const out: Record<string, DeterministicQuote> = {};
  if (!apiKey || symbols.length === 0) return out;
  const want = new Set(symbols);
  try {
    const url = `https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}?adjusted=true&apiKey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error(`[quotes] Massive grouped-daily HTTP ${res.status} for ${sessionDate} — no settled US bars this run.`);
      return out;
    }
    const data = await res.json();
    const rows: any[] = Array.isArray(data?.results) ? data.results : [];
    // A 200 with an empty body means the session has no published bars yet
    // (too soon after the close, or a non-trading day). That is not the same as
    // "these symbols have no price" and must not read as one.
    if (rows.length === 0) {
      console.error(`[quotes] Massive grouped-daily returned 0 rows for ${sessionDate} — session not published yet?`);
      return out;
    }
    // The bar's own session close is its provenance, never the time we read it.
    const retrievedAt = `${sessionDate}T20:00:00Z`;
    for (const row of rows) {
      const sym = row?.T;
      if (!sym || !want.has(sym)) continue;
      const close = Number(row?.c);
      if (!Number.isFinite(close) || close <= 0) continue;
      const open = Number(row?.o);
      const change = Number.isFinite(open) && open > 0 ? close - open : null;
      out[sym] = {
        symbol: sym,
        price: close,
        bid: null,
        ask: null,
        change,
        changePct: change != null && Number.isFinite(open) && open > 0 ? (change / open) * 100 : null,
        source: "massive",
        retrievedAt,
        stale: false,
        dayLow: Number.isFinite(Number(row?.l)) && Number(row.l) > 0 ? Number(row.l) : null,
        dayHigh: Number.isFinite(Number(row?.h)) && Number(row.h) > 0 ? Number(row.h) : null,
      };
    }
  } catch (err) {
    console.error(`[quotes] Massive grouped-daily fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * Post-close batch quotes: settled daily bars first, existing chain for the tail.
 *
 * Use this from consumers that run AFTER the close and want the session's
 * settled price (PositionMonitor). Intraday consumers must keep using
 * `getBatchQuotes`.
 */
export async function getSettledDailyQuotes(
  symbols: string[],
  supabase: any,
  market: "us" | "india" = "us",
  now: Date = new Date(),
): Promise<Record<string, DeterministicQuote>> {
  if (symbols.length === 0) return {};
  // India is not covered by the US grouped endpoint; fall straight through.
  if (market !== "us") return getBatchQuotes(symbols, supabase);

  const session = expectedNewestSession("us", now);
  const grouped = await fetchMassiveGroupedDaily(session, symbols, process.env.MASSIVE_API_KEY ?? "");
  let missing = symbols.filter((s) => !grouped[s]);
  if (missing.length === 0) return grouped;

  // YAHOO BEFORE THE ORDINARY CHAIN. Measured 2026-08-19/20: the grouped feed
  // publishes NEXT-DAY, so at 16:15 ET it returns nothing and the ordinary chain
  // then resolves from Alpha Vantage — which serves the PREVIOUS session's
  // close. Yahoo already carries the just-closed session at that hour. Comparing
  // what each vendor gave during the 20:15 run against the settled 2026-08-19
  // closes: Yahoo NVDA 217.56 / XAR 284.10 were exact, KGC 29.92 vs 29.90 was
  // 0.07% out, while AV gave 219.74 / 294.87 / 27.12 — all the prior session.
  //
  // That mis-ordering closed four positions on stale prices before the priceMap
  // cross-check gate caught it. Yahoo is keyless and unbudgeted, so preferring
  // it here costs no quota.
  const yahooResults: Record<string, DeterministicQuote> = {};
  try {
    const yq = await fetchYahooQuotes(missing, "us");
    for (const sym of missing) {
      const q = yq[sym.toUpperCase()];
      if (q && !q.stale && q.price > 0) {
        yahooResults[sym] = {
          symbol: sym,
          price: q.price,
          bid: null,
          ask: null,
          change: null,
          changePct: Number.isFinite(q.changePct) ? q.changePct : null,
          source: "yahoo",
          retrievedAt: q.retrievedAt ?? new Date().toISOString(),
          stale: false,
        };
      }
    }
  } catch { /* fall through to the ordinary chain */ }
  missing = missing.filter((s) => !yahooResults[s]);
  if (missing.length === 0) return { ...grouped, ...yahooResults };

  // Whatever neither the grouped feed nor Yahoo carried still goes through the
  // ordinary chain, which fails closed on staleness rather than inventing a price.
  const rest = await getBatchQuotes(missing, supabase);
  return { ...grouped, ...yahooResults, ...rest };
}

/** Try price_cache for most recent closing price (EOD fallback) */
async function fetchCachedQuote(symbol: string, supabase: any): Promise<DeterministicQuote | null> {
  try {
    const { data } = await supabase
      .from("price_cache")
      .select("close, cached_at, date")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(1)
      .single();

    if (!data || !data.close) return null;

    // Freshness follows the market date represented by the bar, not when an old
    // row happened to be re-read or re-cached.
    //
    // 2026-08-17: this previously used `isStale(retrievedAt)`, a 4-CALENDAR-DAY
    // window. At 16:15 ET on Monday `isMarketHours()` is false, so Friday's bar
    // (age 3.01d < 4d) was returned `stale:false` and every US position was
    // marked, stop-checked and target-checked against a three-day-old close.
    //
    // The question is not "how many days old" but "is this the session that
    // should exist by now". NOTE: W9's `isFreshSessionDate` is NOT sufficient
    // here — it delegates to `lastCompletedMarketSession`, which always steps
    // back a day and so still accepts Friday at 16:15 ET Monday. That leniency
    // is right for an EOD cache mid-session and wrong after the close.
    const retrievedAt = data.date + "T20:00:00Z";
    const barMarket = symbol.endsWith(".NS") ? "india" : "us";
    return {
      symbol,
      price: Number(data.close),
      bid: null,
      ask: null,
      change: null,
      changePct: null,
      source: "price_cache",
      retrievedAt,
      stale: String(data.date) < expectedNewestSession(barMarket, new Date()),
    };
  } catch {
    return null;
  }
}

/**
 * Get a deterministic quote with provenance.
 * Priority: Massive snapshot (FREE, uncapped) → price_cache (EOD, free) →
 * Alpha Vantage GLOBAL_QUOTE (LAST — 25/day free cap) → unavailable.
 *
 * AV is deliberately last so US+India research can score every symbol without
 * ever leading with the capped provider. It's only reached when both the free
 * Massive snapshot AND the local EOD cache miss (e.g. a thin/new symbol Massive
 * doesn't cover). Mirrors getBatchQuotes' Massive-first ordering.
 */
export async function getQuote(symbol: string, supabase: any): Promise<DeterministicQuote> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const massiveKey = process.env.MASSIVE_API_KEY ?? "";
  const unavailable: DeterministicQuote = {
    symbol, price: 0, bid: null, ask: null, change: null, changePct: null,
    source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
  };

  // 1. Massive snapshot — free, no daily cap (single-symbol via the batch path).
  const massive = await fetchMassiveBatchQuotes([symbol], massiveKey);
  if (massive[symbol]) return massive[symbol];

  // 2. price_cache (EOD — fine outside market hours, free).
  const cached = await fetchCachedQuote(symbol, supabase);
  if (cached && !cached.stale) return cached;

  // 3. Alpha Vantage — LAST resort only; every hit counts against the 25/day cap.
  const avQuote = await fetchAVQuote(symbol, avKey);
  if (avQuote) return avQuote;

  // A stale close is still useful to read-only callers, but it remains marked
  // stale so execution and exit paths can fail closed.
  return cached ?? unavailable;
}

/**
 * Batch quote fetch.
 * Priority: Massive snapshot (one HTTP call for all symbols) → fresh price_cache
 * → Alpha Vantage reserve → explicitly stale cache → unavailable.
 * Massive is primary because AV's 25 calls/day free tier can't cover a
 * ~26-symbol portfolio refresh — see fetchMassiveBatchQuotes above.
 */
export async function getBatchQuotes(
  symbols: string[],
  supabase: any
): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  if (symbols.length === 0) return results;

  const massiveKey = process.env.MASSIVE_API_KEY ?? "";
  const massiveResults = await fetchMassiveBatchQuotes(symbols, massiveKey);
  Object.assign(results, massiveResults);

  const remaining = symbols.filter(s => !results[s]);
  if (remaining.length > 0) {
    // Do not call getQuote() here: it would retry Massive once per missed
    // symbol, recreating the N-symbol burst this batch path exists to prevent.
    // Read the durable EOD cache first, then spend scarce AV calls only for the
    // genuinely unresolved tail.
    const chunks: string[][] = [];
    for (let i = 0; i < remaining.length; i += 5) chunks.push(remaining.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async s => {
        const cached = await fetchCachedQuote(s, supabase);
        if (cached && !cached.stale) {
          results[s] = cached;
          return;
        }
        const av = await fetchAVQuote(s, process.env.ALPHA_VANTAGE_API_KEY ?? "");
        results[s] = av ?? cached ?? {
          symbol: s, price: 0, bid: null, ask: null, change: null, changePct: null,
          source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
        };
      }));
    }
  }

  return results;
}

/**
 * Fill price for paper trades:
 * - During market hours: use ask price if available, else price + 0.05% (bid/ask spread model)
 * - Apply additional 0.05% slippage
 */
export function computeFillPrice(quote: DeterministicQuote): number {
  const base = quote.ask ?? quote.price;
  const slippage = 0.0005; // 0.05%
  return parseFloat((base * (1 + slippage)).toFixed(4));
}

/** Conservative paper SELL fill when no executable bid is available. */
export function computeExitFillPrice(price: number, bid?: number | null): number {
  const base = bid != null && Number.isFinite(bid) && bid > 0 ? bid : price;
  return parseFloat((base * (1 - 0.0005)).toFixed(4));
}
