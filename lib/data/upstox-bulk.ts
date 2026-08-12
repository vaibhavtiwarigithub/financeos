// Upstox bulk market-quote sweep — CHEAP ELIGIBILITY PREFILTER for the India scan.
//
// WHAT THIS IS NOT: a replacement for the Yahoo per-symbol path. Upstox's
// market-quote endpoint is pricing-only. It carries NO fundamentals (P/E, margin,
// ROE, growth, sector, name) and there is no BULK historical endpoint, so RSI /
// EMA50 / above_ma50 still require the per-symbol candle fetch. Of the ten fields
// india_screen_cache stores, this can supply exactly one (price). Swapping the
// Yahoo path out for this would blank the other nine.
//
// WHAT IT IS FOR: deciding WHICH names deserve the expensive path. The India scan
// can afford ~600 Yahoo symbol-fetches per night against a ~2,376-name NSE
// universe, so it previously rotated through the universe blind — spending that
// budget on illiquid and circuit-locked names that could never be traded. This
// sweep prices the ENTIRE universe in ~5 requests (500 instruments per call,
// ~400ms each, measured) and marks what is actually tradeable, so the Yahoo
// budget lands on eligible names instead.
//
// Two fields here exist nowhere else in the system:
//   - `volume`, enabling a real turnover floor (we had no liquidity filter at all)
//   - circuit limits, which in India mark a name that literally cannot be traded
//     today. Nothing else we fetch exposes that.
//
// FAIL-OPEN: every failure path returns an empty sweep, and the caller is
// required to fall back to its previous behaviour. A screening prefilter that
// silently empties the candidate pool is far worse than one that does nothing.

import { createServiceClient } from "@/lib/supabase/service";

const QUOTES_URL = "https://api.upstox.com/v2/market-quote/quotes";
// 500 verified working in one request (~393ms). Kept at 400 for headroom against
// URL-length limits once instrument keys are percent-encoded.
const BATCH = 400;
const BATCH_PAUSE_MS = 150;

export interface BulkQuote {
  /** Yahoo-style symbol, e.g. "TCS.NS" — the key india_screen_cache uses. */
  symbol: string;
  lastPrice: number | null;
  volume: number | null;
  lowerCircuit: number | null;
  upperCircuit: number | null;
}

export interface PrefilterConfig {
  /** Minimum last price in INR. Penny stocks are noise and often unfillable. */
  minPrice: number;
  /** Minimum turnover proxy = lastPrice * volume, in INR. */
  minTurnover: number;
  /** Drop names sitting at their circuit limit (untradeable today). */
  excludeCircuitLocked: boolean;
}

export const DEFAULT_PREFILTER: PrefilterConfig = {
  minPrice: 20,
  minTurnover: 10_000_000, // ₹1 crore/day
  excludeCircuitLocked: true,
};

export type PrefilterReason =
  | "eligible"
  | "no_price"
  | "no_volume"
  | "below_price_floor"
  | "below_turnover_floor"
  | "circuit_locked";

export interface PrefilterVerdict {
  eligible: boolean;
  reason: PrefilterReason;
  turnover: number | null;
}

/**
 * Circuit-lock test. A name trading AT its band cannot move further in that
 * direction, so an entry cannot be filled at a sane price. Compared with a small
 * relative epsilon rather than exact equality — the last trade can print a paisa
 * inside the band while still being locked.
 */
function atCircuit(price: number, limit: number | null): boolean {
  if (limit == null || !(limit > 0)) return false;
  return Math.abs(price - limit) / limit <= 0.001;
}

/** PURE. Decide whether one quote earns an expensive per-symbol fetch. */
export function screenQuote(q: BulkQuote, cfg: PrefilterConfig = DEFAULT_PREFILTER): PrefilterVerdict {
  const price = q.lastPrice;
  if (price == null || !(price > 0)) return { eligible: false, reason: "no_price", turnover: null };
  if (price < cfg.minPrice) return { eligible: false, reason: "below_price_floor", turnover: null };

  if (cfg.excludeCircuitLocked && (atCircuit(price, q.upperCircuit) || atCircuit(price, q.lowerCircuit))) {
    return { eligible: false, reason: "circuit_locked", turnover: null };
  }

  // Volume is null outside market hours for some instruments. That is unknown,
  // not zero — treat it as failing the liquidity test rather than inventing a
  // turnover of 0, but report it distinctly so the caller can see why coverage
  // shrank on a weekend run.
  if (q.volume == null) return { eligible: false, reason: "no_volume", turnover: null };

  const turnover = price * q.volume;
  if (turnover < cfg.minTurnover) return { eligible: false, reason: "below_turnover_floor", turnover };

  return { eligible: true, reason: "eligible", turnover };
}

