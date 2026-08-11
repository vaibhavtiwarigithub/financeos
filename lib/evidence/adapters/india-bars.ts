// Canonical Evidence Router — India `price.daily_bars`, one adapter per source.
//
// WHY THIS EXISTS
// India's only route to daily bars was `observedBarsAdapter` — the kairos
// compatibility bridge, which writes canonical cache rows from candles the
// LEGACY ResearchAgent already fetched. That is enough for today's cohort to
// show parity (India bars coverage is currently 100%, not the 0% an older
// cutover note recorded), but it is not a provider-native path: the bridge only
// has data because the legacy fetch ran first.
//
// The consequence is a rollback dependency, which is exactly what §8.9 forbids
// carrying into legacy retirement — "remove legacy code only after ... a release
// proving no rollback dependency remains". With only the bridge, retiring the
// legacy India candle fetch would silently empty India's REQUIRED technical
// field. These adapters give India its own native chain (Upstox → Yahoo),
// mirroring the US chain (Massive → EODHD → TwelveData), so the Router can serve
// India bars without the legacy path underneath it.
//
// SEMANTICS — the part that matters for parity
// The legacy India path calls `fetchUpstoxCandles(symbol)` then falls back to
// `fetchYahooCandles(symbol)` with NO options, so `options.adjusted` is
// undefined and Yahoo returns RAW traded closes. These adapters therefore
// declare `adjusted: false`, matching the series the scorer actually consumes
// today. Declaring `true` here would be a hard §4 parity mismatch (no tolerance
// is allowed across adjusted/unadjusted) and it would surface as unexplained
// score drift rather than as the contract error it really is.
//
// Switching either India source to a corporate-action-adjusted basis is a
// deliberate semantic change that needs its own parity evaluation — it is not
// something an adapter should smuggle in while claiming to preserve behavior.

import type { ProviderAdapter } from "@/lib/evidence/contracts";
import { makeBarsAdapter } from "@/lib/evidence/adapters/bars";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";

// Upstox — official NSE data, analytics token, day-cached under the upstox
// provider budget inside providerCachedFetch, so the ADAPTER owns the lease and
// the router must not take a second one. Primary for the same reason the legacy
// path prefers it: the Yahoo chart endpoint can change shape or anti-bot without
// notice, Upstox cannot.
export const upstoxBarsAdapter: ProviderAdapter = makeBarsAdapter({
  providerId: "upstox",
  contractVersion: "india-bars-upstox-v1",
  fetchCandles: (symbol) => fetchUpstoxCandles(symbol),
  markets: ["india"],
  pacingOwner: "adapter",
  adjusted: false,
  currency: "INR",
});

// Yahoo chart — unofficial, no key, no crumb needed. Scoped to India at the
// ADAPTER level, not the provider level: the `yahoo` provider legitimately
// serves fundamentals in both markets, so widening its spec would have added
// Yahoo to the US bars chain and changed US resolution. `fetchYahooCandles`
// uses a plain fetch (no providerCachedFetch), so it takes no lease of its own
// and the ROUTER owns pacing here.
export const yahooIndiaBarsAdapter: ProviderAdapter = makeBarsAdapter({
  providerId: "yahoo",
  contractVersion: "india-bars-yahoo-v1",
  // Default range "6mo" and no adjust option — byte-for-byte the call the
  // legacy India fallback makes.
  fetchCandles: (symbol) => fetchYahooCandles(symbol),
  markets: ["india"],
  pacingOwner: "router",
  adjusted: false,
  currency: "INR",
});
