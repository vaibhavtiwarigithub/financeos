import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";
import { retrieveSimilarTrades, summarizeMemories } from "@/lib/rag/trade-memory";
import { fetchSocialSentiment, shrinkSentimentScore, SocialSentiment } from "@/lib/social-sentiment";
import { fetchOptionsSignal, OptionsSignal } from "@/lib/options-signal";
import { computeScores, type ComputedScores } from "@/lib/data/scores";
import type { Candle } from "@/lib/data/technicals";
import { isIndia, fetchIndiaOverview, fetchIndiaCandles } from "@/lib/india-data";
import { fetchIndiaNewsSentiment, type IndiaNewsSentiment } from "@/lib/india-news";
import { fetchFiiDiiFlows, fiiDiiMacroLine } from "@/lib/india-macro";
import { niftyCandidates } from "@/lib/india-universe";
import { getKiteHoldings } from "@/lib/kite";
import { computeRegimeFeatures, type RegimeFeatures } from "@/lib/validation/regime";
import { computeWeightedAnalystScore, isThinEvidence, SCORE_DIMENSIONS, type ScoreDimension, type DimensionRecord } from "@/lib/scoring/weighted-score";
import { observationsFromLegacyMask, runDegradationGuard, symbolShapeOf } from "@/lib/evidence/degradation-runtime";
import type { Market } from "@/lib/evidence/contracts";
import { resolveSignalDirection } from "@/lib/signal-direction";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { readDeferredCandidates, applyCandidateCarryForward } from "@/lib/research-queue";
import { routeToArchetypes, computeArchetypeScore } from "@/lib/scoring/archetypes";
import { evaluateFeature } from "@/lib/validation/feature-compiler";
import { avCachedFetch } from "@/lib/av-cache";
import { fetchUsCandles } from "@/lib/data/candles";
import { isEtfSymbol as canonicalIsEtfSymbol } from "@/lib/asset-classification";
import { applyStrategyTilt, loadTradingMandate } from "@/lib/trading-mandate";
import { symbolsFromLatestLiveSnapshots, symbolsFromPaperPositions, unionHoldingSymbols, orderHoldingsByStaleness, partitionWatchlistByMarket } from "@/lib/research/holding-symbols";

// Module-level cache: market → default investment_mandates.id.
// Populated once per process; safe because seed mandates never change name.
const _mandateIdCache = new Map<string, string>();
async function getDefaultMandateId(market: string, supabase: any): Promise<string | null> {
  if (_mandateIdCache.has(market)) return _mandateIdCache.get(market)!;
  const name = market === "india" ? "Swing India 2-20d" : "Swing US 2-20d";
  const { data } = await supabase
    .from("investment_mandates")
    .select("id")
    .eq("name", name)
    .eq("active", true)
    .maybeSingle();
  const id: string | null = data?.id ?? null;
  if (id) _mandateIdCache.set(market, id);
  return id;
}
import { fetchUsOverview } from "@/lib/data/fundamentals";
import { scoreMassiveInsider } from "@/lib/data/massive-insider";
import { captureFundamentalsFact } from "@/lib/data/pit-fundamentals";
import { scoreEdgarInsider } from "@/lib/data/edgar-insider";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { scoreAnalyst } from "@/lib/data/analyst";
import { fetchWebullAnalyst, webullAnalystLine, type WebullAnalyst } from "@/lib/data/webull-data";
import { fetchDaysToEarnings } from "@/lib/data/earnings";
import { getBenchmarkSeries } from "@/lib/data/benchmark-series";
import { captureReturnObservation } from "@/lib/data/return-observations";

// Phase 3 learning-core: per-run cache for benchmark regime features (SPY for
// US, ^NSEI for India) — computed once per market per process, not per symbol.
const regimeCache = new Map<string, { at: number; features: RegimeFeatures }>();
const REGIME_CACHE_TTL_MS = 30 * 60_000;

async function getRegimeFeatures(market: string, supabase: any): Promise<RegimeFeatures> {
  const cached = regimeCache.get(market);
  if (cached && Date.now() - cached.at < REGIME_CACHE_TTL_MS) return cached.features;
  try {
    // Benchmark closes now come from the shared run-level cache (lib/data/
    // benchmark-series.ts) rather than being fetched inline here. Same sources
    // (SPY from price_cache for US, ^NSEI for India), same 260-bar US window —
    // hoisted so the return-observation capture reuses this ONE series instead of
    // costing a second fetch per run.
    const bars = await getBenchmarkSeries(market, supabase);
    const closes: number[] = bars.map(b => b.close);
    const features = computeRegimeFeatures(closes);
    regimeCache.set(market, { at: Date.now(), features });
    return features;
  } catch {
    return { trend: null, realizedVol: null, volTercile: null };
  }
}

// Insider scoring: fetch from Alpha Vantage INSIDER_TRANSACTIONS. `available`
// distinguishes "genuinely balanced insider activity" (real data, neutral 50)
// from "we have no signal at all" (fetch failure / rate limit / no data) — the
// latter must NOT be scored as if it were neutral evidence; it must be
// excluded from weighting entirely (see availability_mask below).
async function scoreInsider(symbol: string, avKey: string): Promise<{ score: number; summary: string; available: boolean }> {
  try {
    const url = `https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${symbol}&apikey=${avKey}`;
    // Insider filings trickle in over days — cache 7d (this is only the fallback
    // when free EDGAR has no data, so it should rarely spend an AV call at all).
    const data = await avCachedFetch(`INSIDER:${symbol}`, url, 6000, undefined, 7);
    const transactions: any[] = data?.data ?? [];

    if (!transactions.length) return { score: 50, summary: "No insider transaction data available.", available: false };

    // Score based on recent 90 days
    const cutoff = Date.now() - 90 * 86400000;
    const recent = transactions.filter((t: any) =>
      new Date(t.transactionDate ?? t.transaction_date ?? "").getTime() > cutoff
    );

    if (!recent.length) return { score: 50, summary: "No insider transactions in past 90 days.", available: false };

    let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
    for (const t of recent) {
      const shares = Math.abs(parseFloat(t.shares ?? t.numberOfShares ?? "0"));
      const price = parseFloat(t.price ?? t.transactionPrice ?? "0");
      const value = shares * price;
      const type = (t.transactionType ?? t.transaction_type ?? "").toUpperCase();
      if (type.includes("BUY") || type === "P") { buyValue += value; buyCount++; }
      if (type.includes("SELL") || type === "S") { sellValue += value; sellCount++; }
    }

    const total = buyValue + sellValue;
    if (total === 0) return { score: 50, summary: `${recent.length} insider transactions found but no buy/sell value calculable.`, available: false };
    // A single transaction (e.g. one small buy) reads as 100% bullish with no
    // caveat despite being statistically meaningless. Require a minimum sample.
    const MIN_INSIDER_TRANSACTIONS = 3;
    if (buyCount + sellCount < MIN_INSIDER_TRANSACTIONS) {
      return { score: 50, summary: `Only ${buyCount + sellCount} insider transaction(s) in past 90 days — too few to score, treated as unavailable.`, available: false };
    }
    const buyRatio = buyValue / total;
    // 100% buying = score 90, 100% selling = score 10, balanced = 50
    const score = Math.round(10 + buyRatio * 80);
    const fmtVal = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}`;
    const summary = `${buyCount} buys (${fmtVal(buyValue)}) vs ${sellCount} sells (${fmtVal(sellValue)}) in past 90 days. Buy ratio: ${(buyRatio * 100).toFixed(0)}%.`;
    return { score, summary, available: true };
  } catch {
    return { score: 50, summary: "Insider data fetch failed.", available: false };
  }
}

// Insider resolver: Massive Form 4 (plan-entitled, full transaction detail,
// no AV cap) is primary; SEC EDGAR Form 4 (free, official) is the second source;
// Alpha Vantage INSIDER_TRANSACTIONS is the last resort. EDGAR + AV were both
// returning unavailable in practice (the reason every symbol's insider dimension
// was stuck at neutral 50), so Massive is now the working primary. Each source
// only wins when it reports available=true, so a dead source cascades to the next.
async function resolveInsider(symbol: string, avKey: string): Promise<{ score: number; summary: string; available: boolean }> {
  const massive = await scoreMassiveInsider(symbol).catch(() => null);
  if (massive?.available) return massive;
  const edgar = await scoreEdgarInsider(symbol).catch(() => null);
  if (edgar?.available) return edgar;
  return scoreInsider(symbol, avKey);
}

const LEVERAGED_BEAR_ETFS = new Set([
  "SQQQ","SOXS","SPXS","SPDN","FAZ","SIJ","DRV","GLL","SDOW","FNGD","LABD","HIBS","MSTZ","NVDD",
]);

const TRADING_ACCOUNT = process.env.TRADING_ACCOUNT_NUMBER ?? "965848641";

// US-listed foreign companies (ADRs). Foreign private issuers are EXEMPT from
// SEC Section 16 — they do NOT file Form 4s — so an insider fetch always returns
// empty and wastes the SEC EDGAR + AV fallback calls. Mark insider N/A for them.
const US_ADRS = new Set([
  "INFY","WIT","HDB","IBN","RDY","SIFY","WNS","MMYT","VEDL","AZRE",  // India
  "BABA","JD","PDD","BIDU","NIO","LI","XPEV","TCOM","BILI","TME",    // China
  "TSM","ASML","SAP","SHOP","SE","MELI","NVO","TM","SONY","UL",      // other
]);

// Which scoring/evidence dimensions a symbol CAN structurally have. Fetching a
// dimension a symbol can never possess just wastes provider calls (and every
// missing dimension is already excluded from the weighted score via the
// availability mask). Consulted by every fetch so a NEW dimension automatically
// skips the types that can't have it.
export type Dimension = "fundamental" | "technical" | "sentiment" | "macro" | "insider" | "options" | "analyst";

export function applicableDimensions(entry: SymbolEntry): Set<Dimension> {
  const india = isIndia(entry.symbol);
  const dims = new Set<Dimension>(["technical", "macro"]); // every tradable symbol has price + macro backdrop
  if (india) {
    dims.add("fundamental"); // Yahoo/Upstox fundamentals; no US-style insider/options/analyst
    // Sentiment: India equities get a real news-tone signal from GDELT (free, no
    // key). Structurally applicable to non-ETF India names; per-run availability
    // is still decided by whether GDELT returns enough toned articles (the
    // availability mask via dataQuality.sentimentDataAvailable) — never faked.
    if (!entry.isEtf) dims.add("sentiment");
    return dims;
  }
  if (entry.isEtf) {
    dims.add("sentiment"); // ETFs carry social/news sentiment but no single-company fundamentals/insider/analyst
    return dims;
  }
  // US individual equity — all dimensions, except insider for ADRs (no Form 4).
  dims.add("fundamental"); dims.add("sentiment"); dims.add("options"); dims.add("analyst");
  if (!US_ADRS.has(entry.symbol.toUpperCase())) dims.add("insider");
  return dims;
}

export type DiscoverySource =
  | "holding"         // live broker position (RH / Kite)
  | "watchlist"       // user-curated watchlist
  | "screener_momentum" // dual-bucket screener — momentum leg
  | "screener_value"    // dual-bucket screener — value leg
  | "metals_basket"   // always-on GLD/SLV/GDX/IAU basket
  | "region_etf"      // region ETF added for non-US market focus
  | "india_holding"   // live Kite India position
  | "india_screener"  // india_screen_cache candidate
  | "manual";         // manualOverride caller (e.g. ad-hoc research run)

export type SymbolEntry = {
  symbol: string;
  isHeld: boolean;
  isEtf: boolean;
  assetClass?: string; // "us_equity" | "etf" | "metal"
  screenerBucket?: "momentum" | "value"; // which dual-bucket screener flagged this (Research Journal)
  discovery_source?: DiscoverySource;    // how this symbol entered the research batch
};

export type ResearchSignalWriteContext = {
  sessionValidated: boolean;
  asOfSession: string;
  status: "pending" | "weekend_staged";
};

const BUCKET_CRITERIA: Record<"momentum" | "value", string[]> = {
  momentum: ["revenue_growth>15%", "earnings_growth>10%", "gross_margin>25%", "ROE>15%", "market_cap>$2B"],
  value: ["0<P/E<18", "FCF_yield>4%", "debt_to_equity<1.0", "market_cap>$1B"],
};

const METAL_ETF_SYMBOLS = new Set(["GLD","SLV","GDX","GDXJ","IAU","UGL","GLL"]);
const METALS_BASKET = ["GLD","SLV","GDX","IAU"];

export function isEtfSymbol(s: string): boolean {
  return canonicalIsEtfSymbol(s);
}

export function extractParsed(claudeRaw: string): any {
  const jsonMatches = claudeRaw.match(/\{[\s\S]*\}/g) ?? [];
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const c = JSON.parse(jsonMatches[i]);
      if (typeof c.fundamental_score === "number") return c;
    } catch { continue; }
  }
  const m = claudeRaw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Holdings-first: latest live snapshot per account plus the US paper alpha book.
//
// FAILS LOUD, NEVER EMPTY-ON-ERROR. This used to end in `catch { return []; }`,
// which meant a broken holdings query degraded silently into "the owner holds
// nothing" — research would then happily score NEW buy candidates while blind to
// every position it might need to SELL. That is the most dangerous possible
// degradation on this path, so a holdings-fetch failure now raises a System
// Health alert and throws: no holdings visibility => no research run at all.
export async function fetchHoldings(supabase: any): Promise<string[]> {
  try {
    const [live, paper] = await Promise.all([
      supabase.from("live_account_snapshots")
        .select("account_id, broker, positions_json, captured_at")
        .order("captured_at", { ascending: false }).limit(100),
      supabase.from("paper_positions")
        .select("symbol, qty").eq("market", "us").eq("position_role", "alpha"),
    ]);
    // PostgREST reports failure in `error`, not by throwing — an unchecked
    // `.data ?? []` here was itself a silent path to "no holdings".
    if (live.error) throw new Error(`live_account_snapshots read failed: ${live.error.message ?? live.error}`);
    if (paper.error) throw new Error(`paper_positions (us) read failed: ${paper.error.message ?? paper.error}`);
    return unionHoldingSymbols(
      symbolsFromLatestLiveSnapshots(live.data ?? []),
      symbolsFromPaperPositions(paper.data ?? [], "us"),
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await reportIssue({
      issueKey: "research-holdings-fetch:us",
      severity: "critical",
      category: "data",
      title: "US holdings fetch FAILED — research run aborted (cannot see owned positions)",
      detail: `fetchHoldings() could not read the owner's US positions: ${detail}. The run was aborted rather than proceeding, because scoring new BUY candidates while blind to existing holdings means no SELL/exit signal can be produced on a position that may need one. Fix the read, then re-run research.`,
    }, supabase).catch(() => {});
    throw new Error(`fetchHoldings (us) failed: ${detail}`);
  }
}