/**
 * PURE. Narrow a universe to the eligible set, PRESERVING the caller's ordering.
 *
 * Deliberately does NOT re-rank by turnover. Ranking the expensive path by
 * liquidity would pin it to the same few hundred large caps forever and starve
 * every mid-cap of ever being scored. The scan's existing staleness order
 * (never-scored first, then oldest) is what keeps the rotation fair; this only
 * removes names that could not be traded anyway.
 */
export function applyPrefilter(
  orderedUniverse: string[],
  quotes: Map<string, BulkQuote>,
  cfg: PrefilterConfig = DEFAULT_PREFILTER,
): { eligible: string[]; rejected: Record<PrefilterReason, number>; unknown: string[] } {
  const rejected: Record<PrefilterReason, number> = {
    eligible: 0, no_price: 0, no_volume: 0,
    below_price_floor: 0, below_turnover_floor: 0, circuit_locked: 0,
  };
  const eligible: string[] = [];
  const unknown: string[] = [];

  for (const sym of orderedUniverse) {
    const q = quotes.get(sym);
    if (!q) {
      // Not present in the sweep at all (no instrument key, or Upstox omitted it).
      // Keep it: absence of evidence must not silently shrink the universe.
      unknown.push(sym);
      eligible.push(sym);
      continue;
    }
    const v = screenQuote(q, cfg);
    rejected[v.reason]++;
    if (v.eligible) eligible.push(sym);
  }
  return { eligible, rejected, unknown };
}

/**
 * Sweep the whole universe. Returns an EMPTY map on any failure so the caller
 * falls back to its prior behaviour rather than screening nothing.
 */
export async function fetchUpstoxBulkQuotes(symbols?: string[]): Promise<Map<string, BulkQuote>> {
  const out = new Map<string, BulkQuote>();
  const token = process.env.UPSTOX_ACCESS_TOKEN ?? "";
  if (!token) return out;

  try {
    const svc = createServiceClient();
    let q = svc.from("upstox_instruments").select("trading_symbol, instrument_key");
    const { data: rows, error } = await q;
    if (error || !rows?.length) return out;

    const want = symbols ? new Set(symbols.map(s => s.toUpperCase())) : null;
    const pairs: { symbol: string; key: string }[] = [];
    for (const r of rows as any[]) {
      const ts = String(r.trading_symbol ?? "").toUpperCase();
      const key = String(r.instrument_key ?? "");
      if (!ts || !key) continue;
      const symbol = `${ts}.NS`;
      if (want && !want.has(symbol)) continue;
      pairs.push({ symbol, key });
    }
    if (!pairs.length) return out;

    const byKey = new Map(pairs.map(p => [p.key, p.symbol]));
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    for (let i = 0; i < pairs.length; i += BATCH) {
      const slice = pairs.slice(i, i + BATCH);
      const url = `${QUOTES_URL}?instrument_key=${slice.map(p => encodeURIComponent(p.key)).join(",")}`;
      let json: any;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue;   // skip this batch, keep the rest
        json = await res.json();
      } catch { continue; }

      for (const entry of Object.values(json?.data ?? {}) as any[]) {
        // Response is keyed "NSE_EQ:TCS"; instrument_token carries the key we sent.
        const symbol = byKey.get(String(entry?.instrument_token ?? ""))
          ?? (entry?.symbol ? `${String(entry.symbol).toUpperCase()}.NS` : null);
        if (!symbol) continue;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        out.set(symbol, {
          symbol,
          lastPrice: num(entry?.last_price) ?? num(entry?.ohlc?.close),
          volume: num(entry?.volume),
          lowerCircuit: num(entry?.lower_circuit_limit),
          upperCircuit: num(entry?.upper_circuit_limit),
        });
      }

      if (i + BATCH < pairs.length) await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
    return out;
  } catch {
    return out; // fail-open
  }
}
