// Per-user (guest) risk analytics.
//
// Same maths as the owner's daily risk job — `computeRiskMetrics` and
// `computeCorrelationClusters` are reused unchanged — but a DIFFERENT data
// budget, which is the whole reason this module exists rather than a flag on
// the owner's job.
//
// THE COST RULE (features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §6):
// "a guest-triggered path may call a broker, and may read cache, but may never
// call an LLM or a metered market-data provider outside the shared cache."
//
// What that means concretely, after tracing the candle path:
//   • `fetchYahooCandles` hits Yahoo's keyless chart endpoint. No API key, no
//     quota, no budget line. Guests may use it.
//   • `fetchUsCandles` (lib/data/candles.ts) tries Yahoo FIRST but then falls
//     back through Massive → EODHD → TwelveData → Alpha Vantage, all metered and
//     several already over budget. A guest holding an obscure symbol would walk
//     that whole chain. Guests may NOT use it.
//
// So this module imports the unmetered fetcher only. A symbol Yahoo cannot serve
// is recorded as UNCOVERED and its risk evidence is reported missing — never
// escalated to a paid provider, and never silently treated as zero risk. That
// makes the guest cost structurally zero on metered providers rather than
// something to be measured and hoped about, and it is enforced by
// `tests/guest-risk-budget.test.ts` reading this file's imports.
//
// There is also no LLM here: the owner's job runs a best-effort prose pass
// (`strategyNotes`), and guests deliberately get the deterministic scorer only.

import { computeRiskMetrics, type RiskMetrics } from "@/lib/portfolio-risk";
import { computeCorrelationClusters, type CorrelationCluster } from "@/lib/risk/correlation";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import type { Candle } from "@/lib/data/technicals";
import type { BrokerHolding } from "@/lib/brokers/types";
import type { GuestHolding } from "@/lib/brokers/guest-readonly";

export type GuestMarket = "us" | "india";

/**
 * Yahoo needs an exchange suffix for Indian symbols; Zerodha's `tradingsymbol`
 * has none. Mirrors lib/brokers/index.ts:177 so both paths ask Yahoo the same
 * question for the same holding.
 */
export function yahooSymbolFor(symbol: string, market: GuestMarket): string {
  if (market !== "india") return symbol;
  const s = symbol.toUpperCase();
  return s.endsWith(".NS") || s.endsWith(".BO") ? s : `${s}.NS`;
}

/**
 * Broker holdings → the shape the shared risk maths takes.
 *
 * A holding with no last price has NO market value we can defend, so it is
 * dropped and counted rather than valued at zero — a zero-valued position would
 * silently shrink every concentration percentage that follows.
 */
export function toBrokerHoldings(
  holdings: GuestHolding[],
  market: GuestMarket,
): { holdings: BrokerHolding[]; unpriced: string[] } {
  const out: BrokerHolding[] = [];
  const unpriced: string[] = [];
  for (const h of holdings) {
    const qty = Number(h.quantity);
    const price = h.lastPrice == null ? NaN : Number(h.lastPrice);
    if (!h.symbol || !Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) {
      unpriced.push(h.symbol);
      continue;
    }
    const cost = h.averageCost == null ? undefined : Number(h.averageCost) * qty;
    out.push({
      symbol: yahooSymbolFor(h.symbol, market),
      qty,
      currentPrice: price,
      marketValue: price * qty,
      costBasis: cost,
      side: "long",
      // Guest holdings are read from the user's own broker; they are not the
      // owner's book and must never be attributed to it.
      source: "kite" as BrokerHolding["source"],
    });
  }
  return { holdings: out, unpriced };
}

export type GuestRiskCoverage = {
  /** Symbols held after pricing. */
  symbols: number;
  /** Symbols Yahoo served enough history for. */
  covered: number;
  /** Held symbols with no usable unmetered history — evidence missing, not zero. */
  uncovered: string[];
  /** Dropped before valuation because the broker gave no price. */
  unpriced: string[];
};

export type GuestRiskResult = {
  metrics: RiskMetrics;
  clusters: Record<string, CorrelationCluster>;
  coverage: GuestRiskCoverage;
};

/** Minimum bars before a series is worth correlating; matches the owner's job. */
const MIN_BARS = 60;

/**
 * Compute a guest's portfolio risk from their own holdings.
 *
 * `fetchCandles` is injectable so tests can prove the budget rule without
 * network access; the default is the unmetered Yahoo fetcher and nothing else.
 */
export async function computeGuestRisk(
  guestHoldings: GuestHolding[],
  market: GuestMarket,
  opts: {
    navValue?: number;
    currency?: string;
    fetchCandles?: (symbol: string) => Promise<Candle[]>;
  } = {},
): Promise<GuestRiskResult> {
  const fetchCandles = opts.fetchCandles ?? ((s: string) => fetchYahooCandles(s, "1y"));
  const { holdings, unpriced } = toBrokerHoldings(guestHoldings, market);

  const metrics = await computeRiskMetrics(holdings, undefined, {
    market,
    currency: opts.currency,
    navValue: opts.navValue,
  });

  const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
  const candlesBySymbol = new Map<string, Candle[]>();
  const uncovered: string[] = [];
  await Promise.all(
    symbols.map(async (sym) => {
      const candles = await fetchCandles(sym).catch(() => [] as Candle[]);
      if (candles.length >= MIN_BARS) {
        candlesBySymbol.set(sym, candles);
      } else {
        uncovered.push(sym);
        // Enter it with an EMPTY series rather than omitting it. The cluster
        // function reports a symbol it can see but cannot correlate as
        // `computable: false` / `avgCorr: null` — an explicit "unknown". Omitting
        // it would produce no record at all, which reads downstream as "not
        // considered" and is a different, weaker claim than "no usable history".
        candlesBySymbol.set(sym, []);
      }
    }),
  );

  const total = holdings.reduce((s, h) => s + h.marketValue, 0);
  const weightBySymbol = new Map<string, number>();
  for (const h of holdings) {
    const w = total > 0 ? h.marketValue / total : 0;
    weightBySymbol.set(h.symbol, (weightBySymbol.get(h.symbol) ?? 0) + w);
  }

  const clusters = computeCorrelationClusters(candlesBySymbol, weightBySymbol);

  return {
    metrics,
    clusters: Object.fromEntries(clusters),
    coverage: {
      symbols: symbols.length,
      covered: symbols.length - uncovered.length,
      uncovered: uncovered.sort(),
      unpriced: unpriced.sort(),
    },
  };
}
