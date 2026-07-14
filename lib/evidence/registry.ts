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

// Default ordered chains per intent. Order = Auto-mode fallback order. Finnhub
// leads US fundamentals while Webull shadows (Webull fundamentals are QUARTERLY —
// must pass shadow-compare before becoming a scoring fallback; see §22 + §13).
export const ADAPTERS_BY_INTENT: Partial<Record<EvidenceIntent, ProviderAdapter[]>> = {
  "fundamentals.reported": [finnhubFundamentalsAdapter, webullFundamentalsAdapter, yahooFundamentalsAdapter],
  "analyst.consensus":     [webullAnalystAdapter],
  "insider.transactions":  [massiveInsiderAdapter],
  "price.daily_bars":      [massiveBarsAdapter],
  // sentiment.news / fundamentals.valuation / macro.regime_inputs / events.* /
  // price.quote — deferred: their existing chains stay legacy until adapters land.
};

// Flat list of every registered adapter (for capability-status seeding + tests).
export const ALL_ADAPTERS: ProviderAdapter[] = Object.values(ADAPTERS_BY_INTENT).flat();

// Resolve the ordered adapters for an intent, filtered to those whose provider
// spec supports the market. Pure — no DB, no network.
export function adaptersForIntent(intent: EvidenceIntent, market: Market): ProviderAdapter[] {
  const chain = ADAPTERS_BY_INTENT[intent] ?? [];
  return chain.filter((a) => {
    const spec = PROVIDER_SPECS[a.providerId];
    return !spec || spec.markets.includes(market);
  });
}

// Code-owned provider capability/limit specs. DB overrides
// (provider_runtime_config) can only make these MORE conservative. Only the
// providers with a registered adapter are listed here for now.
export const PROVIDER_SPECS: Partial<Record<ProviderId, ProviderSpec>> = {
  finnhub: {
    id: "finnhub", label: "Finnhub", transport: "http",
    markets: ["us"], capabilities: ["fundamentals.reported"],
    dailyLimitState: "none", rateLimitState: "known", rateLimitCalls: 60, rateLimitWindowSeconds: 60,
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: false, trustTier: 2, official: true,
  },
  yahoo: {
    id: "yahoo", label: "Yahoo Finance", transport: "http",
    markets: ["us", "india"], capabilities: ["fundamentals.reported"],
    dailyLimitState: "unknown", rateLimitState: "unknown",
    minIntervalMs: 0, reserveCalls: 0, entitlementRequired: false, trustTier: 3, official: false,
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
};