// Least-recently-scored-first ordering for holdings. Reads this market's own
// agent_signals (our own rows — never an external fetch) to find each holding's
// last score time, so the wall-clock budget's cut ROTATES across the book
// instead of decapitating the same stable tail every run. Fail-soft: if the
// lookup breaks we keep the caller's order rather than lose holdings entirely.
async function orderHoldingsByLastScored(supabase: any, symbols: string[], market: Market): Promise<string[]> {
  if (symbols.length === 0) return symbols;
  try {
    const { data, error } = await supabase
      .from("agent_signals")
      .select("symbol, created_at")
      .eq("market", market)
      .in("symbol", symbols)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message ?? String(error));
    const lastScoredAt = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ symbol?: string; created_at?: string }>) {
      const sym = String(row?.symbol ?? "").toUpperCase();
      // Rows arrive newest-first, so the first hit per symbol is its latest score.
      if (sym && !lastScoredAt.has(sym)) lastScoredAt.set(sym, String(row?.created_at ?? ""));
    }
    return orderHoldingsByStaleness(symbols, lastScoredAt);
  } catch (e) {
    console.error(`[research] holdings staleness ordering failed (${market}) — falling back to unordered:`, e instanceof Error ? e.message : e);
    return symbols;
  }
}

// Phase 1B — fetch account snapshot (equity, buying power, positions) and cache it
export async function fetchAndStoreAccountSnapshot(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Deterministic Robinhood read (HTTP JSON-RPC via vault token) — no local
    // Claude CLI / PowerShell. Pick the read-only trading account snapshot.
    const accounts = await captureAllRobinhoodAccounts();
    const acct = accounts.find(a => a.accountId === TRADING_ACCOUNT) ?? accounts[0];
    if (!acct) return { ok: false, error: "Robinhood MCP returned no accounts" };
    if (acct.error) return { ok: false, error: acct.error };

    const positions = acct.holdings.map(h => ({
      symbol: h.symbol,
      qty: h.qty,
      avg_price: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
      current_price: h.currentPrice ?? null,
    }));

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    let postError: string | undefined;
    await fetch(`${baseUrl}/api/live-account/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
      body: JSON.stringify({
        account_id: TRADING_ACCOUNT,
        equity: acct.totalValue,
        buying_power: acct.buyingPower ?? acct.cashBalance,
        portfolio_value: acct.totalValue,
        position_count: positions.length,
        positions_json: positions.length ? positions : null,
      }),
    }).catch((e) => { postError = String(e); });
    return postError ? { ok: false, error: postError } : { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Phase 1C — dual-bucket screener: momentum + value
// GET FinancialDatasets key from vault or env — mirrors app/api/agents/research/scan/route.ts
async function getFDKey(supabase: any): Promise<string> {
  try {
    const { data } = await supabase.from("api_key_vault").select("key_value").eq("key_name", "FINANCIAL_DATASETS_API_KEY").single();
    return (data as any)?.key_value ?? process.env.FINANCIAL_DATASETS_API_KEY ?? "";
  } catch { return process.env.FINANCIAL_DATASETS_API_KEY ?? ""; }
}

async function screenBucket(
  filters: Array<{ field: string; operator: string; value: number }>,
  fdKey: string,
  limit = 10,
  // Rank the raw screen results by a real signal instead of accepting the
  // provider's default (unspecified) order before we truncate. `field` must be
  // one already returned by the fundamentals screener (e.g. revenue_growth,
  // pe_ratio) — no extra API call. LIMITATION: this is a fundamentals-only
  // screener, so momentum here is a fundamental momentum proxy (revenue
  // acceleration), not price/RSI momentum; the per-symbol scorer downstream
  // still applies true price-based momentum via buildStockPrompt.
  sortBy?: { field: string; desc: boolean }
): Promise<string[]> {
  try {
    const res = await fetch("https://api.financialdatasets.ai/stocks/screener/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": fdKey },
      body: JSON.stringify({ filters, limit }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results: any[] = data?.results ?? data?.stocks ?? [];
    const ranked = sortBy
      ? [...results].sort((a, b) => {
          const av = Number(a?.[sortBy.field]);
          const bv = Number(b?.[sortBy.field]);
          const aOk = Number.isFinite(av);
          const bOk = Number.isFinite(bv);
          if (!aOk && !bOk) return 0;
          if (!aOk) return 1; // rows missing the signal sink to the bottom
          if (!bOk) return -1;
          return sortBy.desc ? bv - av : av - bv;
        })
      : results;
    return ranked.map((r: any) => String(r.ticker ?? r.symbol ?? "").toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

// Dual-bucket screener (CLAUDE.md-approved architecture: momentum + value,
// always both running, no regime-switching logic). Was previously asking
// execClaude — a plain text-completion subprocess with no MCP server
// attached — to "call" the screen_stocks tool, which it structurally
// cannot do; every run silently returned []. Calls FinancialDatasets'
// REST screener directly instead, same pattern already proven working in
// app/api/agents/research/scan/route.ts.
export async function runScreener(supabase: any): Promise<{ symbol: string; bucket: "momentum" | "value" }[]> {
  const fdKey = await getFDKey(supabase);
  if (!fdKey) return [];

  const [momentum, value] = await Promise.all([
    // Momentum bucket ranked by revenue_growth desc — an explicit momentum
    // signal (revenue acceleration, per doctrine §8) from data already fetched
    // by this screen, replacing the provider's default order so the strongest
    // accelerators survive the downstream candidate cap instead of whichever
    // names the API happened to list first.
    screenBucket([
      { field: "revenue_growth", operator: "gt", value: 0.15 },
      { field: "earnings_growth", operator: "gt", value: 0.10 },
      { field: "gross_margin", operator: "gt", value: 0.25 },
      { field: "return_on_equity", operator: "gt", value: 0.15 },
      { field: "market_cap", operator: "gt", value: 2_000_000_000 },
    ], fdKey, 10, { field: "revenue_growth", desc: true }),
    // Value bucket ranked by pe_ratio asc (cheapest first) — mirrors the India
    // path (fetchIndiaScreenCandidates sorts value by ascending P/E).
    screenBucket([
      { field: "pe_ratio", operator: "gt", value: 0 },
      { field: "pe_ratio", operator: "lt", value: 18 },
      { field: "free_cash_flow_yield", operator: "gt", value: 0.04 },
      { field: "debt_to_equity", operator: "lt", value: 1.0 },
      { field: "market_cap", operator: "gt", value: 1_000_000_000 },
    ], fdKey, 10, { field: "pe_ratio", desc: false }),
  ]);

  // Interleave momentum/value round-robin before capping at 6 — a flat
  // momentum-then-value order with slice(6) let momentum silently crowd out
  // every value candidate whenever momentum alone returned 6+ hits (which it
  // plausibly does most days), violating the locked "let ResearchAgent score
  // both buckets" design rule (screening bias, not scoring bias).
  const seen = new Map<string, "momentum" | "value">();
  const validMomentum = momentum.filter(s => s.length > 0 && s.length <= 6);
  const validValue = value.filter(s => s.length > 0 && s.length <= 6);
  const maxLen = Math.max(validMomentum.length, validValue.length);
  for (let i = 0; i < maxLen; i++) {
    if (validMomentum[i] && !seen.has(validMomentum[i])) seen.set(validMomentum[i], "momentum");
    if (validValue[i] && !seen.has(validValue[i])) seen.set(validValue[i], "value");
  }

  return Array.from(seen.entries()).slice(0, 6).map(([symbol, bucket]) => ({ symbol, bucket }));
}

// Region ETF baskets — appended when user's market_focus includes that region
const REGION_ETFS: Record<string, string[]> = {
  India:  ["INDA", "EPI", "INDY", "INFY", "WIT", "HDB"],
  Europe: ["VGK", "EWG", "EWL", "EWU", "EWQ"],
  Asia:   ["EWJ", "EWT", "EWY", "EWH", "FXI"],
  Crypto: ["IBIT", "BITO", "GBTC"],
  Global: ["VT", "ACWI", "EFA"],
};

// Gather full symbol batch: holdings + watchlist + screener candidates + region ETFs from profile
export async function gatherSymbols(
  supabase: any,
  manualOverride?: string[]
): Promise<SymbolEntry[]> {
  if (manualOverride && manualOverride.length > 0) {
    return manualOverride.map(s => {
      const sym = s.toUpperCase();
      return {
        symbol: sym,
        isHeld: false,
        isEtf: isEtfSymbol(sym),
        assetClass: isIndia(sym) ? "india" : (isEtfSymbol(sym) ? "etf" : "us_equity"),
        discovery_source: "manual" as DiscoverySource,
      };
    });
  }

  // fetchAndStoreAccountSnapshot() used to fire here automatically, but it
  // shells out to a local Claude Code CLI + Robinhood MCP (lib/claude-exec.ts)
  // -- that only exists on a Windows machine with Claude Code installed, so
  // every invocation from Vercel/cloud cron threw immediately and did
  // nothing (silently, since it was fire-and-forget). Decoupled into its own
  // endpoint (/api/live-account/refresh-snapshot) so the user can choose
  // where this runs from (a local Windows Task Scheduler entry hitting
  // localhost) independent of where research itself runs (cloud).
  //
  // expires_at filter mirrors app/api/watchlist/route.ts's GET — without this,
  // an expired Theme Scout pick kept getting re-researched
  // forever instead of retiring, since only the Watchlist UI page enforced it.
  const nowIso = new Date().toISOString();
  const [holdings, watchlistResult, screenerSymbols, profileResult] = await Promise.all([
    fetchHoldings(supabase),
    supabase.from("watchlist").select("symbol, source, market, created_at")
      .eq("research_enabled", true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    runScreener(supabase),
    supabase.from("profiles").select("market_focus").limit(1).single(),
  ]);

  // Split watchlist by source: an OWNER MANUAL add is an explicit "research this"
  // intent and must beat the machine-generated screener carry-forward backlog —
  // otherwise a hand-picked ticker starves behind dozens of queued screener names.
  // Newest manual adds first (most recent intent).
  const watchlist = partitionWatchlistByMarket((watchlistResult.data ?? []) as any[]);

  const rawFocus: string = (profileResult.data as any)?.market_focus ?? "US";
  const focusRegions = rawFocus.split(",").map((s: string) => s.trim()).filter(Boolean);

  // Holdings scored unconditionally — already owned, SELL/monitor signals possible.
  // They do NOT consume the new-buy candidate cap: a 10-ETF portfolio must not
  // evict all individual stock candidates from the research universe.
  // Least-recently-scored FIRST. Holdings are cap-exempt but not budget-exempt:
  // when the book is larger than one run's throughput the wall-clock budget cuts
  // the tail, and with a stable order that tail was the SAME symbols every day
  // (prod run a4530e8f: slots 31-56, all holdings, 0 signals — AVGO unscored
  // since 07-13). Staleness ordering makes that cut rotate.
  const holdingEntries: SymbolEntry[] = [];
  const holdingSet = new Set<string>();
  for (const sym of await orderHoldingsByLastScored(supabase, holdings, "us")) {
    const isMetal = METAL_ETF_SYMBOLS.has(sym);
    holdingEntries.push({ symbol: sym, isHeld: true, isEtf: isEtfSymbol(sym), assetClass: isMetal ? "metal" : isEtfSymbol(sym) ? "etf" : "us_equity", discovery_source: "holding" });
    holdingSet.add(sym);
  }

  // Candidates (new-buy budget), in PRIORITY order:
  //   carried-forward (waited a prior run) → watchlist (Theme Scout picks) → screener.
  // Cap applies only to this bucket, not to holdings above.
  const candidateMap = new Map<string, SymbolEntry>();
  const addCandidate = (sym: string, source: DiscoverySource) => {
    if (holdingSet.has(sym) || candidateMap.has(sym)) return;
    const isMetal = METAL_ETF_SYMBOLS.has(sym);
    candidateMap.set(sym, { symbol: sym, isHeld: false, isEtf: isEtfSymbol(sym), assetClass: isMetal ? "metal" : isEtfSymbol(sym) ? "etf" : "us_equity", discovery_source: source });
  };

  // PRIORITY 1 — owner MANUAL watchlist adds. Explicit "research this now" intent
  // beats everything except holdings, so a hand-picked ticker (e.g. SK Hynix)
  // never starves behind the screener carry-forward backlog.
  for (const sym of watchlist.usManual) addCandidate(sym, "watchlist");

  // PRIORITY 2 — carry-forward (migration 172): candidates that missed a prior
  // run's cap come back with raised priority so the pool rotates fairly.
  const deferredUs = await readDeferredCandidates(supabase, "us");
  for (const sym of deferredUs) addCandidate(sym, "watchlist");

  // PRIORITY 3 — the rest of the watchlist (Theme Scout / non-manual).
  for (const sym of watchlist.usOther) addCandidate(sym, "watchlist");

  const screenerMax = parseInt(process.env.RESEARCH_SCREENER_MAX ?? "6");
  let screenerAdded = 0;
  for (const { symbol: sym, bucket } of screenerSymbols) {
    if (holdingSet.has(sym) || candidateMap.has(sym) || screenerAdded >= screenerMax) continue;
    candidateMap.set(sym, { symbol: sym, isHeld: false, isEtf: false, assetClass: "us_equity", screenerBucket: bucket, discovery_source: bucket === "momentum" ? "screener_momentum" : "screener_value" });
    screenerAdded++;
  }

  // Cap selected candidates per run. Safe to keep high (40) now that the cron
  // research loop is WALL-CLOCK BOUNDED (app/api/agents/research/cron: RESEARCH_
  // BUDGET_MS) + re-defers whatever it can't reach — so a big cap raises warm-run
  // throughput without ever overrunning maxDuration (the 50-cap timeout that
  // watchdog-reaped runs for 2 days). Overflow beyond the cap already carries
  // forward via applyCandidateCarryForward.
  const candidateCap = parseInt(process.env.RESEARCH_CANDIDATE_CAP ?? "40");
  // Take the top `candidateCap` this run; carry the overflow forward (raised
  // priority, no starvation) instead of the old silent `.slice()` drop.
  const usBatch = new Set(await applyCandidateCarryForward(supabase, "us", Array.from(candidateMap.keys()), candidateCap));
  // Backlog visibility: carry-forward prevents silent drops, but if the queue
  // grows far past daily throughput the pool takes many days to rotate (effective
  // starvation). Surface it so throughput/cap can be tuned instead of a surprise.
  try {
    const { count: qDepth } = await supabase.from("research_queue").select("symbol", { count: "exact", head: true }).eq("market", "us");
    const backlogDays = Math.ceil((qDepth ?? 0) / Math.max(1, candidateCap));
    if ((qDepth ?? 0) > candidateCap * 4) {
      await reportIssue({
        issueKey: "research-backlog:us",
        severity: (qDepth ?? 0) > candidateCap * 10 ? "critical" : "warn",
        category: "data",
        title: `US research backlog: ${qDepth} queued (~${backlogDays}d to clear at ${candidateCap}/day)`,
        detail: `The US research carry-forward queue holds ${qDepth} symbols but only ${candidateCap} are researched per run, so a newly-added ticker waits ~${backlogDays} days for its turn. Raise RESEARCH_CANDIDATE_CAP, prune stale screener names, or split runs. Manual watchlist adds are prioritized ahead of this backlog, but screener candidates still rotate slowly.`,
        autoExpireAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
      }, supabase).catch(() => {});
    } else {
      await resolveIssue("research-backlog:us", supabase).catch(() => {});
    }
  } catch { /* backlog telemetry must never break a research run */ }
  const nonMetals = [...holdingEntries, ...Array.from(candidateMap.values()).filter(e => usBatch.has(e.symbol))];

  // Metals basket — always appended after candidate cap (4 extra symbols, cheap ETF analysis)
  const metals: SymbolEntry[] = [];
  const allNonMetalSyms = new Set(nonMetals.map(e => e.symbol));
  for (const sym of METALS_BASKET) {
    if (!allNonMetalSyms.has(sym)) {
      metals.push({ symbol: sym, isHeld: false, isEtf: true, assetClass: "metal", discovery_source: "metals_basket" });
    }
  }

  // Region ETFs — appended for each non-US focus in profile.market_focus (max 3 per region)
  const regionEtfs: SymbolEntry[] = [];
  const seenAll = new Set([...allNonMetalSyms, ...metals.map(m => m.symbol)]);
  for (const region of focusRegions) {
    if (region === "US") continue;
    const basket = REGION_ETFS[region] ?? [];
    let added = 0;
    for (const sym of basket) {
      if (seenAll.has(sym) || added >= 3) continue;
      seenAll.add(sym);
      regionEtfs.push({ symbol: sym, isHeld: false, isEtf: true, assetClass: "etf", discovery_source: "region_etf" });
      added++;
    }
  }

  // India: when the user's focus includes India, add direct NSE stocks scored
  // via Yahoo — real Indian equities, not just US-listed India ETFs. asset_class
  // "india" so PaperTrader skips them (INR-priced; India acts via Kite).
  const indiaSymbols: SymbolEntry[] = [];
  // Holdings are an obligation, not a discovery preference. Include them even
  // when the profile later changes; only new India candidates follow focus.
  // Staleness-ordered for the same reason as US (parity): the India book must
  // rotate under the budget rather than starve a fixed tail.
  const indiaHeld = await orderHoldingsByLastScored(supabase, await fetchIndiaHoldings(supabase), "india");
  for (const sym of indiaHeld) {
    if (seenAll.has(sym)) continue;
    seenAll.add(sym);
    indiaSymbols.push({ symbol: sym, isHeld: true, isEtf: false, assetClass: "india", discovery_source: "india_holding" });
  }
  if (focusRegions.includes("India")) {
    // Holdings-first (parity with US): real Kite holdings enter the batch as
    // isHeld:true so SELL/exit signals are possible on owned India positions —
    // long-only enforcement applies only to NEW positions, not exits.
    // Candidates from the nightly full-market india_screen_cache (dual-bucket:
    // momentum + value), not the static first-8 NIFTY names. Falls back to the
    // static list only when the cache is empty. Carry-forward first (migration
    // 172), then fresh screener names; overflow beyond the cap rotates next run.
    const indiaCap = parseInt(process.env.RESEARCH_INDIA_CANDIDATE_CAP ?? "8");
    const deferredIndia = await readDeferredCandidates(supabase, "india");
    const cacheCandidates = await fetchIndiaScreenCandidates(supabase, Math.max(20, indiaCap * 2));
    const rawList = cacheCandidates.length > 0 ? cacheCandidates : niftyCandidates(indiaCap);
    const orderedIndia: string[] = [];
    const seenInd = new Set<string>();
    for (const sym of [...watchlist.indiaManual, ...deferredIndia, ...watchlist.indiaOther, ...rawList]) {
      const u = String(sym).toUpperCase();
      if (seenAll.has(u) || seenInd.has(u)) continue;
      seenInd.add(u);
      orderedIndia.push(u);
    }
    const indiaBatch = await applyCandidateCarryForward(supabase, "india", orderedIndia, indiaCap);
    for (const sym of indiaBatch) {
      if (seenAll.has(sym)) continue;
      seenAll.add(sym);
      indiaSymbols.push({ symbol: sym, isHeld: false, isEtf: false, assetClass: "india", discovery_source: "india_screener" });
    }
  }

  return [...nonMetals, ...metals, ...regionEtfs, ...indiaSymbols];
}

// Real India holdings from Kite (/portfolio/holdings), mapped to the .NS
// symbols the Yahoo-based India scorer expects. Empty on any error (no Kite
// token today, market closed, etc.) — never throws into gatherSymbols.
async function fetchIndiaHoldings(svc: any): Promise<string[]> {
  const [kiteResult, paperResult] = await Promise.allSettled([
    getKiteHoldings(svc),
    svc.from("paper_positions").select("symbol, qty").eq("market", "india").eq("position_role", "alpha"),
  ]);
  // PARITY with the US path: a rejected Kite call used to collapse to [] in
  // silence, so "Kite token expired" and "the owner genuinely holds nothing"
  // were indistinguishable — India could go blind to its own positions with no
  // alert. Kite is a live broker call (token lapse / NSE closed are expected and
  // recoverable), so unlike the US DB read this warns and continues on the paper
  // book rather than aborting the whole India run; the paper read failing is a
  // DB fault and aborts, exactly like US.
  if (kiteResult.status === "rejected") {
    const detail = kiteResult.reason instanceof Error ? kiteResult.reason.message : String(kiteResult.reason);
    await reportIssue({
      issueKey: "research-holdings-fetch:india-kite",
      severity: "warn",
      category: "data",
      title: "India Kite holdings fetch failed — live India positions not re-scored this run",
      detail: `getKiteHoldings() failed: ${detail}. Live Kite positions are NOT in this run's research batch, so no SELL/exit signal can be produced on them until the read recovers. India paper positions are unaffected. Usual cause: expired Kite token — re-auth in Settings.`,
      autoExpireAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
    }, svc).catch(() => {});
  } else {
    await resolveIssue("research-holdings-fetch:india-kite", svc).catch(() => {});
  }
  if (paperResult.status === "rejected") {
    const detail = paperResult.reason instanceof Error ? paperResult.reason.message : String(paperResult.reason);
    await reportIssue({
      issueKey: "research-holdings-fetch:india",
      severity: "critical",
      category: "data",
      title: "India holdings fetch FAILED — research run aborted (cannot see owned positions)",
      detail: `paper_positions (india) read failed: ${detail}. The run was aborted rather than scoring new India candidates while blind to existing India positions.`,
    }, svc).catch(() => {});
    throw new Error(`fetchIndiaHoldings (india) failed: ${detail}`);
  }
  if ((paperResult.value as any)?.error) {
    const err = (paperResult.value as any).error;
    throw new Error(`fetchIndiaHoldings (india) paper_positions read failed: ${err.message ?? err}`);
  }
  const kiteRows: any[] = kiteResult.status === "fulfilled"
    ? (kiteResult.value?.data ?? kiteResult.value ?? [])
    : [];
  const kiteSymbols = Array.isArray(kiteRows)
    ? kiteRows
      .map(r => String(r?.tradingsymbol ?? "").toUpperCase().trim())
      .filter(Boolean)
      .filter(s => Number(kiteRows.find(x => String(x?.tradingsymbol).toUpperCase().trim() === s)?.quantity ?? 0) > 0)
      .map(s => (s.endsWith(".NS") || s.endsWith(".BO") ? s : `${s}.NS`))
    : [];
  const paperRows = paperResult.status === "fulfilled" ? (paperResult.value.data ?? []) : [];
  return unionHoldingSymbols(kiteSymbols, symbolsFromPaperPositions(paperRows, "india"));
}

