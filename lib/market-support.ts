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
  // true = SHOULD respect the header market switcher but doesn't yet (a bug to
  // fix); false/omitted = "us-only"/"india-only" is intentional by design
  // (e.g. a live-broker page that only has one market's account connected).
  // Lets the nav badge (DashboardShell) render these two very different
  // situations differently instead of both just saying "US only".
  knownGap?: boolean;
};

// Route prefix → support. Longest prefix wins (so /dashboard/agents/history beats
// /dashboard/agents beats /dashboard).
const REGISTRY: Record<string, MarketSupport> = {
  "/dashboard/live-portfolio": { level: "us-only",    note: "Live Robinhood account (US brokerage). India live holdings live on the India page." },
  "/dashboard/india":          { level: "india-only", note: "India-only: NSE/BSE via Zerodha Kite + free Yahoo data." },
  "/dashboard/markets":        { level: "full",       note: "Both markets: indices, sector heatmap, breadth. US-only: TradingView/macro-sentinel tiles." },
  "/dashboard/scanner":        { level: "full",       note: "US full screen; India screens the full NSE market via a nightly cache (falls back to NIFTY-100 if NSE is blocked)." },
  "/dashboard/backtest":       { level: "full",       note: "US replays on price_cache; India on Yahoo .NS candles, alpha vs NIFTY." },
  "/dashboard/strategies":     { level: "full",       note: "Both markets: fit scores (India scored from its signals' dimensions). Algo Library is US." },
  "/dashboard/calendar":       { level: "full",       note: "US full earnings feed; India = market-wide NSE results calendar (per-symbol Yahoo fallback if NSE blocked)." },
  "/dashboard/risk":           { level: "full",       note: "Both markets: per-currency book risk, benchmark-factor loss proxy, and portfolio beta (US vs SPY, India vs NIFTY when candles are available)." },
  "/dashboard/smart-money":    { level: "full",       note: "Both markets: signals + trade queue; India insider + option-chain PCR/OI live from NSE (US uses EDGAR)." },
  "/dashboard/scores":         { level: "full",       note: "US + India both scored and tracked — the symbol list now follows the header switcher (fixed 2026-07-06)." },
  "/dashboard/intelligence":   { level: "full",       note: "US + India agent signals + research runs." },
  "/dashboard/portfolio":      { level: "full",       note: "US ($) and India (₹) paper pools — switch markets in the header. Never blended." },
  "/dashboard/agents/history": { level: "full",       note: "Every agent run — now filters by the header switcher (fixed 2026-07-06); agents that don't run per-market (learner, mentor) only ever show under US." },
  "/dashboard/agents":         { level: "full",       note: "Agents run for both markets (India via free Yahoo data) — data and currency (₹) both now follow the header switcher (fixed 2026-07-06). Live Robinhood trade proposals stay $-denominated regardless of the switcher, since that account is US-only by design." },
  "/dashboard/research-journal": { level: "full",     note: "US + India both journaled — has its own in-page market picker (Funnel/Evolution tabs), separate from but consistent with the header switcher." },
  "/dashboard/watchlist":      { level: "full",       note: "US and India symbols both trackable — now filters by the header switcher (fixed 2026-07-06)." },
  "/dashboard/mentor":         { level: "full",       note: "Coaches on outcomes from both markets (not separately toggleable — reviews your judgment across everything, by design)." },
  "/dashboard/journal":        { level: "full",       note: "Audit trail spans US + India (fixed 2026-07-06 — migration 084 added the missing market column AND fixed a dormant type-mismatch bug that had silently failed every paper_fill/paper_exit journal insert). Broker orders/fills, paper fills/exits, and Kite orders are all market-tagged; risk-profile and cron-gap alerts are genuinely global (not market-specific) and show under the US view." },
  "/dashboard/settings":       { level: "full",       note: "Config applies to both markets. Turn India on/off under Market focus." },
  "/dashboard/admin":          { level: "full",       note: "Keys/vault/config for both markets." },
  "/dashboard":                { level: "full",       note: "Morning Briefing shows both US and India sections (fixed 2026-07-06) — an India Paper Portfolio card (NAV/P&L/cash/positions/signals) now appears below the US hero when India is enabled." },
};

export function getMarketSupport(pathname: string): MarketSupport {
  let best = "";
  for (const prefix of Object.keys(REGISTRY)) {
    // Exact route or a true child path only — NOT a bare startsWith, so
    // "/dashboard/markets-old" doesn't inherit the Markets entry.
    if ((pathname === prefix || pathname.startsWith(prefix + "/")) && prefix.length > best.length) {
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
