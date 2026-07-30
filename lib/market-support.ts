// Single source of truth for per-page country support. The DashboardShell footer
// reads this by longest-matching route prefix and renders a badge, so every page
// honestly advertises whether it works for US, India, both, or partially.
//
// As a panel gains India coverage (Phase 5 waves), flip its entry HERE — nowhere
// else. Keep this in sync with system-map.json / ARCHITECTURE when a level changes.
//
// ⚠️ THIS FILE IS HAND-MAINTAINED AND HAS DRIFTED FROM REALITY BEFORE. A 2026-07-16
// audit found several entries asserting a "fixed 2026-07-06" that the data
// disproved — most starkly Watchlist, which claimed to follow the switcher while
// the US view was actually returning 7 of 249 rows. Entries here are CLAIMS, not
// evidence. Before trusting or editing one, verify against the code path AND the
// live DB. If a page is missing entirely it silently inherits the "/dashboard"
// entry and badges itself with the Home note — which is how several pages
// advertised support they never had. Add every new page.

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
  "/dashboard/live-portfolio": { level: "full",       note: "Live holdings for both markets via the header switcher — Robinhood (US, $) or Zerodha Kite (India, ₹). The old separate India page now redirects here." },
  "/dashboard/india":          { level: "india-only", note: "Redirects to Live Portfolio (India view) — kept for old bookmarks." },
  // Verified 2026-07-17 against the code path + prod: the macro read ("What this
  // means for your book") is US-only BY CONSTRUCTION, not a gap to close — both
  // its inputs (macro_regime = 8 US FRED series; learning_priors category='macro'
  // = US beliefs) are US-only and neither is market-tagged. India renders an
  // explicit not-supported note; no India read is generated or substituted.
  "/dashboard/markets":        { level: "full",       note: "Both markets: indices, sector heatmap, breadth. US-only: TradingView/macro-sentinel tiles and the macro-to-book read (India has no macro regime — stated, not faked)." },
  "/dashboard/scanner":        { level: "full",       note: "US full screen; India screens the full NSE market via a nightly cache (falls back to NIFTY-100 if NSE is blocked)." },
  "/dashboard/backtest":       { level: "full",       note: "US replays on price_cache; India on Yahoo .NS candles, alpha vs NIFTY." },
  "/dashboard/strategies":     { level: "full",       note: "Both markets: fit scores (India scored from its signals' dimensions). Algo Library is market-agnostic — strategy theory (regime tags, edge rationale, failure modes), not market data; its CTAs hand off to Scanner/Backtest, which do follow the switcher." },
  "/dashboard/calendar":       { level: "full",       note: "US full earnings feed; India = market-wide NSE results calendar (per-symbol Yahoo fallback if NSE blocked)." },
  "/dashboard/risk":           { level: "full",       note: "Both markets: per-currency book risk, benchmark-factor loss proxy, and portfolio beta (US vs SPY, India vs NIFTY when candles are available)." },
  "/dashboard/smart-money":    { level: "full",       note: "Both markets: signals + trade queue; India insider + option-chain PCR/OI live from NSE (US uses EDGAR)." },
  "/dashboard/scores":         { level: "full",       note: "US + India both scored and tracked; redirects to the Research Journal's Score Tracker tab, which follows the header switcher. The 2026-07-06 claim was FALSE: the chart's own market filter defaulted to \"all\" and silently overrode the switcher, plotting 404 US + 74 India points together. That second filter was removed — the header switcher is the only authority (fixed 2026-07-16)." },
  "/dashboard/intelligence":   { level: "full",       note: "US + India agent signals + research runs." },
  "/dashboard/portfolio":      { level: "full",       note: "US ($) and India (₹) paper pools — switch markets in the header. Never blended." },
  "/dashboard/agents/history": { level: "full",       note: "Every agent run — now filters by the header switcher (fixed 2026-07-06); agents that don't run per-market (learner, mentor) only ever show under US." },
  "/dashboard/agents":         { level: "full",       note: "Agents run for both markets (India via free Yahoo data); paper data, NAV baseline, backtests and currency follow the header switcher. Brain and Experiments are market-scoped. The live Trader proposal/approval surface is US-only by design and is disabled with an explicit notice in the India view." },
  "/dashboard/research-journal": { level: "full",     note: "US + India both journaled — has its own in-page market picker (Funnel/Evolution tabs), separate from but consistent with the header switcher." },
  "/dashboard/upgrade-path":     { level: "full",     note: "US + India shadow and upgrade governance. Programs remain market-isolated; this page compares status but never combines returns or capital." },
  "/dashboard/watchlist":      { level: "full",       note: "US and India symbols both trackable, and the list follows the header switcher with the right currency ($ / ₹). The 2026-07-06 filter shipped reading capitalized markets while writes were lowercase, so the US view showed only 7 of 249 rows and India was always empty — fixed 2026-07-16 (migration 20260716202749 normalized every row to the lowercase convention and re-added the CHECK that enforces it)." },
  "/dashboard/mentor":         { level: "full",       note: "Coaches on the switched market's outcomes. The previous \"reviews everything, by design\" note was wrong: the page read the market cookie but applied it to 1 of 7 queries, so the equity curve interleaved $ and ₹ NAV and the win rate blended both books — a meaningless number in BOTH markets, not a deliberate cross-market view. Queries scoped and the thesis cache keyed by market (it was a time-only singleton serving the other market's thesis). research_packets/learning_log stay global — no market column exists (fixed 2026-07-16)." },
  "/dashboard/journal":        { level: "full",       note: "Audit trail spans US + India (fixed 2026-07-06 — migration 084 added the missing market column AND fixed a dormant type-mismatch bug that had silently failed every paper_fill/paper_exit journal insert). Broker orders/fills, paper fills/exits, and Kite orders are all market-tagged; risk-profile and cron-gap alerts are genuinely global (not market-specific) and show under the US view." },
  "/dashboard/settings":       { level: "full",       note: "Config applies to both markets. Turn India on/off under Market focus." },
  "/dashboard/admin":          { level: "full",       note: "Keys/vault/config for both markets." },
  // ── Added 2026-07-16. These had NO entry, so each silently inherited the
  // "/dashboard" fallback and badged itself with the Home note — advertising
  // support they did not have. Trading and Activity were the worst: both are
  // server components that never read the `mkt` cookie, so they were structurally
  // blind to the switcher while claiming "Home hero follows the header switcher".
  "/dashboard/trading":        { level: "full",       note: "US ($) and India (₹) paper books, per-market NAV baseline ($10k / ₹10L). Until 2026-07-16 this page pinned the pool to a literal \"us\" and left signals/history/queue unfiltered, so it always showed the US book and blended India signals into it. The Robinhood approval queue, SPY benchmark and Enable-Real-Trading are US-only by design and are hidden/relabelled under India." },
  "/dashboard/activity":       { level: "full",       note: "Agent runs, signals and paper fills for the switched market, in its own currency. Until 2026-07-16 all four queries were unfiltered and hardcoded $, so US and India events interleaved in one feed. Learning notes are genuinely global (learning_log has no market column) and are labelled \"all markets\"." },
  "/dashboard/learning":       { level: "full",       note: "Per-market weights, NAV curve and win rate. Until 2026-07-16 the market cookie reached only the weights — paper_performance/paper_trades were unfiltered, so the equity curve literally summed USD and INR NAV." },
  "/dashboard/edges":          { level: "full",       note: "Deliberately switcher-INDEPENDENT: renders US and India side-by-side with a per-row Mkt column. IC/z-scores are unitless, so no currency. This is by construction, not an omission — do not \"fix\" it to follow the switcher." },
  "/dashboard/symbol":         { level: "full",       note: "Deliberately switcher-INDEPENDENT: market is derived from the symbol suffix (.NS/.BO = India, else US), which is stricter than the switcher — a symbol belongs to exactly one market, so AAPL can never be viewed \"as India\". Currency follows that derived market." },
  "/dashboard/you":            { level: "full",       note: "Investor profile and judgment history — not market data." },
  "/dashboard/features":       { level: "full",       note: "Static changelog — not market data." },
  "/dashboard":                { level: "full",       note: "Home hero follows the header switcher — shows the US ($) or India (₹) paper pool with the right currency and per-market P&L baseline (2026-07-12). Briefing, Goal card and Recent Activity are market-scoped as of 2026-07-16 (the briefing was showing whichever market generated last, and the Goal card was pinned to US on both read AND write — India could overwrite the US goal)." },
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