// Freshness window for the nightly india_screen_cache. The cache is refreshed
// by a nightly cron; rows scored longer ago than this are stale (e.g. a missed
// or failed refresh) and must NOT be picked as if freshly discovered. 36h gives
// one full extra day of slack over the ~24h refresh cadence so a single skipped
// run doesn't blank India discovery, while still excluding genuinely old rows.
const INDIA_FRESHNESS_HOURS = 36;

// Dual-bucket candidate pull from the nightly india_screen_cache. Momentum:
// RSI>60 and above the 50-day MA. Value: low P/E with positive ROE. Interleaved
// so neither bucket crowds the other — mirrors the US screener's approach.
async function fetchIndiaScreenCandidates(svc: any, limit: number): Promise<string[]> {
  try {
    // Only consider rows scored within the freshness window — stale cache rows
    // (from a missed nightly refresh) would otherwise be surfaced as current
    // discoveries. scored_at is the cache's discovery/scoring timestamp.
    const freshCutoff = new Date(Date.now() - INDIA_FRESHNESS_HOURS * 3600_000).toISOString();
    const { data } = await svc
      .from("india_screen_cache")
      .select("symbol, pe, rsi, above_ma50, roe")
      .not("symbol", "is", null)
      .gte("scored_at", freshCutoff)
      .limit(1500);
    const rows: any[] = data ?? [];
    if (!rows.length) return [];
    const momentum = rows
      .filter(r => Number(r.rsi) > 60 && r.above_ma50 === true)
      .sort((a, b) => Number(b.rsi) - Number(a.rsi));
    const value = rows
      .filter(r => Number(r.pe) > 0 && Number(r.pe) < 35 && Number(r.roe) > 0)
      .sort((a, b) => Number(a.pe) - Number(b.pe));
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; out.length < limit && (i < momentum.length || i < value.length); i++) {
      for (const src of [momentum[i], value[i]]) {
        const raw = src?.symbol ? String(src.symbol).toUpperCase().trim() : "";
        if (!raw || seen.has(raw)) continue;
        const sym = raw.endsWith(".NS") || raw.endsWith(".BO") ? raw : `${raw}.NS`;
        if (seen.has(sym)) continue;
        seen.add(raw); seen.add(sym);
        out.push(sym);
        if (out.length >= limit) break;
      }
    }
    return out;
  } catch { return []; }
}

const DOCTRINE_PREAMBLE = `## Reasoning doctrine (non-negotiable)

§1 — You are a REASONER, not a data source. You do not know prices, P&L, fills, balances, fundamentals, or RSI values. Every number that drives a decision MUST trace to a tool call made in THIS run. If you find yourself recalling a number, stop — that is hallucination. Plausible-sounding analysis that moves money on unverified figures is the most dangerous output you can produce.

§3 — Humility prior: active trading underperforms low-cost index funds for most participants (Barber & Odean). The DEFAULT answer is "neutral" (no trade). A position must clear a HIGH bar. Conviction is not evidence. A thesis you "really like" is a warning sign.

§8 — ABSTAIN if ANY of these cannot be filled from sourced tool data:
  • Thesis: one falsifiable claim + source + timestamp
  • Bucket: momentum (RSI>60, price>50MA, revenue acceleration) OR value (P/E<sector median, high FCF, insider buying)
  • Direction with specific evidence from fetched data
  • Key risks: sourced, not invented
  If data is missing or stale → output direction:"neutral", conviction:0, and explain why in summary.

Scope: long-only US equities/ETFs, 2–20 market-day swing. Never propose options, crypto, shorting, leverage, or intraday.`;

