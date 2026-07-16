// Canonical Evidence Router — Twelve Data adapter (price.daily_bars).
//
// Split out of the old bundled "massive" bars adapter (router-cutover §8). Twelve
// Data is the tail-backer for US daily bars (800 calls/day vs Massive's 5/min),
// so it frequently WAS the true serving source while provenance said "massive".
// It is now its own Router adapter.
//
// ADDITIVE. router_enabled stays false; lib/data/candles.ts still owns today's
// acquisition path unchanged.

import type { ProviderAdapter } from "@/lib/evidence/contracts";
import { fetchTwelveDataCandles } from "@/lib/data/candles";
import { makeBarsAdapter } from "@/lib/evidence/adapters/bars";

export const twelvedataBarsAdapter: ProviderAdapter = makeBarsAdapter({
  providerId: "twelvedata",
  contractVersion: "twelvedata-bars-v1",
  // The helper already sorts oldest-first (EMA needs ascending) and filters
  // non-finite closes, so the canonical shape matches the other bars sources.
  fetchCandles: (symbol) => fetchTwelveDataCandles(symbol),
});
