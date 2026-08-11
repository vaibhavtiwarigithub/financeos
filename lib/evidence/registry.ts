// Canonical Evidence Router — code-owned adapter registry (Phase 2 foundation).
//
// The ONLY place that maps an evidence intent to its ordered provider adapters.
// A DB policy row can reorder/disable within this set, but can NEVER introduce a
// provider/intent pair absent here — the registry is the allowlist. Default
// chains follow features/data-source-policy/FEATURE_ARCHITECTURE.md §22.
//
// This is a pure lookup: importing it wires NOTHING into scoring or the money
// path. router_enabled stays false; no resolver consumes this yet.

import type { EvidenceIntent, ProviderAdapter, ProviderId, ProviderSpec, Market } from "@/lib/evidence/contracts";
import { finnhubFundamentalsAdapter } from "@/lib/evidence/adapters/finnhub";
import { yahooFundamentalsAdapter } from "@/lib/evidence/adapters/yahoo";
import { webullAnalystAdapter, webullFundamentalsAdapter } from "@/lib/evidence/adapters/webull";
import { massiveInsiderAdapter, massiveBarsAdapter } from "@/lib/evidence/adapters/massive";
import { eodhdBarsAdapter } from "@/lib/evidence/adapters/eodhd";
import { twelvedataBarsAdapter } from "@/lib/evidence/adapters/twelvedata";
import { edgarInsiderAdapter } from "@/lib/evidence/adapters/edgar";
import { upstoxBarsAdapter, yahooIndiaBarsAdapter } from "@/lib/evidence/adapters/india-bars";
import {
  observedBarsAdapter,
  observedFundamentalsAdapter,
  observedInsiderAdapter,
  observedMacroAdapter,
  observedSentimentAdapter,
} from "@/lib/evidence/adapters/kairos-observed";

// Default ordered chains per intent. Order = Auto-mode fallback order. Finnhub
// leads US fundamentals while Webull shadows (Webull fundamentals are QUARTERLY —
// must pass shadow-compare before becoming a scoring fallback; see §22 + §13).
export const ADAPTERS_BY_INTENT: Partial<Record<EvidenceIntent, ProviderAdapter[]>> = {
  "fundamentals.reported": [observedFundamentalsAdapter, finnhubFundamentalsAdapter, webullFundamentalsAdapter, yahooFundamentalsAdapter],
  "analyst.consensus":     [webullAnalystAdapter],
  // EDGAR (free, ~10/s, router-paced) first; Massive (5/min paced, richer detail) backs
  // the tail. Insider is sparse by nature — most names have <3 open-market trades.
  "insider.transactions":  [observedInsiderAdapter, edgarInsiderAdapter, massiveInsiderAdapter],
  // US candles: Massive → EODHD → TwelveData as an EXPLICIT router chain (§8).
  // These used to be one "massive" adapter that hid the fallback internally, so
  // provenance recorded a nominal source rather than the serving one and a
  // `mode: "only"` policy could not actually pin a provider. Each source is now
  // its own adapter; the router owns the fallback and the ledger sees three
  // distinct providers. Order is unchanged: Massive first (no daily cap),
  // TwelveData (800/day) backs the tail that Massive's 5/min starves.
  // NOTE: the resolver caps a single resolve at MAX_SYNC_ATTEMPTS=2 live calls,
  // so the third source is reached via the durable refresh queue rather than
  // synchronously — a deliberate Vercel wall-clock bound, not an oversight.
  // India's native sources (Upstox → Yahoo) sit after the US ones; each adapter
  // is market-scoped, so `adaptersForIntent` hands US exactly the chain it had
  // before and India its own. Without these India could only reach bars through
  // the kairos compatibility bridge, i.e. only while the legacy fetch still runs.
  "price.daily_bars":      [
    observedBarsAdapter,
    massiveBarsAdapter, eodhdBarsAdapter, twelvedataBarsAdapter,
    upstoxBarsAdapter, yahooIndiaBarsAdapter,
  ],
  "sentiment.news":        [observedSentimentAdapter],
  "macro.regime_inputs":   [observedMacroAdapter],
  // fundamentals.valuation / events.* /
  // price.quote — deferred: their existing chains stay legacy until adapters land.
};

// Flat list of every registered adapter (for capability-status seeding + tests).
export const ALL_ADAPTERS: ProviderAdapter[] = Object.values(ADAPTERS_BY_INTENT).flat();