function buildStockPrompt(symbol: string, isHeld: boolean, social: SocialSentiment | null, options: OptionsSignal | null, insider: { score: number; summary: string } | null = null): string {
  const heldNote = isHeld
    ? `\nIMPORTANT: This is a CURRENTLY HELD position. If analysis is bearish, set direction to "short" as an exit signal. Do NOT override to neutral.`
    : `\nNew candidate position. Only output direction "long" or "neutral" — never "short".`;

  const socialBlock = social
    ? `
## Pre-fetched social sentiment (already gathered — do NOT call NEWS_SENTIMENT again for this data)
- StockTwits: ${social.overall_sentiment} · ${social.stocktwits_bullish_pct ?? "n/a"}% bullish, ${social.stocktwits_bearish_pct ?? "n/a"}% bearish (${social.stocktwits_message_count ?? 0} messages)
- Alpha Vantage news sentiment score: ${social.av_news_sentiment !== null ? social.av_news_sentiment.toFixed(3) : "n/a"} (${social.av_news_articles ?? 0} articles, scale -1 to +1)
- Combined signal: ${social.overall_sentiment}
Use this to inform sentiment_score (scale 0–100: Bullish≈70+, Neutral≈50, Bearish≈30-).
`
    : "";

  const optionsBlock = options
    ? `
## Pre-fetched options flow (nearest expiry: ${options.nearestExpiry})
${options.summary}
Interpretation guide:
- PCR < 0.7 = bullish (market buying calls). PCR > 1.2 = bearish (hedging with puts).
- Unusual call volume (vol >> open interest) on OTM strikes = institutional bullish bet.
- Unusual put volume on OTM strikes = hedging or directional bear bet.
- High IV (>70th pct) = market pricing in a big move — be cautious entering before catalyst.
Factor options flow into sentiment_score and conviction. Unusual call activity boosts conviction for longs; unusual put sweeps reduce it.
`
    : "";

  const insiderBlock = insider
    ? `
## Pre-fetched insider transactions (past 90 days — do NOT call INSIDER_TRANSACTIONS again)
- Pre-computed insider_score: ${insider.score}/100
- Summary: ${insider.summary}
Use this score directly as insider_score in your output. Do not override it unless you have strong contradictory evidence from another sourced tool call.
`
    : "";

  return `${DOCTRINE_PREAMBLE}
${socialBlock}${optionsBlock}${insiderBlock}
You are a professional equity analyst. Research ${symbol} using these tools in order:

1. Call get_financial_metrics_snapshot (FinancialDatasets) for fundamentals: P/E, revenue growth, margins, FCF yield, ROE
2. Call RSI (Alpha Vantage) with symbol=${symbol}, interval=daily — check if RSI > 60 (momentum) or < 40 (oversold)
3. Call EMA (Alpha Vantage) with symbol=${symbol}, interval=daily, time_period=50 — compare to current price for trend direction
4. Call NEWS_SENTIMENT (Alpha Vantage) with tickers=${symbol} — get top 3 headlines (sentiment score already provided above)
5. ${insider ? `SKIP INSIDER_TRANSACTIONS — already pre-fetched above (insider_score: ${insider.score})` : `Call INSIDER_TRANSACTIONS (Alpha Vantage) with symbol=${symbol} — note recent insider buying or selling`}
6. Call get_earnings (FinancialDatasets) — last 2 quarters: beat or miss vs estimates?

After gathering data, synthesize all signals. Output ONLY a JSON object (no markdown, no prose):

{"symbol":"${symbol}","fundamental_score":75,"technical_score":70,"sentiment_score":72,"macro_score":65,"insider_score":60,"direction":"long","conviction":70,"summary":"2-3 sentence thesis citing actual numbers","key_risks":["specific risk 1","specific risk 2"],"catalysts":["specific catalyst 1","specific catalyst 2"]}

Scoring guide:
- fundamental_score: based on P/E vs sector, revenue growth, margins, FCF yield
- technical_score: based on RSI + price vs 50-day EMA
- sentiment_score: blend of pre-fetched social sentiment + NEWS_SENTIMENT headlines (scale 0–100)
- macro_score: sector tailwinds, interest rate sensitivity, geopolitical exposure
- insider_score: 80+ if net buying, 20- if heavy selling, 50 if neutral
- conviction: your overall confidence 0-100
- direction must cite which signals drove it${heldNote}`;
}

function buildEtfPrompt(symbol: string, isHeld: boolean, social: SocialSentiment | null): string {
  const sym = symbol.toUpperCase();
  const isBear = LEVERAGED_BEAR_ETFS.has(sym);

  const directionNote = isBear
    ? `This is an INVERSE/BEAR ETF. direction="long" means underlying is BEARISH (bear ETF profits). direction="short" means underlying is BULLISH (bear ETF loses — exit signal if held).`
    : `direction="long" means underlying sector/index is bullish (hold/buy). direction="short" means bearish on underlying.`;

  const heldNote = isHeld
    ? `This is a CURRENTLY HELD position. If conclusion is bearish for this ETF (accounting for bear/bull direction above), set direction="short" as an exit signal.`
    : `Not currently held. Use direction "long" or "neutral" only.`;

  const socialBlock = social
    ? `
## Pre-fetched social sentiment
- StockTwits: ${social.overall_sentiment} · ${social.stocktwits_bullish_pct ?? "n/a"}% bullish (${social.stocktwits_message_count ?? 0} messages)
- News sentiment score: ${social.av_news_sentiment !== null ? social.av_news_sentiment.toFixed(3) : "n/a"} (${social.av_news_articles ?? 0} articles)
- Combined: ${social.overall_sentiment}
Use to inform sentiment_score (Bullish≈70+, Neutral≈50, Bearish≈30-).
`
    : "";

  return `${DOCTRINE_PREAMBLE}
${socialBlock}
Analyze the ETF/fund ${symbol}.

First identify what it tracks:
SOXL/SOXS=3x semiconductors, TQQQ/SQQQ=3x Nasdaq, SPXL/SPXS=3x S&P500, SMH=VanEck semis, BOTZ=robotics/AI, ICLN=clean energy, NLR=nuclear/uranium, XLK/XLF/XLE/XLI/XLV/XLU/XLRE/XLB/XLC/XLP/XLY=SPDR sectors, GLD=gold, USO=oil, TLT=20yr treasuries

Use these tools:
1. NEWS_SENTIMENT (Alpha Vantage) — search for relevant sector/theme keywords
2. RSI (Alpha Vantage) with symbol=${symbol} — technical momentum of the ETF itself
3. EMA (Alpha Vantage) with symbol=${symbol}, interval=daily, time_period=50 — above or below 50-day MA?

Assess: sector fundamentals, policy/regulatory environment, macro context, relevant earnings from top holdings.

${directionNote}

Output ONLY this JSON (no markdown):
{"symbol":"${symbol}","fundamental_score":50,"technical_score":65,"sentiment_score":60,"macro_score":55,"insider_score":50,"direction":"long","conviction":60,"summary":"2-3 sentence sector/ETF analysis with specific reasoning","key_risks":["risk1","risk2"],"catalysts":["catalyst1","catalyst2"]}

${heldNote}`;
}

// Fetch company overview from Alpha Vantage (fundamentals for scoring)
async function fetchAVOverview(symbol: string, avKey: string): Promise<Record<string, string>> {
  if (!avKey) return {};
  try {
    // Fundamentals change quarterly, not daily — cache 14d so the same symbol's
    // OVERVIEW isn't re-fetched every research run (the biggest AV-budget drain).
    const json = await avCachedFetch(
      `OVERVIEW:${symbol}`,
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${avKey}`,
      6000, undefined, 14
    );
    return json?.Symbol ? (json as Record<string, string>) : {};
  } catch { return {}; }
}

// Fetch daily OHLCV candles from Alpha Vantage TIME_SERIES_DAILY_ADJUSTED (100 days compact)
// Used for deterministic RSI(14) / EMA(20,50) computation — no LLM involved
async function fetchAVCandles(symbol: string, avKey: string): Promise<Candle[]> {
  if (!avKey) return [];
  try {
    // Day-cached + budget-guarded: daily candles settle once per session.
    const json = await avCachedFetch(
      `DAILY_ADJ:${symbol}`,
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=compact&apikey=${avKey}`
    );
    const series = json?.["Time Series (Daily)"];
    if (!series || typeof series !== "object") return [];
    return Object.entries(series as Record<string, Record<string, string>>)
      .sort(([a], [b]) => a.localeCompare(b)) // oldest first → required for EMA computation
      .map(([date, d]) => ({
        date,
        open:   parseFloat(d["1. open"]          ?? "0"),
        high:   parseFloat(d["2. high"]          ?? "0"),
        low:    parseFloat(d["3. low"]           ?? "0"),
        close:  parseFloat(d["5. adjusted close"] ?? d["4. close"] ?? "0"),
        volume: parseFloat(d["6. volume"]        ?? d["5. volume"] ?? "0"),
      }));
  } catch { return []; }
}

