// Single source of truth for per-page country support. The DashboardShell footer
// reads this by longest-matching route prefix and renders a badge, so every page
// honestly advertises whether it works for US, India, both, or partially.
//
// As a panel gains India coverage (Phase 5 waves), flip its entry HERE — nowhere
// else. Keep this in sync with system-map.json / ARCHITECTURE when a level changes.

export type SupportLevel = "full" | "partial" | "us-only" | "india-only";

export type MarketSupport = {
  level: SupportLevel;
  note: string; // one honest line: what works, what doesn't
};

// Route prefix → support. Longest prefix wins (so /dashboard/agents/history beats
// /dashboard/agents beats /dashboard).
const REGISTRY: Record<string, MarketSupport> = {
  "/dashboard/live-portfolio": { level: "us-only",    note: "Live Robinhood account (US brokerage). India live holdings live on the India page." },
  "/dashboard/india":          { level: "india-only", note: "India-only: NSE/BSE via Zerodha Kite + free Yahoo data." },
  "/dashboard/markets":        { level: "us-only",    note: "US indices/sectors/VIX today. India indices (NIFTY/SENSEX) land in Phase 5." },
  "/dashboard/scanner":        { level: "us-only",    note: "US screen (Alpha Vantage/FinancialDatasets). India scan (NIFTY-200) lands in Phase 5." },
  "/dashboard/backtest":       { level: "us-only",    note: "US price history today. India backtest (Yahoo .NS candles) lands in Phase 5." },
  "/dashboard/strategies":     { level: "us-only",    note: "US-oriented fit scores today. India strategies land in Phase 5." },
  "/dashboard/calendar":       { level: "us-only",    note: "US earnings (Alpha Vantage). India earnings dates land in Phase 5 (per-symbol only)." },
  "/dashboard/risk":           { level: "us-only",    note: "US book risk today. Per-₹-book India risk lands in Phase 5." },
  "/dashboard/smart-money":    { level: "partial",    note: "India signals flow in; insider + options flow stay US-only (no free India feed)." },
  "/dashboard/scores":         { level: "full",       note: "US + India both scored and tracked (market-tagged)." },
  "/dashboard/intelligence":   { level: "full",       note: "US + India agent signals + research runs." },
  "/dashboard/portfolio":      { level: "full",       note: "US ($) and India (₹) paper pools — switch markets in the header. Never blended." },
  "/dashboard/agents/history": { level: "full",       note: "Every agent run across both markets." },
  "/dashboard/agents":         { level: "full",       note: "Agents run for both markets (India via free Yahoo data)." },
  "/dashboard/watchlist":      { level: "full",       note: "US and India symbols both trackable." },
  "/dashboard/mentor":         { level: "full",       note: "Coaches on outcomes from both markets." },
  "/dashboard/journal":        { level: "full",       note: "Audit trail spans US + India (market-tagged)." },
  "/dashboard/settings":       { level: "full",       note: "Config applies to both markets. Turn India on/off under Market focus." },
  "/dashboard/admin":          { level: "full",       note: "Keys/vault/config for both markets." },
  "/dashboard":                { level: "full",       note: "Morning Briefing shows both US and India sections." },
};

export function getMarketSupport(pathname: string): MarketSupport {
  let best = "";
  for (const prefix of Object.keys(REGISTRY)) {
    if ((pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix)) && prefix.length > best.length) {
      best = prefix;
    }
  }
  return REGISTRY[best] ?? REGISTRY["/dashboard"];
}

export const SUPPORT_META: Record<SupportLevel, { label: string; flags: string; color: string }> = {
  "full":       { label: "Full support",   flags: "🇺🇸 🇮🇳", color: "#34D399" },
  "partial":    { label: "Partial",        flags: "🇺🇸 🇮🇳", color: "#FBBF24" },
  "us-only":    { label: "US only",        flags: "🇺🇸",     color: "#60A5FA" },
  "india-only": { label: "India only",     flags: "🇮🇳",     color: "#60A5FA" },
};