// Resolve the ordered adapters for an intent, filtered to those whose provider
// spec supports the market. Pure — no DB, no network.
export function adaptersForIntent(intent: EvidenceIntent, market: Market): ProviderAdapter[] {
  const chain = ADAPTERS_BY_INTENT[intent] ?? [];
  return chain.filter((a) => {
    // An adapter may scope itself more narrowly than its provider, because
    // capability is per (provider, intent): Yahoo serves fundamentals in both
    // markets but bars only for India. Provider spec is the fallback.
    if (a.markets) return a.markets.includes(market);
    const spec = PROVIDER_SPECS[a.providerId];
    return !spec || spec.markets.includes(market);
  });
}

// Code-owned provider capability/limit specs. DB overrides
// (provider_runtime_config) can only make these MORE conservative. Only the
// providers with a registered adapter are listed here for now.
export const PROVIDER_SPECS: Partial<Record<ProviderId, ProviderSpec>> = {
  kairos: {
    id: "kairos", label: "Kairos observed evidence", transport: "internal",
    markets: ["us", "india"],
    capabilities: ["fundamentals.reported", "price.daily_bars", "sentiment.news", "macro.regime_inputs", "insider.transactions"],
    dailyLimitState: "none", rateLimitState: "none",
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: false, trustTier: 1, official: true,
  },
  finnhub: {
    id: "finnhub", label: "Finnhub", transport: "http",
    markets: ["us"], capabilities: ["fundamentals.reported"],
    dailyLimitState: "none", rateLimitState: "known", rateLimitCalls: 60, rateLimitWindowSeconds: 60,
    minIntervalMs: 1_000, reserveCalls: 0, entitlementRequired: false, trustTier: 2, official: true,
  },
  yahoo: {
    id: "yahoo", label: "Yahoo Finance", transport: "http",
    // Bars are India-only and enforced on the adapter (yahooIndiaBarsAdapter),
    // not here — listing the capability does not widen the US chain.
    markets: ["us", "india"], capabilities: ["fundamentals.reported", "price.daily_bars"],
    dailyLimitState: "unknown", rateLimitState: "unknown",
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: false, trustTier: 3, official: false,
  },
  upstox: {
    id: "upstox", label: "Upstox", transport: "http",
    markets: ["india"], capabilities: ["price.daily_bars"],
    // ~500/min documented; no daily cap. Kept conservative — the code-owned spec
    // may only be made MORE restrictive by provider_runtime_config, never less.
    dailyLimitState: "none", rateLimitState: "known", rateLimitCalls: 250, rateLimitWindowSeconds: 60,
    minIntervalMs: 250, reserveCalls: 0, entitlementRequired: true, credentialRef: "UPSTOX_ACCESS_TOKEN",
    trustTier: 1, official: true,
  },
  webull: {
    id: "webull", label: "Webull", transport: "mcp",
    markets: ["us"], capabilities: ["analyst.consensus", "fundamentals.reported"],
    dailyLimitState: "unknown", rateLimitState: "unknown",
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: true, credentialRef: "WEBULL_MCP_ACCESS_TOKEN",
    trustTier: 2, official: true,
  },
  massive: {
    id: "massive", label: "Massive", transport: "http",
    markets: ["us"], capabilities: ["insider.transactions", "price.daily_bars"],
    dailyLimitState: "none", rateLimitState: "known", rateLimitCalls: 5, rateLimitWindowSeconds: 60,
    minIntervalMs: 12_500, reserveCalls: 0, entitlementRequired: false, trustTier: 2, official: true,
  },
  eodhd: {
    id: "eodhd", label: "EODHD", transport: "http",
    markets: ["us"], capabilities: ["price.daily_bars"],
    // Free tier is day-capped; the exact ceiling is not documented per-key, so
    // it stays "unknown" rather than being displayed as unlimited (§3 P1).
    dailyLimitState: "unknown", rateLimitState: "unknown",
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: false, credentialRef: "EODHD_API_KEY",
    trustTier: 2, official: true,
  },
  twelvedata: {
    id: "twelvedata", label: "Twelve Data", transport: "http",
    markets: ["us"], capabilities: ["price.daily_bars"],
    dailyLimitState: "known", dailyLimit: 800,
    rateLimitState: "known", rateLimitCalls: 8, rateLimitWindowSeconds: 60,
    minIntervalMs: 7_500, reserveCalls: 0, entitlementRequired: false, credentialRef: "TWELVEDATA_API_KEY",
    trustTier: 2, official: true,
  },
  sec: {
    id: "sec", label: "SEC EDGAR", transport: "http",
    markets: ["us"], capabilities: ["insider.transactions"],
    dailyLimitState: "none", rateLimitState: "known", rateLimitCalls: 10, rateLimitWindowSeconds: 1,
    minIntervalMs: 100, reserveCalls: 0, entitlementRequired: false, trustTier: 1, official: true,
  },
};