// Deprecated — kept for buildSynthesisPrompt compatibility (not called by processSymbol)
async function fetchAVSymbolData(symbol: string, avKey: string): Promise<{
  rsi: number | null;
  overview: Record<string, string>;
}> {
  const [rsiJson, overviewJson] = await Promise.all([
    fetch(`https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${avKey}`)
      .then(r => r.json()).catch(() => ({})),
    fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${avKey}`)
      .then(r => r.json()).catch(() => ({})),
  ]);
  const rsiSeries = rsiJson?.["Technical Analysis: RSI"];
  const rsiLatestVal = rsiSeries ? (Object.values(rsiSeries)[0] as any)?.RSI : null;
  const rsi = rsiLatestVal != null ? parseFloat(rsiLatestVal) : null;
  const overview: Record<string, string> = overviewJson?.Symbol ? (overviewJson as Record<string, string>) : {};
  return { rsi: rsi != null && !isNaN(rsi) ? rsi : null, overview };
}

function buildSynthesisPrompt(
  symbol: string,
  isHeld: boolean,
  isEtf: boolean,
  rsi: number | null,
  overview: Record<string, string>,
  social: SocialSentiment | null,
  options: OptionsSignal | null,
  insider: { score: number; summary: string } | null,
): string {
  const heldNote = isHeld
    ? `IMPORTANT: currently held position. If bearish, set direction "short" as exit signal.`
    : `New candidate. direction must be "long" or "neutral" only — never "short".`;

  const techBlock = rsi != null
    ? `RSI-14 (daily): ${rsi.toFixed(1)} — ${rsi > 60 ? "OVERBOUGHT/momentum" : rsi < 40 ? "OVERSOLD/potential reversal" : "neutral range"}`
    : `RSI-14: not available`;

  const fundBlock = isEtf ? "" : overview?.Symbol ? `
Fundamentals (Alpha Vantage Overview):
- P/E: ${overview.PERatio ?? "n/a"} | EPS: ${overview.EPS ?? "n/a"}
- Market cap: ${overview.MarketCapitalization ?? "n/a"}
- Revenue growth YoY: ${overview.QuarterlyRevenueGrowthYOY ?? "n/a"}
- Profit margin: ${overview.ProfitMargin ?? "n/a"} | ROE: ${overview.ReturnOnEquityTTM ?? "n/a"}
- 52w range: ${overview["52WeekLow"] ?? "n/a"} – ${overview["52WeekHigh"] ?? "n/a"}
- Sector: ${overview.Sector ?? "n/a"} | Industry: ${overview.Industry ?? "n/a"}
- Analyst target: ${overview.AnalystTargetPrice ?? "n/a"} | Rating: ${overview.AnalystRatingStrongBuy ?? "?"} strong buy, ${overview.AnalystRatingBuy ?? "?"} buy, ${overview.AnalystRatingHold ?? "?"} hold` : "Fundamentals: not available (rate limit)";

  const socialBlock = social
    ? `Social: ${social.overall_sentiment} — StockTwits ${social.stocktwits_bullish_pct ?? "n/a"}% bullish/${social.stocktwits_bearish_pct ?? "n/a"}% bearish (${social.stocktwits_message_count ?? 0} msgs). AV news sentiment: ${social.av_news_sentiment?.toFixed(3) ?? "n/a"} (${social.av_news_articles ?? 0} articles).`
    : "Social sentiment: not available";

  const optionsBlock = options
    ? `Options flow (nearest expiry ${options.nearestExpiry}): ${options.summary}`
    : "";

  const insiderBlock = insider
    ? `Insider (90 days): score ${insider.score}/100. ${insider.summary}`
    : "";

  return `${DOCTRINE_PREAMBLE}

You are a professional equity analyst synthesizing pre-fetched data for ${symbol}. You CANNOT call any tools — all data is provided below. Derive scores ONLY from the provided data; if a score cannot be grounded, default to 50.

## Pre-fetched data for ${symbol}
Technical:
${techBlock}
${fundBlock}
${socialBlock}
${optionsBlock}
${insiderBlock}

## Scoring rubric
- fundamental_score (0-100): based on P/E vs typical sector, revenue growth, margins, ROE. Default 50 if data missing.
- technical_score (0-100): RSI>60 → 70+, RSI<40 → 30-, RSI 40-60 → 45-55.
- sentiment_score (0-100): Bullish social/news → 70+, Bearish → 30-, Neutral → 50.
- macro_score (0-100): sector tailwinds/headwinds; use Sector field and general macro knowledge.
- insider_score: use provided insider score directly (${insider?.score ?? 50}).
- conviction: your overall confidence 0-100.
- direction: "long" if analystScore likely ≥ 60 and bullish signals dominate, "neutral" otherwise. ${heldNote}

Return ONLY valid JSON (no markdown, no prose):
{"symbol":"${symbol}","fundamental_score":50,"technical_score":50,"sentiment_score":50,"macro_score":50,"insider_score":${insider?.score ?? 50},"direction":"neutral","conviction":50,"summary":"2-3 sentence thesis citing actual provided numbers","key_risks":["risk1","risk2"],"catalysts":["catalyst1","catalyst2"]}`;
}

// Phase 0: thesis-only LLM prompt. LLM receives pre-computed scores, outputs direction+narrative only.
// No scores are generated by the LLM — all quantitative data is deterministic.
function buildThesisOnlyPrompt(
  symbol: string,
  isHeld: boolean,
  scores: ComputedScores,
  analystScore: number,
  scoreThreshold: number,
  marketFocus?: string,
  indiaNews?: IndiaNewsSentiment | null,
  indiaMacroLine?: string | null,
  webullLine?: string | null,
): string {
  const { fundamental_score, technical_score, sentiment_score, macro_score, insider_score, evidence } = scores;
  const tech = evidence.technical as Record<string, unknown>;
  const fund = evidence.fundamental as Record<string, unknown>;

  const fundLines = [
    fund.pe_ratio != null ? `P/E: ${fund.pe_ratio}` : null,
    fund.profit_margin != null ? `margin: ${((fund.profit_margin as number) * 100).toFixed(1)}%` : null,
    fund.roe != null ? `ROE: ${((fund.roe as number) * 100).toFixed(1)}%` : null,
    fund.revenue_growth_yoy != null ? `rev growth: ${((fund.revenue_growth_yoy as number) * 100).toFixed(1)}%` : null,
    fund.sector ? `sector: ${fund.sector}` : null,
  ].filter(Boolean).join(" | ");

  const techLines = [
    tech.rsi14 != null ? `RSI-14: ${tech.rsi14}` : "RSI: n/a",
    tech.priceVsEma50 ? `vs EMA50: ${tech.priceVsEma50}` : null,
    tech.priceVsEma20 ? `vs EMA20: ${tech.priceVsEma20}` : null,
    tech.trend20d ? `20d trend: ${tech.trend20d}` : null,
  ].filter(Boolean).join(" | ");

  const heldNote = isHeld
    ? `This is a CURRENTLY HELD position. If signals are BEARISH (score < ${scoreThreshold} or strong sell), set direction "short" as an exit signal.`
    : `New candidate. direction MUST be "long" or "neutral" ONLY — never "short".`;

  const focusNote = marketFocus && marketFocus !== "US"
    ? `\nMarket focus: ${marketFocus}. Where relevant, frame risks/catalysts in context of these regions (macro exposure, currency risk, ADR premiums, regulatory environment).`
    : "";

  // India names carry NO StockTwits / Alpha Vantage sentiment (US-only). Their
  // Sentiment score above is derived from GDELT news TONE — surface the aggregate
  // tone + recent headlines so the thesis narrative is grounded in the same
  // evidence that produced the pre-computed Sentiment score (mirrors the US
  // socialBlock). Only shown when GDELT returned usable data; omitted otherwise.
  const indiaNewsBlock = indiaNews && indiaNews.available
    ? `\n\n## India news sentiment (GDELT — recent India news headlines, aggregate tone)
Aggregate tone: ${indiaNews.avgTone.toFixed(2)} (GDELT scale ~ -10 to +10; 0 = neutral) across ${indiaNews.articleCount} articles → Sentiment ${indiaNews.score}/100.
Recent headlines:
${indiaNews.headlines.map(h => `- ${h}`).join("\n")}
These are India news headlines with an aggregate tone; the Sentiment score above is derived from this news tone. Use them to ground the sentiment reasoning in your thesis (do NOT override the pre-computed Sentiment score).`
    : "";

  return `${DOCTRINE_PREAMBLE}

You are a professional equity analyst. All quantitative scores for ${symbol} were pre-computed from real fetched market data (no LLM estimation). Your ONLY job: write a coherent investment thesis, assign direction, and identify specific key risks and catalysts grounded in the data below.${focusNote}

## Pre-computed scores (DO NOT override — derive thesis FROM them)
Fundamental: ${fundamental_score}/100 | ${fundLines || "data unavailable"}
Technical:   ${technical_score}/100 | ${techLines}
Sentiment:   ${sentiment_score}/100
Macro:       ${macro_score}/100 | regime: ${(evidence.macro as Record<string, unknown>).regime ?? "unknown"}${indiaMacroLine ? `\n             India flows: ${indiaMacroLine} (ground macro/flow reasoning in this; do NOT override the pre-computed Macro score)` : ""}
Insider:     ${insider_score}/100
Weighted analyst score: ${analystScore}/100 (threshold for trade: ${scoreThreshold})${webullLine ? `\n${webullLine} (external analyst evidence — ground the analyst/target reasoning in this; do NOT override the pre-computed scores)` : ""}${indiaNewsBlock}

${heldNote}

Return ONLY valid JSON (no markdown, no prose):
{"direction":"long","summary":"2-3 sentence thesis citing specific numbers from the data above","key_risks":["specific risk 1","specific risk 2"],"catalysts":["specific catalyst 1","specific catalyst 2"]}`;
}

// Parse the first complete JSON object without assuming the response contains
// only one pair of braces. A greedy brace match can join multiple objects (or
// prose braces) into invalid JSON. This stays fail-closed: no direction is
// inferred when the provider did not return valid structured output.
function parseThesisJson(raw: string): { direction?: string; summary?: string; key_risks?: string[]; catalysts?: string[] } {
  const candidates: string[] = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { candidates.push(raw.slice(start, i + 1)); start = -1; }
    }
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const direction = ["long", "neutral", "short"].includes(String(value.direction).toLowerCase())
        ? String(value.direction).toLowerCase() : undefined;
      return {
        direction,
        summary: typeof value.summary === "string" ? value.summary : undefined,
        key_risks: Array.isArray(value.key_risks) ? value.key_risks.filter((x: unknown) => typeof x === "string").slice(0, 8) : undefined,
        catalysts: Array.isArray(value.catalysts) ? value.catalysts.filter((x: unknown) => typeof x === "string").slice(0, 8) : undefined,
      };
    } catch { /* try the next bounded candidate */ }
  }
  return {};
}

// ── Run-level evidence-quality health (System Health "data" category) ─────────
// Budget/cron/model faults are reported elsewhere; this covers the QUALITY case:
// the pipeline RAN fine but scored symbols on thin/insufficient evidence (most
// evidence dimensions missing), so the run's signals are low-confidence. There
// is no single "run finished" hook inside this module — the batch loop lives in
// the API routes — so we accumulate per-symbol availability into a module-level
// tally keyed by market and (idempotently) report the running verdict as the run
// progresses. reportIssue refreshes the single open alert in place, so the tally
// after the LAST symbol is what rests. A >10-min idle gap since the previous
// symbol is treated as a NEW run and resets the tally (research symbols are
// processed back-to-back within one run; runs are hours apart), so counts never
// bleed across runs/days.
type EvidenceTally = {
  scored: number;                          // symbols scored this run
  thin: number;                            // scored on < MIN_USABLE_DIMS dimensions
  missingInThin: DimensionRecord<number>;  // among thin symbols, how often each dim was unavailable
  dimApplicable: DimensionRecord<number>;  // per dim: symbols this run for which the dim IS applicable
  dimAvailable: DimensionRecord<number>;   // per dim: of those, how many had real data (not starved)
  dimReported: DimensionRecord<boolean>;   // per-dim alert dedupe (avoid rewriting each symbol)
  lastTouched: number;                     // epoch ms of the last symbol recorded
  lastReportedThin: boolean | null;        // last verdict pushed to System Health (dedupes writes)
};
const RUN_EVIDENCE = new Map<string, EvidenceTally>();
const EVIDENCE_RUN_GAP_MS = 10 * 60_000;   // idle gap that starts a fresh tally
const MIN_USABLE_DIMS = 2;                 // fewer usable dims than this ⇒ insufficient evidence
const THIN_RUN_FRACTION = 0.5;             // ≥50% of scored symbols thin ⇒ flag
const THIN_RUN_MIN_SYMBOLS = 2;            // …and at least this many thin symbols
// Per-dimension starvation: among symbols where a dim IS applicable, the fraction
// that actually got real data. Below WARN ⇒ warn, below CRIT ⇒ critical — names
// the starving provider so a degraded source is caught the day it happens.
const DIM_AVAIL_MIN_APPLICABLE = 4;        // need this many applicable symbols before judging
const DIM_AVAIL_WARN = 0.85;
const DIM_AVAIL_CRIT = 0.70;

// `${market}:${dim}` combos whose SOURCE is sparse by nature — absence is EXPECTED,
// not a starvation fault. For these the availability alert is capped at "info"
// with honest wording, so a genuinely-sparse source (India news-tone via GDELT
// barely covers individual NSE names) never cries critical. The score already
// renormalizes over the remaining applicable dimensions when one is absent. Real
// breakage in a dense source (US fundamentals/technical at 0%) still goes critical.
// india:sentiment — GDELT barely covers NSE names.
// us:insider — insider is genuinely sparse: SEC Form 4 open-market P/S trades are
//   rare (most companies have <3 in 90d; awards/options/tax are excluded), so a
//   low availability rate is EXPECTED absence, not provider starvation. The
//   availability mask already renormalizes; alerting critical here is false noise.
const EXPECTED_SPARSE_DIMS = new Set<string>(["india:sentiment", "us:insider"]);

// Record one symbol's evidence availability and (idempotently) surface a
// low-confidence alert when a meaningful fraction of the run was scored on thin
// data. Never throws — a health-reporting failure must not break a research run.
async function recordRunEvidence(market: string, runKey: string, includedDims: ScoreDimension[], applicable: Set<ScoreDimension>, client: any): Promise<void> {
  try {
    const now = Date.now();
    const tallyKey = `${market}:${runKey}`;
    let acc = RUN_EVIDENCE.get(tallyKey);
    if (!acc || now - acc.lastTouched > EVIDENCE_RUN_GAP_MS) {
      acc = {
        scored: 0, thin: 0,
        missingInThin: { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 },
        dimApplicable: { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 },
        dimAvailable: { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 },
        dimReported: { fundamental: false, technical: false, sentiment: false, macro: false, insider: false },
        lastTouched: now, lastReportedThin: null,
      };
      RUN_EVIDENCE.set(tallyKey, acc);
    }
    acc.lastTouched = now;
    acc.scored += 1;
    if (includedDims.length < MIN_USABLE_DIMS) {
      acc.thin += 1;
      for (const d of SCORE_DIMENSIONS) if (!includedDims.includes(d)) acc.missingInThin[d] += 1;
    }
    // Per-dimension availability among APPLICABLE symbols only (a structurally
    // N/A dim — ETF fundamentals, India US-only sources — is never counted as
    // starvation).
    for (const d of SCORE_DIMENSIONS) {
      if (!applicable.has(d)) continue;
      acc.dimApplicable[d] += 1;
      if (includedDims.includes(d)) acc.dimAvailable[d] += 1;
    }
    // Fire/clear a per-dimension starvation alert when a dim's availability drops
    // among enough applicable symbols. Names the likely starving provider chain.
    const DIM_PROVIDER: Record<string, string> = {
      fundamental: market === "india" ? "Yahoo quoteSummary" : "Finnhub → Yahoo → SEC EDGAR",
      technical:   market === "india" ? "Upstox → Yahoo chart" : "Massive → AV",
      sentiment:   market === "india" ? "GDELT tonechart" : "StockTwits → GDELT → AV NEWS",
      insider:     market === "india" ? "NSE PIT" : "Massive Form 4 → SEC EDGAR → AV",
      macro:       "macro_regime table",
    };
    for (const d of SCORE_DIMENSIONS) {
      const appl = acc.dimApplicable[d];
      if (appl < DIM_AVAIL_MIN_APPLICABLE) continue;
      const rate = acc.dimAvailable[d] / appl;
      const dimKey = `data-availability:${market}:${d}`;
      const expectedSparse = EXPECTED_SPARSE_DIMS.has(`${market}:${d}`);
      if (rate < DIM_AVAIL_WARN) {
        await reportIssue({
          issueKey: dimKey,
          // Known-sparse source → info (expected, not a fault). Dense source low → warn/critical.
          severity: expectedSparse ? "info" : (rate < DIM_AVAIL_CRIT ? "critical" : "warn"),
          category: "data",
          title: `${d} data ${Math.round(rate * 100)}% available (${market.toUpperCase()})`,
          detail: expectedSparse
            ? `${acc.dimAvailable[d]}/${appl} ${market.toUpperCase()} symbols got real ${d} this run. ` +
              `This source (${DIM_PROVIDER[d]}) is sparse by nature for many ${market.toUpperCase()} names, so absence is EXPECTED — ` +
              `the score renormalizes over the remaining applicable dimensions. Not a starvation fault; informational only.`
            : `Only ${acc.dimAvailable[d]}/${appl} ${market.toUpperCase()} symbols where ${d} is applicable got real ${d} ` +
              `data this run — the rest were starved (provider throttled/exhausted or genuinely no data). ` +
              `Source chain: ${DIM_PROVIDER[d]}. Check that chain's keys/limits.`,
          autoExpireAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
        }, client).catch(() => {});
        acc.dimReported[d] = true;
      } else if (acc.dimReported[d]) {
        await resolveIssue(dimKey, client).catch(() => {});
        acc.dimReported[d] = false;
      }
    }

    const issueKey = `low-confidence-research:${market}`;
    const unhealthy = acc.thin >= THIN_RUN_MIN_SYMBOLS && acc.thin / acc.scored >= THIN_RUN_FRACTION;

    if (unhealthy) {
      const MKT = market.toUpperCase();
      const missing = SCORE_DIMENSIONS
        .filter(d => acc!.missingInThin[d] > 0)
        .sort((a, b) => acc!.missingInThin[b] - acc!.missingInThin[a]);
      const missingStr = missing.length
        ? missing.map(d => `${d} (missing in ${acc!.missingInThin[d]}/${acc!.thin})`).join(", ")
        : "multiple dimensions";
      const hint = market === "india"
        ? "Check the India data source (Yahoo/Kite fundamentals + candles) and Alpha Vantage budget."
        : "Check the data providers (Alpha Vantage budget/rate limit, FinancialDatasets, sentiment source).";
      await reportIssue({
        issueKey,
        severity: "warn",
        category: "data",
        title: `Low-confidence research (${MKT}) — ${acc.thin}/${acc.scored} symbols scored on thin data`,
        detail:
          `${acc.thin} of ${acc.scored} ${MKT} symbols this run were scored on fewer than ${MIN_USABLE_DIMS} of 5 ` +
          `evidence dimensions (fundamental/technical/sentiment/macro/insider), so this run's signals are lower ` +
          `confidence. Most-often-missing among thin symbols: ${missingStr}. ${hint}`,
        autoExpireAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
      }, client).catch(() => {});
      acc.lastReportedThin = true;
    } else if (acc.lastReportedThin !== false) {
      // Healthy run (or recovered mid-run) — clear any open alert once.
      await resolveIssue(issueKey, client).catch(() => {});
      acc.lastReportedThin = false;
    }
  } catch { /* health reporting must never break a research run */ }
}

// Adapt a GDELT India news result into the SocialSentiment shape so India flows
// through the SAME scoreSentiment / dataQuality path US social sentiment uses.
// Returns null unless the result is "available" (>=3 toned articles) so a thin or
// empty GDELT response leaves the sentiment dimension genuinely unavailable
// (excluded from the weighted score) rather than faked as a neutral 50.
function indiaNewsToSocial(symbol: string, news: IndiaNewsSentiment | null): SocialSentiment | null {
  if (!news || !news.available) return null;
  // GDELT tone (~ -10..+10) → AV's -1..+1 news-sentiment scale. scoreSentiment's
  // AV path then computes (sent+1)*50 = 50 + tone*5 — the identical 0-100 mapping
  // toneToScore uses. StockTwits fields are null (India has no StockTwits), so the
  // AV-news branch is the one taken.
  const avScaled = Math.max(-1, Math.min(1, news.avgTone / 10));
  const shrunkScore = shrinkSentimentScore(news.score, news.articleCount, 5);
  return {
    symbol,
    stocktwits_bullish_pct: null,
    stocktwits_bearish_pct: null,
    stocktwits_message_count: null,
    stocktwits_sample_size: null,
    av_news_sentiment: avScaled,
    av_news_articles: news.articleCount,
    gdelt_score: news.score,
    gdelt_articles: news.articleCount,
    // scoreSentiment reads sentiment_score first — feed the GDELT 0-100 directly.
    sentiment_score: shrunkScore,
    overall_sentiment: shrunkScore > 60 ? "Bullish" : shrunkScore < 40 ? "Bearish" : "Neutral",
    fetched_at: new Date().toISOString(),
    has_data: true,
  };
}

