// Canonical Evidence Router — EODHD adapter (price.daily_bars).
//
// Split out of the old bundled "massive" bars adapter (router-cutover §8): EODHD
// used to serve bars under Massive's name whenever Massive came up short. It is
// now its own Router adapter with its own provider id, contract version, and
// pacing, so provenance names the source that actually served and policy can
// disable it independently.
//
// ADDITIVE. router_enabled stays false; the legacy path (lib/data/candles.ts
// fetchUsCandles) is untouched and still owns today's acquisition.

import type { ProviderAdapter } from "@/lib/evidence/contracts";
import { fetchEodhdCandles } from "@/lib/data/candles";
import { makeBarsAdapter } from "@/lib/evidence/adapters/bars";

export const eodhdBarsAdapter: ProviderAdapter = makeBarsAdapter({
  providerId: "eodhd",
  contractVersion: "eodhd-bars-v1",
  // EODHD's helper maps adjusted_close into `close` — same adjusted basis as
  // every other US bars source, which is what makes them substitutable at all.
  fetchCandles: (symbol) => fetchEodhdCandles(symbol),
});