// Prewarm one symbol's evidence caches WITHOUT scoring. Calls the same fundamentals
// / sentiment / insider fetchers processSymbol uses — each is cache-first + paced,
// so this just populates av_cache ahead of the scoring run. No LLM, no scoring, no
// signal/packet writes. Used by the prewarm cron so a cold-start scoring run gets
// cache hits instead of bursting Massive/GDELT past their limits mid-run.
// Fully fail-soft: every fetch is caught; a warm failure just leaves that key cold.
export async function prewarmSymbol(entry: SymbolEntry): Promise<void> {
  const symbol = entry.symbol;
  const india = isIndia(symbol);
  const applicable = applicableDimensions(entry);
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const jobs: Promise<unknown>[] = [];
  // Fundamentals (skip ETFs — no company fundamentals).
  if (applicable.has("fundamental")) {
    jobs.push(india ? fetchIndiaOverview(symbol).catch(() => ({}))
                    : fetchUsOverview(symbol, () => fetchAVOverview(symbol, avKey)).catch(() => ({})));
  }
  // Sentiment (US: StockTwits+GDELT+AV-reserve; India: GDELT news tone).
  if (applicable.has("sentiment")) {
    jobs.push(india ? fetchIndiaNewsSentiment(symbol).catch(() => null)
                    : fetchSocialSentiment(symbol).catch(() => null));
  }
  // Insider (US equities only; Massive Form 4 → EDGAR → AV, all cache-warmed).
  if (applicable.has("insider") && !india) {
    jobs.push(resolveInsider(symbol, avKey).catch(() => null));
  }
  await Promise.allSettled(jobs);
}

// Process a single symbol: research → write research_packet + agent_signal
// Phase 0: all 5 scores computed deterministically. LLM writes thesis+direction only.
// P1: universeSnapshotId links this symbol's decision_observations row to the run's
// universe snapshot so cross-sectional ranks can be computed post-run.
export async function processSymbol(
  entry: SymbolEntry,
  supabase: any,
  universeSnapshotId?: number | null,
  evidenceRunId?: string | null,
  writeContext?: ResearchSignalWriteContext,
): Promise<{ symbol: string; analystScore: number; direction: string; conviction: number; source: string; tokensIn: number; tokensOut: number; currentPrice: number | null; priceTarget: number | null; stopLoss: number | null; scoreThreshold: number; obsId: number | null }> {
  const { symbol, isHeld, isEtf, assetClass = "us_equity" } = entry;
  const source: string = isHeld ? "holding" : "screener";
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";

  // India (.NS/.BO) uses Yahoo (free) for fundamentals + candles instead of
  // Alpha Vantage/FinancialDatasets, which are US-only. Social sentiment and
  // options/insider (US-only sources) are skipped for India → those dimensions
  // fall to their neutral baseline, which the score-detail panel flags honestly.
  const india = isIndia(symbol);
  // Structural capability map — a dimension a symbol can't have is never fetched
  // (ETF fundamentals, ADR insider, India US-only sources). Missing dimensions
  // are already excluded from the weighted score via the availability mask.
  const applicable = applicableDimensions(entry);

  // Phase 0: fetch all real data in parallel — no LLM-generated numbers
  const [socialResult, optionsResult, insiderResult, avOverview, candleResult, indiaNews, fiiDii] = await Promise.all([
    applicable.has("sentiment") && !india ? fetchSocialSentiment(symbol).catch(() => null) : Promise.resolve(null),
    applicable.has("options") ? fetchOptionsSignal(symbol).catch(() => null) : Promise.resolve(null),
    // Insider: SEC EDGAR Form 4 primary (free, official, unlimited) → Alpha
    // Vantage INSIDER_TRANSACTIONS fallback. Skipped for ETFs/India/ADRs (no
    // Form 4), which saves the fetch entirely.
    applicable.has("insider") ? resolveInsider(symbol, avKey).catch(() => null) : Promise.resolve(null),
    !applicable.has("fundamental")
      // No company fundamentals (ETF) — scoreFundamentals uses the ETF baseline
      // via isEtf; skip the fetch (don't waste an FMP/AV call).
      ? Promise.resolve({})
      : india
        ? fetchIndiaOverview(symbol)
            // PIT capture-on-fetch (additive, non-blocking, fail-open): archive a
            // fundamental_facts vintage. Never awaited, never throws into scoring.
            .then(ov => { void captureFundamentalsFact(supabase, { symbol, market: "india", values: ov, source: "yahoo" }); return ov; })
            .catch(() => ({}))
        // US equities: FMP (own 250/day budget) → Alpha Vantage OVERVIEW
        // fallback, mapped to the same OVERVIEW shape scoreFundamentals reads.
        : fetchUsOverview(symbol, () => fetchAVOverview(symbol, avKey))
            .then(r => { void captureFundamentalsFact(supabase, { symbol, market: "us", values: r.overview, source: r.source }); return r.overview; })
            .catch(() => ({})),
    // The resolved candle SOURCE is carried alongside the bars now (it was
    // previously discarded) so the return-observation contract can record the
    // provider its evidence came from. Same fetches, same fallback order.
    india
      // India candles: Upstox (official, analytics token) primary → Yahoo
      // chart (unofficial) fallback. Upstox is more reliable than the Yahoo
      // endpoint that can change shape / anti-bot without notice.
      ? fetchUpstoxCandles(symbol)
          .then(c => c.length >= 15
            ? { candles: c, source: "upstox" }
            : fetchIndiaCandles(symbol).then(y => ({ candles: y, source: y.length ? "yahoo" : "unavailable" })))
          .catch(() => fetchIndiaCandles(symbol)
            .then(y => ({ candles: y, source: y.length ? "yahoo" : "unavailable" }))
            .catch(() => ({ candles: [] as Candle[], source: "unavailable" })))
      // US candles: Massive → EODHD → Twelve Data → Alpha Vantage (fallback).
      // RSI/EMA still computed locally from whichever source returns bars, so
      // the scarce AV 25/day budget is no longer spent on candles.
      : fetchUsCandles(symbol, () => fetchAVCandles(symbol, avKey))
          .catch(() => ({ candles: [] as Candle[], source: "unavailable" })),
    // India news sentiment (GDELT, free/no-key) — the India equivalent of the
    // US social/news sentiment fetch above. Non-ETF India names only; US falls
    // through null (US uses fetchSocialSentiment). Company name isn't known yet
    // (overview fetches in parallel), so the de-suffixed symbol is the query.
    india && applicable.has("sentiment")
      ? fetchIndiaNewsSentiment(symbol).catch(() => null)
      : Promise.resolve(null),
    // India macro backdrop: live FII/DII institutional cash-market flows (NSE,
    // free). Market-wide, not per-symbol — run-level in-memory cached so it's one
    // real NSE hit per pass. Fails soft to null (NSE blocks datacenter IPs), in
    // which case no India-macro flow line is added and the macro dimension keeps
    // the US/global backdrop. NEVER fabricates a flow number.
    india ? fetchFiiDiiFlows().catch(() => null) : Promise.resolve(null),
  ]);
  const candles: Candle[] = candleResult.candles;
  const indiaMacroLine = india ? fiiDiiMacroLine(fiiDii) : null;

  // Return-observation capture (features/correlation-aware-construction §0 item 1).
  // MEASURE-ONLY: appends an immutable per-symbol return observation (vol, and beta
  // ONLY when genuinely measurable vs the market's own benchmark) from the candles
  // ALREADY fetched above — no additional provider call. The benchmark series is the
  // shared run-level one the regime path already loads, so this adds no fetch either.
  // Starts concurrently with scoring/LLM work and joins before processSymbol
  // returns. It stays fail-soft but cannot be abandoned by serverless teardown.
  // NOTHING on the money path reads these rows.
  const returnCapturePromise = candles.length >= 2
    ? getBenchmarkSeries(india ? "india" : "us", supabase)
      .then(benchmark => captureReturnObservation(supabase, {
        symbol,
        market: india ? "india" : "us",
        candles,
        source: candleResult.source,
        benchmark,
      }))
      .catch(() => null)
    : Promise.resolve(null);

  // For India, synthesize a SocialSentiment-shaped object from the GDELT news
  // tone so it flows through the EXACT same scoreSentiment / dataQuality path US
  // social sentiment uses. has_data drives dataQuality.sentimentDataAvailable →
  // the availability mask: only "available" (>=3 toned articles) counts as real
  // evidence, so a thin/empty GDELT result leaves sentiment unavailable, not faked.
  const effectiveSocial: SocialSentiment | null = india
    ? indiaNewsToSocial(symbol, indiaNews)
    : socialResult;

  // Analyst-recommendation dimension (Finnhub, free). Wall-Street consensus is a
  // genuine predictive axis, but per CLAUDE.md's pushback mandate — don't add a
  // scoring dimension before the learning loop can validate it improves outcomes
  // — it is captured as LOGGED EVIDENCE (decision_observations.features.analyst)
  // for the LearnerAgent to grade, NOT fed into the live weighted score yet. It
  // earns promotion to a full weighted dimension once it has an IC track record.
  const analystResult = applicable.has("analyst")
    ? await scoreAnalyst(symbol).catch(() => null)
    : null;

  // Webull MCP as a FREE, read-only research DATA provider (US symbols ONLY).
  // Additive + absolutely fail-soft: when Webull isn't connected (or any call
  // fails) this resolves to null and nothing downstream changes — research runs
  // exactly as before. It contributes a grounding "Webull analyst: rating X,
  // target $Y, EPS fcst Z" line to the thesis prompt's evidence section (like
  // the India FII/DII flow line), NOT a new weighted scoring dimension — same
  // conservative posture as the Finnhub analyst evidence above. India names skip
  // it entirely (Webull MCP covers US symbols). Off the AV/provider budget.
  const webullAnalyst: WebullAnalyst | null = !india
    ? await fetchWebullAnalyst(symbol).catch(() => null)
    : null;

  // Event-proximity: days to next earnings. Logged for the learner to test the
  // "buy the rumor, sell the news" pattern (does pre-earnings hype fade after
  // the print?). Not a gate or sizing input — just an observed feature. ETFs
  // have no single-company earnings date, so skip the fetch (saves a Finnhub call).
  const daysToEarnings = isEtf ? null : await fetchDaysToEarnings(symbol, india).catch(() => null);

  // Compute all 5 scores deterministically from fetched data
  const scores = await computeScores({
    symbol, isEtf,
    avOverview: avOverview as Record<string, string>,
    candles,
    socialResult: effectiveSocial,
    insiderResult,
    supabase,
  });

  const market = india ? "india" : "us"; // Phase 4: per-market champion weights
  const tradingMandate = await loadTradingMandate(supabase, market);

  // Weight resolution is champion-first → static per-risk-profile baseline. The
  // legacy global `signal_weights` row is NO LONGER read here: it was an
  // unreachable 3rd fallback (PROFILE_WEIGHTS always resolves first in the ?? chain
  // below), and reading a single global row on a per-market scoring path was the
  // vestige Codex Q6 flagged. The table still exists for the Agents-page display;
  // removing it there is deferred until that view is made market-aware.
  const [{ data: strategy }, { data: profileData }, { data: scoreHistory }] = await Promise.all([
    supabase.from("strategy_config").select("risk_profile, score_threshold, min_analyst_score, position_size_pct, stop_loss_pct, target_pct").single(),
    supabase.from("profiles").select("market_focus").limit(1).single(),
    // Recent score history for THIS symbol so the thesis prompt can reference the
    // trend (rising/falling conviction) rather than judging the symbol in isolation.
    supabase.from("signal_score_history").select("analyst_score, created_at").eq("symbol", symbol).eq("market", market).order("created_at", { ascending: false }).limit(5),
  ]);
  const marketFocus: string = (profileData as any)?.market_focus ?? "US";

  // CLOSED LOOP: the promoted champion strategy's weight snapshot. LearnerAgent
  // proposes weight challengers → user promotes one to champion → THIS is where
  // that approved learning gets consumed. Phase 4: each MARKET has its own
  // champion, so an India stock scores off India-learned weights and a US stock
  // off US weights — no cross-contamination. Resilient: pre-057 (no `market`
  // column) the market-filtered query errors, so we fall back to the global
  // champion, preserving prior US behavior.
  let champion: any = null;
  {
    const scoped = await supabase.from("strategy_versions").select("id, weights_snapshot, genome")
      .eq("is_champion", true).eq("market", market)
      .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (scoped.error) {
      const legacy = await supabase.from("strategy_versions").select("id, weights_snapshot, genome")
        .eq("is_champion", true).order("promoted_at", { ascending: false }).limit(1).maybeSingle();
      champion = legacy.data;
    } else {
      champion = scoped.data;
    }
  }

  const PROFILE_WEIGHTS: Record<string, Record<string, number>> = {
    conservative: { fundamental: 0.40, technical: 0.20, sentiment: 0.15, macro: 0.15, insider: 0.10 },
    balanced:     { fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10 },
    aggressive:   { fundamental: 0.20, technical: 0.30, sentiment: 0.25, macro: 0.15, insider: 0.10 },
  };

  const profileKey = (strategy?.risk_profile ?? "balanced") as string;
  const profileWeights = PROFILE_WEIGHTS[profileKey] ?? PROFILE_WEIGHTS.balanced;

  // Champion weights take priority when a promoted champion exists. The snapshot
  // may use either short keys ({fundamental: 0.3}) from the seed row or the
  // *_weight keys ({fundamental_weight: 0.3}) LearnerAgent's challengers write —
  // read both. Falls back to the static profile table (then signal_weights) when
  // no champion is promoted, preserving prior behavior.
  const champWeights = (champion as any)?.weights_snapshot ?? null;
  const cw = (short: string, full: string): number | undefined => {
    if (!champWeights) return undefined;
    const v = champWeights[short] ?? champWeights[full];
    return typeof v === "number" ? v : undefined;
  };
  const usingChampion = !!champWeights;

  const fw = cw("fundamental", "fundamental_weight") ?? profileWeights.fundamental ?? 0.30;
  const tw = cw("technical",   "technical_weight")   ?? profileWeights.technical   ?? 0.25;
  const sw = cw("sentiment",   "sentiment_weight")   ?? profileWeights.sentiment   ?? 0.20;
  const mw = cw("macro",       "macro_weight")       ?? profileWeights.macro       ?? 0.15;
  const iw = cw("insider",     "insider_weight")     ?? profileWeights.insider     ?? 0.10;

  // Renormalize across only applicable + available dimensions instead of always
  // applying the fixed 5-way split against a fabricated neutral-50 default.
  // Two distinct reasons a dimension gets excluded:
  //  - INAPPLICABLE: fundamental/insider are structurally meaningless for ETFs
  //    (no company financials, no insiders) — scoreFundamentals/normalizeInsiderScore
  //    already return a flat baseline for these, not a real signal.
  //  - UNAVAILABLE: data fetch genuinely failed this run (e.g. macro rate-limited,
  //    no sentiment data) — scores.dataQuality flags these.
  // Shared with lib/validation/engine.ts (computeWeightedAnalystScore) so a
  // challenger is validated against the SAME scoring rule that runs live.
  const dq = scores.dataQuality ?? ({} as any);
  const included: DimensionRecord<boolean> = {
    fundamental: !isEtf && (dq.fundamentalDataAvailable ?? true),
    // scoreTechnicals/computeTechnicals both require >=15 candles before
    // computing a real RSI(14)/EMA20 — below that they already return neutral
    // 50 internally, but this check previously only required >0 candles, so a
    // 1-14 candle sliver counted as "available" real technical evidence.
    technical: (dq.technicalDataPoints ?? 0) >= 15,
    sentiment: dq.sentimentDataAvailable ?? true,
    macro: dq.macroDataAvailable ?? true,
    insider: dq.insiderDataAvailable ?? true,
  };
  const weightOf = applyStrategyTilt<ScoreDimension>(
    { fundamental: fw, technical: tw, sentiment: sw, macro: mw, insider: iw },
    tradingMandate.strategy_preference,
  ) as DimensionRecord<number>;
  const scoreOf: DimensionRecord<number> = {
    fundamental: scores.fundamental_score, technical: scores.technical_score,
    sentiment: scores.sentiment_score, macro: scores.macro_score, insider: scores.insider_score,
  };
  const { score: analystScore, effWeights, renormalized, includedDims } = computeWeightedAnalystScore(scoreOf, included, weightOf);
  const thinEvidence = isThinEvidence(includedDims);

  // System Health (data category): accumulate this symbol's evidence
  // availability into the run tally and surface a low-confidence alert if a
  // meaningful fraction of the run was scored on thin data. Fail-soft.
  await recordRunEvidence(market, evidenceRunId ?? String(universeSnapshotId ?? "unscoped"), includedDims, applicable as Set<ScoreDimension>, supabase);

  // Build 1 (genome as live control): the promoted champion's genome sets the
  // entry threshold when present, falling back to strategy_config exactly as
  // before. DEFAULT_GENOME.entry.score_threshold is 60 — identical to the prior
  // final fallback — so a market with no genome-bearing champion is unchanged.
  // The genome's threshold is hard-bounded to [50,75] at promotion time.
  const scoreThreshold = tradingMandate.score_threshold;
  const stopLossPct = tradingMandate.stop_loss_pct;
  const targetPct = tradingMandate.target_pct;

  // Score-trend note from this symbol's recent history — lets the thesis reason
  // about momentum in conviction ("score rising over the last N runs") instead
  // of judging the symbol cold each time.
  const priorScores = ((scoreHistory ?? []) as any[]).map(r => Number(r.analyst_score)).filter(Number.isFinite).reverse();
  let trendNote = "";
  if (priorScores.length >= 2) {
    const oldest = priorScores[0];
    const delta = analystScore - oldest;
    const dir = delta > 3 ? "rising" : delta < -3 ? "falling" : "flat";
    trendNote = `\n\nSCORE TREND: this symbol's analyst score over its last ${priorScores.length} runs was [${priorScores.join(", ")}] → now ${analystScore} (${dir}, ${delta >= 0 ? "+" : ""}${delta}). Factor this momentum into your conviction.`;
  }

  // Trade-history RAG (Tier-3 #10): retrieve the most similar PAST CLOSED trades
  // (cross-symbol, same market cohort) by setup similarity and fold their realized
  // outcomes into the thesis prompt — "the last N times we took a setup like this,
  // here is what happened." No-op (empty note) when embeddings are disabled or the
  // memory corpus is empty; never blocks a research run.
  let memoryNote = "";
  if (!isHeld) try {
    const memories = await retrieveSimilarTrades({
      setup: {
        symbol,
        market,
        analyst_score: analystScore / 100,
        fundamental_score: scores.fundamental_score / 100,
        technical_score: scores.technical_score / 100,
        sentiment_score: scores.sentiment_score / 100,
        macro_score: scores.macro_score / 100,
      },
      market,
      k: 5,
      source: "research-thesis",
    });
    const summary = summarizeMemories(memories);
    if (summary) {
      memoryNote =
        `\n\nPRIOR SIMILAR SETUPS (retrieved from trade history — same market, ` +
        `ranked by setup similarity; these are OUTCOMES, not the current name):\n${summary}\n` +
        `Weigh this base rate against your conviction. A setup class that has lost repeatedly is a warning.`;
    }
  } catch { /* RAG is best-effort — a retrieval failure must not block research */ }

  // LLM only writes thesis + direction — no score generation.
  // US-only Webull analyst grounding line (null when not connected/India → omitted).
  const webullLine = !india ? webullAnalystLine(webullAnalyst) : null;
  const thesisPrompt = isHeld ? "" : buildThesisOnlyPrompt(symbol, false, scores, analystScore, scoreThreshold, marketFocus, india ? indiaNews : null, indiaMacroLine, webullLine) + trendNote + memoryNote;
  const llmResult = isHeld ? {
    text: JSON.stringify({
      direction: analystScore < scoreThreshold ? "short" : "long",
      summary: `Deterministic holding reassessment: score ${analystScore}/100 from ${includedDims.join(", ") || "no usable dimensions"}.`,
      key_risks: [],
      catalysts: [],
    }),
    tokensIn: 0,
    tokensOut: 0,
  } : await callLLM({
    task: "screen",
    model: await getConfiguredModel(supabase, "research", "deepseek-reasoner"),
    prompt: thesisPrompt,
    symbol,
    agentLabel: "research",
    // deepseek-reasoner emits a long chain-of-thought BEFORE the answer; 512 tokens
    // let the reasoning consume the budget and truncated the JSON thesis, so most
    // symbols hit "[abstained: thesis parse failed]". 1500 leaves room for the
    // reasoning + the small JSON payload to complete.
    maxTokens: 1500,
  });

  const rawText = llmResult.text;
  const tokenUsage = { input: llmResult.tokensIn, output: llmResult.tokensOut };

  // Parse thesis response — LLM only returns { direction, summary, key_risks, catalysts }
  const thesis = parseThesisJson(rawText);

  // Force abstain when evidence is too thin (fewer than 2 usable dimensions —
  // e.g. India with fundamentals unavailable leaves only technical) OR the LLM
  // thesis parse failed. Previously a missing/unparseable thesis fell back to
  // `analystScore >= threshold ? "long" : "neutral"`, which could still open a
  // long position on a single technical-only signal with no thesis backing it.
  // Held positions must always retain SELL/exit capability (CLAUDE.md locked
  // rule) — thin-evidence abstention applies only to NEW long entries, never
  // suppresses an exit signal on an existing holding.
  // P0 mechanical direction gate — direction is deterministic, not LLM-driven.
  // LLM thesis provides NARRATIVE ONLY (summary/risks/catalysts). For new
  // positions, direction is `long` iff analystScore clears threshold AND
  // evidence is not thin. Held-position exit ("short") is ALSO deterministic:
  // score below the mandate threshold — NOT the LLM's direction field. This
  // closes the last LLM-discretion hole on the money path (an LLM "short" used
  // to become an executable exit signal stored as deterministic_v1, and could
  // teach the learner from LLM-created outcomes). SELL capability on holdings
  // is PRESERVED (CLAUDE.md locked rule) — it is just evidence-driven now.
  // The LLM's raw opinion is still recorded as advisory in
  // research_packets.raw_data._original_direction for later analysis.
  // Gate logic lives in lib/signal-direction.ts (pure, unit-tested) so the
  // invariant "LLM output cannot set an executable direction" is provable.
  const llmParseFailed = !thesis.direction; // still surfaced in decision_observations
  const gate = resolveSignalDirection({
    isHeld,
    analystScore,
    scoreThreshold,
    thinEvidence,
    includedDimsCount: includedDims.length,
    llmDirection: thesis.direction,
  });
  // Runtime evidence-degradation guard (router-cutover §6). STRICTLY SUBTRACTIVE
  // and independent of the Router (which stays disabled): it protects the LEGACY
  // path too. It compares this symbol's REQUIRED evidence fields against the last
  // accepted market-local baseline and abstains from a NEW long whose eligibility
  // now rests on renormalizing around a field we lost. It can only turn "long"
  // into "neutral" — an exit ("short") passes through untouched, because an
  // evidence outage must never suppress a stop or a mandatory exit.
  //
  // SHIPPED IN MEASURE-ONLY MODE (EVIDENCE_DEGRADATION_GUARD_MODE unset): it
  // records what it WOULD abstain and changes nothing, so it can be observed on
  // real traffic before it bites. Set the env to "enforce" to make it apply.
  const guardRun = await runDegradationGuard({
    market: market as Market,
    symbol,
    shape: symbolShapeOf({ isEtf, isAdr: US_ADRS.has(symbol.toUpperCase()), isMetal: assetClass === "metal" }),
    isHeld,
    observations: observationsFromLegacyMask({
      isEtf,
      isAdr: US_ADRS.has(symbol.toUpperCase()),
      isMetal: assetClass === "metal",
      applicable: applicable as Set<string>,
      included: included as Record<string, boolean>,
      renormalized,
      technicalDataPoints: dq.technicalDataPoints ?? 0,
    }),
    proposedDirection: gate.direction,
    policyVersionId: "",   // legacy path: no frozen router policy governs this run
    evidenceRunId: evidenceRunId ?? String(universeSnapshotId ?? "unscoped"),
    runKey: evidenceRunId ?? String(universeSnapshotId ?? "unscoped"),
    client: supabase,
  });

  const signalDirection: string = guardRun.direction;
  const directionNote: string = gate.note + guardRun.note;

  const { data: packet } = await supabase
    .from("research_packets")
    .insert({
      symbol,
      fundamental_score: scores.fundamental_score,
      technical_score:   scores.technical_score,
      sentiment_score:   scores.sentiment_score,
      macro_score:       scores.macro_score,
      insider_score:     scores.insider_score,
      summary:    thesis.summary   ?? `Analyst score: ${analystScore}. Direction: ${signalDirection}.`,
      key_risks:  thesis.key_risks ?? [],
      catalysts:  thesis.catalysts ?? [],
      is_held_position: isHeld,
      raw_data: {
        _scores: scores,
        _analyst_score: analystScore,
        _profile_weights: { fw, tw, sw, mw, iw },
        _original_direction: thesis.direction ?? "unparsed",  // P0: LLM opinion (may differ from gate output)
        _direction_override: thesis.direction !== signalDirection,
        _data_quality: scores.dataQuality,
        _social_sentiment: effectiveSocial ?? null,
        _india_news: india ? (indiaNews ?? null) : null,
        _options_signal:   optionsResult ?? null,
        _using_champion_weights: usingChampion,
        _trading_mandate: tradingMandate,
      },
    })
    .select()
    .single();

  const signalStatus = writeContext?.status ?? "pending";
  const sessionValidated = writeContext?.sessionValidated ?? true;
  const signalRow: Record<string, any> = {
    symbol,
    direction: signalDirection,
    analyst_score: analystScore,
    conviction: Math.min(100, analystScore), // Phase 0: conviction mirrors analyst score
    // Per-dimension scores were computed above (used for the weighted
    // analyst_score) but never persisted — Smart Money's "All Signals" and
    // other dimension-breakdown views always showed "—" for every signal
    // generated via this path even though real scores existed in memory.
    fundamental_score: scores.fundamental_score,
    technical_score: scores.technical_score,
    sentiment_score: scores.sentiment_score,
    macro_score: scores.macro_score,
    insider_score: scores.insider_score,
    agent_type: "research",
    research_packet_id: packet?.id ?? null,
    status: signalStatus,
    session_validated: sessionValidated,
    as_of_session: writeContext?.asOfSession ?? new Date().toISOString().slice(0, 10),
    staged_at: sessionValidated ? null : new Date().toISOString(),
    source,
    is_holding: isHeld,
    rationale: (thesis.summary ?? `Score: ${analystScore}/100`) + directionNote,
    // NOTE: no price_target / stop_loss here — those columns don't exist on
    // agent_signals (only stop_loss_pct / take_profit_pct do). Including them made
    // every PostgREST insert fail with PGRST204, and the undefined-column recovery
    // below only strips `market`, so the retry failed too and the signal was
    // silently dropped — zeroing out the whole pipeline. PaperTrader sets targets
    // at fill time from the real price anyway.
    asset_class:  assetClass,
    market, // Phase 4: routes the signal to its market's paper pool + champion
    score_source: "deterministic_v1",   // P0: structural provenance tag — gates paper/live consumption
    scoring_version: "v1.0",            // P0: linked to strategy_versions lifecycle
  };

  // Attach default mandate (fail-soft: pre-133 schema or missing table → no-op)
  const mandateId = await getDefaultMandateId(market, supabase).catch(() => null);
  if (mandateId) signalRow.mandate_id = mandateId;
  // Capture the inserted row's id (Research Journal needs this to join
  // decision_observations -> pipeline_stage_events -> trade_proposals ->
  // paper_trades by a shared signal_id, instead of null throughout).
  let insertedSignalId: string | null = null;
  let signalInsertError: string | null = null;
  {
    // Only one active staged decision per market/symbol. Superseding preserves
    // history while satisfying the partial unique index under normal retries.
    if (!sessionValidated) {
      await supabase.from("agent_signals").update({ status: "superseded" })
        .eq("market", market).eq("symbol", symbol).eq("status", "weekend_staged");
    }
    const { data, error } = await supabase.from("agent_signals").insert(signalRow).select("id").maybeSingle();
    // Strip `market` ONLY when the column is genuinely undefined (pre-057) — never
    // on a transient/constraint error, which would silently drop the market tag.
    const undefinedCol = error && (["42703", "PGRST204"].includes(String(error.code ?? "")) ||
      /column .* does not exist|could not find the '.*' column/i.test(String(error.message ?? "")));
    if (undefinedCol) {
      delete signalRow.market;
      delete signalRow.score_source;   // strip P0 cols on pre-136 schema
      delete signalRow.scoring_version;
      delete signalRow.session_validated;
      delete signalRow.as_of_session;
      delete signalRow.staged_at;
      const retry = await supabase.from("agent_signals").insert(signalRow).select("id").maybeSingle();
      insertedSignalId = retry.data?.id ?? null;
      signalInsertError = retry.error?.message ?? null;
    } else if (error) {
      console.error("[research-agent] agent_signals insert failed:", error.message);
      signalInsertError = error.message;
    } else {
      insertedSignalId = data?.id ?? null;
    }
    if (!insertedSignalId) {
      throw new Error(`agent_signals insert failed for ${symbol}: ${signalInsertError ?? "insert returned no row"}`);
    }
    // Revalidation never mutates a staged score into an executable score. The
    // fresh row above is the decision; the older stage becomes audit history.
    if (insertedSignalId && sessionValidated) {
      await supabase.from("agent_signals").update({ status: "revalidated" })
        .eq("market", market).eq("symbol", symbol).eq("status", "weekend_staged");
    }
  }

  // Append-only score history — the durable per-symbol score trajectory that
  // the ScoreTrajectory chart and the trend context above read from. Unlike
  // agent_signals (whose rows get status-mutated and filtered), this is never
  // touched after insert. Best-effort: a logging failure must not fail the
  // research run, and if migration 054 hasn't been applied yet this simply
  // no-ops until it is.
  const baseScoreRow = {
    symbol,
    analyst_score: analystScore,
    fundamental_score: scores.fundamental_score,
    technical_score: scores.technical_score,
    sentiment_score: scores.sentiment_score,
    macro_score: scores.macro_score,
    insider_score: scores.insider_score,
    direction: signalDirection,
    source,
  };
  // Self-explaining fields (migration 055) — let the Score Tracker's point-click
  // drill-down show WHY the score moved. Fall back to the base row if migration
  // 055 hasn't been applied yet (columns missing) so writes never stop.
  const { error: scoreHistErr } = await supabase.from("signal_score_history").insert({
    ...baseScoreRow,
    rationale: thesis.summary ?? `Analyst score ${analystScore}, direction ${signalDirection}.`,
    research_packet_id: packet?.id ?? null,
    used_champion_weights: usingChampion,
    market, // Phase 4: per-market score trajectory
  });
  if (scoreHistErr) {
    // Retry keeping the market tag (only the 055 self-explaining cols missing);
    // fall to the bare base row only if that ALSO fails (pre-057, no market col).
    const { error: e2 } = await supabase.from("signal_score_history").insert({ ...baseScoreRow, market });
    if (e2) {
      const { error: e3 } = await supabase.from("signal_score_history").insert(baseScoreRow);
      if (e3) console.error("[research-agent] signal_score_history insert failed:", e3.message);
    }
  }

  // Phase 1 learning-core: immutable decision observation for EVERY scored
  // candidate (filled or rejected) — the point-in-time ground truth the learner
  // will train on. Fail-soft: a missing table (059 not applied) must never fail
  // a research run.
  let insertedObsId: number | null = null;
  try {
    // Reuse the SAME `included` object that actually drove the weighting above
    // — this used to be recomputed independently from raw dataQuality flags,
    // which disagreed for ETFs (dataQuality.fundamentalDataAvailable is true
    // for ETFs by design, but `included.fundamental` correctly excludes them
    // as inapplicable). A validation replay reading availability_mask must see
    // the real basis for the live weighting, not a second, drifted copy of it.
    const availability_mask = included;
    // Phase 3: point-in-time regime features (trend/vol vs SPY or ^NSEI),
    // appended under features.regime.* for later interaction terms — never a
    // hard bull/bear switch, just observable numbers for the calibration fit.
    const regime = await getRegimeFeatures(market, supabase);
    // Research Journal: record which screener bucket/criteria flagged this
    // candidate (undefined for held/watchlist symbols — only screener adds get one).
    const screener = entry.screenerBucket
      ? { bucket: entry.screenerBucket, criteria_matched: BUCKET_CRITERIA[entry.screenerBucket] }
      : undefined;
    const entryEligible = signalDirection === "long" && analystScore >= (scoreThreshold ?? 60);

    // Phase 3: log (never score with) any 'active' feature_registry formula's
    // value for this decision. Building the IC track record that would justify
    // eventually promoting a feature into the real weighting formula is a
    // separate, evidence-gated decision — not this one. Fail-soft: an invalid
    // formula or DB miss must never block the actual research decision.
    let activeFeatureValues: Record<string, number | null> | undefined;
    try {
      const { data: activeFeatures } = await supabase.from("feature_registry")
        .select("name, spec").eq("status", "active");
      if (activeFeatures?.length) {
        const ctxValues: Record<string, number> = {
          fundamental_score: scores.fundamental_score, technical_score: scores.technical_score,
          sentiment_score: scores.sentiment_score, macro_score: scores.macro_score, insider_score: scores.insider_score,
        };
        for (const [dim, evidence] of Object.entries(scores.evidence ?? {})) {
          for (const [k, v] of Object.entries((evidence as any) ?? {})) {
            if (typeof v === "number") ctxValues[`${dim}.${k}`] = v;
          }
        }
        activeFeatureValues = {};
        for (const feat of activeFeatures as any[]) {
          try {
            activeFeatureValues[feat.name] = evaluateFeature(feat.spec?.formula ?? "", { values: ctxValues });
          } catch { activeFeatureValues[feat.name] = null; }
        }
      }
    } catch { /* feature_registry may not exist pre-064 — never block research */ }

    // R7 (#22): weighted structural coverage for evidence_confidence — the share
    // of applicable BASE WEIGHT that has real evidence, over the 5 scored dims
    // only (`applicable` also holds options/analyst, which are not scored dims).
    const scoredApplicable = SCORE_DIMENSIONS.filter((d) => applicable.has(d as any));
    const applicableWeight = scoredApplicable.reduce((s, d) => s + (weightOf[d] ?? 0), 0);
    const presentWeight = includedDims.reduce((s, d) => s + (weightOf[d] ?? 0), 0);
    const evidenceConfidence = applicableWeight > 0
      ? Number((presentWeight / applicableWeight).toFixed(4))
      : null;

    const { data: obsRow, error: obsErr } = await supabase.from("decision_observations").insert({
      market,
      symbol,
      strategy_version_id: (champion as any)?.id ?? null,
      weights_used: effWeights, // the ACTUALLY-APPLIED weights (post-renormalization), not the base profile split
      used_champion: usingChampion,
      features: {
        schemaVersion: "v1",             // P1: version tag for PIT replay and feature-schema migration
        decisionTs: new Date().toISOString(), // P1: precise timestamp this observation was written
        ...(scores.evidence ?? {}), regime, ...(screener ? { screener } : {}),
        weighting: { renormalized, included_dims: includedDims, base_weights: weightOf, applied_weights: effWeights },
        trading_mandate: tradingMandate,
        ...(activeFeatureValues ? { active_feature_values: activeFeatureValues } : {}),
        // Analyst consensus (Finnhub) — LOGGED evidence for the learner to grade,
        // not fed into the live weighted score yet (see fetch site).
        ...(analystResult?.available ? { analyst: { score: analystResult.score, ...analystResult.evidence } } : {}),
        // Event proximity for the "buy the rumor, sell the news" learnable pattern.
        ...(daysToEarnings != null ? { days_to_earnings: daysToEarnings } : {}),
        // Structured per-dimension quality state for v_decision_quality and
        // future learner taint detection. Eliminates reliance on string heuristics
        // for rows written from this version forward.
        quality: Object.fromEntries(
          (["fundamental","technical","sentiment","macro","insider"] as const).map(dim => {
            const isApplicable = applicable.has(dim as "fundamental"|"technical"|"sentiment"|"macro"|"insider"|"options"|"analyst");
            const isPresent = included[dim] ?? false;
            const isDegraded = isPresent && !includedDims.includes(dim);
            const state = !isApplicable ? "inapplicable"
              : isPresent && !isDegraded ? "ok"
              : isDegraded ? "degraded"
              : "missing";
            return [dim, { state }];
          })
        ),
      },
      availability_mask,
      analyst_score: analystScore,
      fundamental_score: scores.fundamental_score,
      technical_score: scores.technical_score,
      sentiment_score: scores.sentiment_score,
      macro_score: scores.macro_score,
      insider_score: scores.insider_score,
      direction: signalDirection,
      entry_eligible: entryEligible,
      action: "signal_written",             // this code path always writes a signal today
      score_threshold: scoreThreshold ?? 60,
      price_at_decision: null,              // PaperTrader fetches price at fill time; not known here
      currency: market === "india" ? "INR" : "USD",
      signal_id: insertedSignalId,
      discovery_source: entry.discovery_source ?? null,
      mandate_id: mandateId ?? null,
      score_source: "deterministic_v1",
      scoring_version: "v1.0",
      // evidence_confidence = WEIGHTED structural coverage: the fraction of the
      // applicable base weight that actually has evidence. A raw dimension count
      // treated a missing 40%-weight dim the same as a missing 10% dim. Only the
      // 5 scored dimensions count (applicable also contains options/analyst).
      evidence_confidence: evidenceConfidence,
      universe_snapshot_id: universeSnapshotId ?? null,  // P1: links to universe_snapshots for cross-sectional rank
    }).select("id").maybeSingle();
    if (obsErr && !/does not exist|could not find/i.test(obsErr.message ?? "")) {
      console.error("[research-agent] decision_observations insert failed:", obsErr.message);
    }
    insertedObsId = obsRow?.id ?? null;

    // Research Journal (Phase: pipeline instrumentation) — one stage event per
    // candidate scored. Fail-soft: never blocks the actual research decision.
    if (insertedSignalId) {
      try {
        await supabase.from("pipeline_stage_events").insert({
          signal_id: insertedSignalId,
          symbol, market,
          stage: "research",
          outcome: entryEligible ? "passed" : "rejected",
          reason: entryEligible
            ? `Eligible: long direction and score ${analystScore} >= threshold ${scoreThreshold ?? 60}`
            : thinEvidence
              ? `Abstained: thin evidence (${includedDims.length}/5 usable dimensions)`
              : llmParseFailed
                ? "Abstained: thesis response was missing a parseable direction"
                : analystScore < (scoreThreshold ?? 60)
                  ? `Rejected: score ${analystScore} < threshold ${scoreThreshold ?? 60}`
                  : `Abstained: score passed but direction was ${signalDirection}; score alone cannot authorize entry`,
          detail: {
            analyst_score: analystScore, score_threshold: scoreThreshold ?? 60,
            direction: signalDirection, screener, included_dimensions: includedDims,
            thin_evidence: thinEvidence, thesis_parse_failed: llmParseFailed,
          },
        });
      } catch { /* fail-soft — pre-migration schema or transient error */ }
    }

    // Phase 3 shadow A/B: up to 3 strategy_versions in state='shadow_paper' for
    // this market get a pure scoring-replay record — what EACH would have
    // decided, alongside the champion's real decision above. No fills, no cash.
    // Off by default (nothing enters shadow_paper without explicit action).
    if (obsRow?.id) {
      try {
        const { data: shadowVersions } = await supabase
          .from("strategy_versions").select("id, weights_snapshot")
          .eq("market", market).eq("state", "shadow_paper").limit(3);
        for (const sv of (shadowVersions ?? []) as any[]) {
          const wsnap = sv.weights_snapshot ?? {};
          const cwShadow = (short: string, full: string) => {
            const v = wsnap[short] ?? wsnap[full];
            return typeof v === "number" ? v : undefined;
          };
          // Same shared contract that grades the real champion score — a
          // challenger must be graded on the exact live scoring rule
          // (availability-mask + renormalization), not a raw fixed dot-product
          // that would penalize/inflate it relative to production for the
          // same reason Validation Engine needed this fix (see weighted-score.ts).
          const challengerWeights: DimensionRecord<number> = {
            fundamental: cwShadow("fundamental", "fundamental_weight") ?? fw,
            technical:   cwShadow("technical", "technical_weight") ?? tw,
            sentiment:   cwShadow("sentiment", "sentiment_weight") ?? sw,
            macro:       cwShadow("macro", "macro_weight") ?? mw,
            insider:     cwShadow("insider", "insider_weight") ?? iw,
          };
          const { score: shadowScore } = computeWeightedAnalystScore(scoreOf, included, challengerWeights);
          await supabase.from("shadow_decisions").insert({
            market, symbol, observation_id: obsRow.id, policy_version_id: sv.id,
            would_enter: shadowScore >= (scoreThreshold ?? 60), score: shadowScore,
          });
        }
      } catch (e) { console.error("[research-agent] shadow decision write threw:", e); }

      // P2: archetype setup-expert shadow scoring.
      // 6 archetypes score in shadow alongside champion v1. Only v1 is actionable.
      // Fail-soft: missing setup_type column pre-138 → no-op.
      try {
        const archetypeTargets = routeToArchetypes({
          isEtf,
          isIndia: india,
          daysToEarnings,
          fundamentalScore: scoreOf.fundamental,
        });
        const archetypeRows = archetypeTargets.map(archetype => {
          const { score: archScore } = computeArchetypeScore(archetype, scoreOf, included);
          return {
            market,
            symbol,
            observation_id: obsRow.id,
            policy_version_id: null,
            would_enter: archScore >= (scoreThreshold ?? 60),
            score: archScore,
            setup_type: archetype.id,
          };
        });
        if (archetypeRows.length > 0) {
          await supabase.from("shadow_decisions").insert(archetypeRows);
        }
      } catch (e) { console.error("[research-agent] archetype shadow write threw:", e); }
    }
  } catch (e) { console.error("[research-agent] observation write threw:", e); }

  await returnCapturePromise;

  return {
    symbol,
    analystScore,
    direction: signalDirection,
    conviction: Math.min(100, analystScore),
    source,
    tokensIn:  tokenUsage.input,
    tokensOut: tokenUsage.output,
    currentPrice: null, // PaperTrader fetches price at fill time via lib/data/quotes.ts
    priceTarget:  null,
    stopLoss:     null,
    scoreThreshold,
    obsId: insertedObsId,  // P1: for cron to write universe_snapshot_scores
  };
}
