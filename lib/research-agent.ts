import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";
import { callLLM } from "@/lib/llm-router";
import { fetchSocialSentiment, SocialSentiment } from "@/lib/social-sentiment";
import { fetchOptionsSignal, OptionsSignal } from "@/lib/options-signal";
import { computeScores, type ComputedScores } from "@/lib/data/scores";
import type { Candle } from "@/lib/data/technicals";
import { isIndia, fetchIndiaOverview, fetchIndiaCandles } from "@/lib/india-data";
import { niftyCandidates } from "@/lib/india-universe";
import { computeRegimeFeatures, type RegimeFeatures } from "@/lib/validation/regime";

// Phase 3 learning-core: per-run cache for benchmark regime features (SPY for
// US, ^NSEI for India) — computed once per market per process, not per symbol.
const regimeCache = new Map<string, { at: number; features: RegimeFeatures }>();
const REGIME_CACHE_TTL_MS = 30 * 60_000;

async function getRegimeFeatures(market: string, supabase: any): Promise<RegimeFeatures> {
  const cached = regimeCache.get(market);
  if (cached && Date.now() - cached.at < REGIME_CACHE_TTL_MS) return cached.features;
  try {
    let closes: number[] = [];
    if (market === "india") {
      const candles = await fetchIndiaCandles("^NSEI", "1y");
      closes = candles.map(c => c.close);
    } else {
      const { data } = await supabase.from("price_cache").select("close").eq("symbol", "SPY").order("date", { ascending: true }).limit(260);
      closes = (data ?? []).map((r: any) => parseFloat(r.close));
    }
    const features = computeRegimeFeatures(closes);
    regimeCache.set(market, { at: Date.now(), features });
    return features;
  } catch {
    return { trend: null, realizedVol: null, volTercile: null };
  }
}

// Insider scoring: fetch from Alpha Vantage INSIDER_TRANSACTIONS
async function scoreInsider(symbol: string, avKey: string): Promise<{ score: number; summary: string }> {
  try {
    const url = `https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${symbol}&apikey=${avKey}`;
    const res = await fetch(url);
    const data = await res.json();
    const transactions: any[] = data?.data ?? [];

    if (!transactions.length) return { score: 50, summary: "No insider transaction data available." };

    // Score based on recent 90 days
    const cutoff = Date.now() - 90 * 86400000;
    const recent = transactions.filter((t: any) =>
      new Date(t.transactionDate ?? t.transaction_date ?? "").getTime() > cutoff
    );

    if (!recent.length) return { score: 50, summary: "No insider transactions in past 90 days." };

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
    if (total === 0) return { score: 50, summary: `${recent.length} insider transactions found but no buy/sell value calculable.` };
    const buyRatio = buyValue / total;
    // 100% buying = score 90, 100% selling = score 10, balanced = 50
    const score = Math.round(10 + buyRatio * 80);
    const fmtVal = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}`;
    const summary = `${buyCount} buys (${fmtVal(buyValue)}) vs ${sellCount} sells (${fmtVal(sellValue)}) in past 90 days. Buy ratio: ${(buyRatio * 100).toFixed(0)}%.`;
    return { score, summary };
  } catch {
    return { score: 50, summary: "Insider data fetch failed." };
  }
}

const KNOWN_ETFS = new Set([
  // Broad market
  "SPY","VOO","QQQ","IWM","VTI","DIA","RSP",
  // Sector
  "XLK","XLF","XLE","XLI","XLV","XLU","XLRE","XLB","XLC","XLP","XLY",
  "SMH","SOXX","IBB","KRE","KBE","ITB","XME",
  // Thematic
  "BOTZ","AIQ","ICLN","NLR","ARKK","ARKG","ARKW","ARKF","ARKX","CIBR","ROBO","SKYY","WCLD","BUG",
  // Leveraged bull
  "TQQQ","SOXL","SPXL","UPRO","TECL","FAS","DUSL","DRN","UGL","FNGU","LABU","HIBL","MSTU","NVDL",
  // Leveraged bear
  "SQQQ","SOXS","SPXS","SPDN","FAZ","SIJ","DRV","GLL","SDOW","FNGD","LABD","HIBS","MSTZ","NVDD",
  // Commodities
  "USO","GLD","SLV","UNG","PDBC","IAU",
  // Bonds
  "TLT","SHY","IEF","HYG","LQD","BND","AGG","GOVT",
]);

const LEVERAGED_BEAR_ETFS = new Set([
  "SQQQ","SOXS","SPXS","SPDN","FAZ","SIJ","DRV","GLL","SDOW","FNGD","LABD","HIBS","MSTZ","NVDD",
]);

const TRADING_ACCOUNT = process.env.TRADING_ACCOUNT_NUMBER ?? "965848641";

export type SymbolEntry = {
  symbol: string;
  isHeld: boolean;
  isEtf: boolean;
  assetClass?: string; // "us_equity" | "etf" | "metal"
  screenerBucket?: "momentum" | "value"; // which dual-bucket screener flagged this (Research Journal)
};

const BUCKET_CRITERIA: Record<"momentum" | "value", string[]> = {
  momentum: ["revenue_growth>15%", "earnings_growth>10%", "gross_margin>25%", "ROE>15%", "market_cap>$2B"],
  value: ["0<P/E<18", "FCF_yield>4%", "debt_to_equity<1.0", "market_cap>$1B"],
};

const METAL_ETF_SYMBOLS = new Set(["GLD","SLV","GDX","GDXJ","IAU","UGL","GLL"]);
const METALS_BASKET = ["GLD","SLV","GDX","IAU"];

export function isEtfSymbol(s: string): boolean {
  return KNOWN_ETFS.has(s.toUpperCase());
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

// Phase 1A — fetch holdings from ALL live_account_snapshots (no MCP cold-start)
export async function fetchHoldings(supabase: any): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("live_account_snapshots")
      .select("positions_json")
      .order("captured_at", { ascending: false });

    if (!data || !Array.isArray(data)) return [];
    const symbols = new Set<string>();
    for (const row of data) {
      const positions = row?.positions_json;
      if (!Array.isArray(positions)) continue;
      for (const p of positions) {
        if (p?.symbol && typeof p.symbol === "string") symbols.add(p.symbol.toUpperCase());
      }
    }
    return Array.from(symbols);
  } catch {
    return [];
  }
}

// Phase 1B — fetch account snapshot (equity, buying power, positions) and cache it
export async function fetchAndStoreAccountSnapshot(): Promise<void> {
  const prompt = `Call the Robinhood MCP tool get_equity_positions with account_number: "${TRADING_ACCOUNT}"
Then call get_accounts to get buying_power and portfolio_value for that account.

Return ONLY a JSON object (no markdown):
{
  "equity": 12345.67,
  "buying_power": 5000.00,
  "portfolio_value": 12345.67,
  "position_count": 5,
  "positions": [
    {"symbol": "AAPL", "qty": 10, "avg_price": 175.00, "current_price": 182.00},
    {"symbol": "NVDA", "qty": 5, "avg_price": 490.00, "current_price": 510.00}
  ]
}

If any field is unavailable, use null.`;

  try {
    const stdout = await execClaude(prompt, 90000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const snap = JSON.parse(match[0]);

    // POST to our own API to store the snapshot
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    await fetch(`${baseUrl}/api/live-account/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
      body: JSON.stringify({
        account_id: TRADING_ACCOUNT,
        equity: snap.equity,
        buying_power: snap.buying_power,
        portfolio_value: snap.portfolio_value,
        position_count: snap.position_count,
        positions_json: snap.positions ?? null,
      }),
    }).catch(() => {});
  } catch {
    // Non-critical — don't fail research run
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
  limit = 10
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
    return results.map((r: any) => String(r.ticker ?? r.symbol ?? "").toUpperCase()).filter(Boolean);
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
    screenBucket([
      { field: "revenue_growth", operator: "gt", value: 0.15 },
      { field: "earnings_growth", operator: "gt", value: 0.10 },
      { field: "gross_margin", operator: "gt", value: 0.25 },
      { field: "return_on_equity", operator: "gt", value: 0.15 },
      { field: "market_cap", operator: "gt", value: 2_000_000_000 },
    ], fdKey, 10),
    screenBucket([
      { field: "pe_ratio", operator: "gt", value: 0 },
      { field: "pe_ratio", operator: "lt", value: 18 },
      { field: "free_cash_flow_yield", operator: "gt", value: 0.04 },
      { field: "debt_to_equity", operator: "lt", value: 1.0 },
      { field: "market_cap", operator: "gt", value: 1_000_000_000 },
    ], fdKey, 10),
  ]);

  const seen = new Map<string, "momentum" | "value">();
  for (const s of momentum) if (s.length > 0 && s.length <= 6) seen.set(s, "momentum");
  for (const s of value) if (s.length > 0 && s.length <= 6 && !seen.has(s)) seen.set(s, "value");

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
      };
    });
  }

  // fetchAndStoreAccountSnapshot is truly fire-and-forget: not in Promise.all (avoids its 90s cold-start blocking the pipeline)
  void fetchAndStoreAccountSnapshot();

  // expires_at filter mirrors app/api/watchlist/route.ts's GET — without this,
  // an expired Theme Scout pick (30-day default) kept getting re-researched
  // forever instead of retiring, since only the Watchlist UI page enforced it.
  const nowIso = new Date().toISOString();
  const [holdings, watchlistResult, screenerSymbols, profileResult] = await Promise.all([
    fetchHoldings(supabase),
    supabase.from("watchlist").select("symbol").or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    runScreener(supabase),
    supabase.from("profiles").select("market_focus").limit(1).single(),
  ]);

  const watchlistSymbols: string[] =
    (watchlistResult.data ?? []).map((r: any) => String(r.symbol).toUpperCase());

  const rawFocus: string = (profileResult.data as any)?.market_focus ?? "US";
  const focusRegions = rawFocus.split(",").map((s: string) => s.trim()).filter(Boolean);

  const result = new Map<string, SymbolEntry>();

  for (const sym of holdings) {
    const isMetal = METAL_ETF_SYMBOLS.has(sym);
    result.set(sym, { symbol: sym, isHeld: true, isEtf: isEtfSymbol(sym), assetClass: isMetal ? "metal" : isEtfSymbol(sym) ? "etf" : "us_equity" });
  }
  for (const sym of watchlistSymbols) {
    if (!result.has(sym)) {
      const isMetal = METAL_ETF_SYMBOLS.has(sym);
      result.set(sym, { symbol: sym, isHeld: false, isEtf: isEtfSymbol(sym), assetClass: isMetal ? "metal" : isEtfSymbol(sym) ? "etf" : "us_equity" });
    }
  }

  let screenerAdded = 0;
  for (const { symbol: sym, bucket } of screenerSymbols) {
    if (result.has(sym) || screenerAdded >= 3) continue;
    result.set(sym, { symbol: sym, isHeld: false, isEtf: false, assetClass: "us_equity", screenerBucket: bucket });
    screenerAdded++;
  }

  const cap = parseInt(process.env.RESEARCH_MAX_SYMBOLS ?? "10");
  const nonMetals = Array.from(result.values()).slice(0, cap);

  // Metals basket — always appended on top of cap (4 extra symbols, cheap ETF analysis)
  const metals: SymbolEntry[] = [];
  for (const sym of METALS_BASKET) {
    if (!result.has(sym)) {
      metals.push({ symbol: sym, isHeld: false, isEtf: true, assetClass: "metal" });
    }
  }

  // Region ETFs — appended for each non-US focus in profile.market_focus (max 3 per region)
  const regionEtfs: SymbolEntry[] = [];
  const seenAll = new Set([...result.keys(), ...metals.map(m => m.symbol)]);
  for (const region of focusRegions) {
    if (region === "US") continue;
    const basket = REGION_ETFS[region] ?? [];
    let added = 0;
    for (const sym of basket) {
      if (seenAll.has(sym) || added >= 3) continue;
      seenAll.add(sym);
      regionEtfs.push({ symbol: sym, isHeld: false, isEtf: true, assetClass: "etf" });
      added++;
    }
  }

  // India: when the user's focus includes India, add direct NSE stocks (from
  // the NIFTY list) scored via Yahoo — real Indian equities, not just US-listed
  // India ETFs. asset_class "india" so PaperTrader skips them (they're priced
  // in INR and must not enter the USD paper pool — India acts via Kite).
  const indiaSymbols: SymbolEntry[] = [];
  if (focusRegions.includes("India")) {
    for (const sym of niftyCandidates(8)) {
      if (seenAll.has(sym)) continue;
      seenAll.add(sym);
      indiaSymbols.push({ symbol: sym, isHeld: false, isEtf: false, assetClass: "india" });
    }
  }

  return [...nonMetals, ...metals, ...regionEtfs, ...indiaSymbols];
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
    const r = await fetch(
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${avKey}`,
      { next: { revalidate: 0 } }
    );
    const json = await r.json();
    return json?.Symbol ? (json as Record<string, string>) : {};
  } catch { return {}; }
}

// Fetch daily OHLCV candles from Alpha Vantage TIME_SERIES_DAILY_ADJUSTED (100 days compact)
// Used for deterministic RSI(14) / EMA(20,50) computation — no LLM involved
async function fetchAVCandles(symbol: string, avKey: string): Promise<Candle[]> {
  if (!avKey) return [];
  try {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=compact&apikey=${avKey}`,
      { next: { revalidate: 0 } }
    );
    const json = await r.json();
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

  return `${DOCTRINE_PREAMBLE}

You are a professional equity analyst. All quantitative scores for ${symbol} were pre-computed from real fetched market data (no LLM estimation). Your ONLY job: write a coherent investment thesis, assign direction, and identify specific key risks and catalysts grounded in the data below.${focusNote}

## Pre-computed scores (DO NOT override — derive thesis FROM them)
Fundamental: ${fundamental_score}/100 | ${fundLines || "data unavailable"}
Technical:   ${technical_score}/100 | ${techLines}
Sentiment:   ${sentiment_score}/100
Macro:       ${macro_score}/100 | regime: ${(evidence.macro as Record<string, unknown>).regime ?? "unknown"}
Insider:     ${insider_score}/100
Weighted analyst score: ${analystScore}/100 (threshold for trade: ${scoreThreshold})

${heldNote}

Return ONLY valid JSON (no markdown, no prose):
{"direction":"long","summary":"2-3 sentence thesis citing specific numbers from the data above","key_risks":["specific risk 1","specific risk 2"],"catalysts":["specific catalyst 1","specific catalyst 2"]}`;
}

// Process a single symbol: research → write research_packet + agent_signal
// Phase 0: all 5 scores computed deterministically. LLM writes thesis+direction only.
export async function processSymbol(
  entry: SymbolEntry,
  supabase: any
): Promise<{ symbol: string; analystScore: number; direction: string; conviction: number; source: string; tokensIn: number; tokensOut: number; currentPrice: number | null; priceTarget: number | null; stopLoss: number | null; scoreThreshold: number }> {
  const { symbol, isHeld, isEtf, assetClass = "us_equity" } = entry;
  const source: string = isHeld ? "holding" : "screener";
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";

  // India (.NS/.BO) uses Yahoo (free) for fundamentals + candles instead of
  // Alpha Vantage/FinancialDatasets, which are US-only. Social sentiment and
  // options/insider (US-only sources) are skipped for India → those dimensions
  // fall to their neutral baseline, which the score-detail panel flags honestly.
  const india = isIndia(symbol);

  // Phase 0: fetch all real data in parallel — no LLM-generated numbers
  const [socialResult, optionsResult, insiderResult, avOverview, candles] = await Promise.all([
    india ? Promise.resolve(null) : fetchSocialSentiment(symbol).catch(() => null),
    (india || isEtf) ? Promise.resolve(null) : fetchOptionsSignal(symbol).catch(() => null),
    (india || isEtf) ? Promise.resolve(null) : scoreInsider(symbol, avKey).catch(() => null),
    india ? fetchIndiaOverview(symbol).catch(() => ({})) : fetchAVOverview(symbol, avKey).catch(() => ({})),
    india ? fetchIndiaCandles(symbol).catch(() => [] as Candle[]) : fetchAVCandles(symbol, avKey).catch(() => [] as Candle[]),
  ]);

  // Compute all 5 scores deterministically from fetched data
  const scores = await computeScores({
    symbol, isEtf,
    avOverview: avOverview as Record<string, string>,
    candles,
    socialResult,
    insiderResult,
    supabase,
  });

  const market = india ? "india" : "us"; // Phase 4: per-market champion weights

  const [{ data: weights }, { data: strategy }, { data: profileData }, { data: scoreHistory }] = await Promise.all([
    supabase.from("signal_weights").select("*").single(),
    supabase.from("strategy_config").select("risk_profile, score_threshold, min_analyst_score, position_size_pct, stop_loss_pct, target_pct").single(),
    supabase.from("profiles").select("market_focus").limit(1).single(),
    // Recent score history for THIS symbol so the thesis prompt can reference the
    // trend (rising/falling conviction) rather than judging the symbol in isolation.
    supabase.from("signal_score_history").select("analyst_score, created_at").eq("symbol", symbol).order("created_at", { ascending: false }).limit(5),
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
    const scoped = await supabase.from("strategy_versions").select("weights_snapshot")
      .eq("is_champion", true).eq("market", market)
      .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (scoped.error) {
      const legacy = await supabase.from("strategy_versions").select("weights_snapshot")
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

  const fw = cw("fundamental", "fundamental_weight") ?? profileWeights.fundamental ?? weights?.fundamental_weight ?? 0.30;
  const tw = cw("technical",   "technical_weight")   ?? profileWeights.technical   ?? weights?.technical_weight  ?? 0.25;
  const sw = cw("sentiment",   "sentiment_weight")   ?? profileWeights.sentiment   ?? weights?.sentiment_weight  ?? 0.20;
  const mw = cw("macro",       "macro_weight")       ?? profileWeights.macro       ?? weights?.macro_weight      ?? 0.15;
  const iw = cw("insider",     "insider_weight")     ?? profileWeights.insider     ?? weights?.insider_weight    ?? 0.10;

  // Renormalize across only applicable + available dimensions instead of always
  // applying the fixed 5-way split against a fabricated neutral-50 default.
  // Two distinct reasons a dimension gets excluded:
  //  - INAPPLICABLE: fundamental/insider are structurally meaningless for ETFs
  //    (no company financials, no insiders) — scoreFundamentals/normalizeInsiderScore
  //    already return a flat baseline for these, not a real signal.
  //  - UNAVAILABLE: data fetch genuinely failed this run (e.g. macro rate-limited,
  //    no sentiment data) — scores.dataQuality flags these.
  // Below 2 included dimensions, renormalizing to 100% on one thin signal is
  // riskier than the old diluted-by-neutral-50 behavior, so fall back to the
  // fixed weights in that degenerate case.
  const dq = scores.dataQuality ?? ({} as any);
  const included: Record<string, boolean> = {
    fundamental: !isEtf && (dq.fundamentalDataAvailable ?? true),
    technical: (dq.technicalDataPoints ?? 0) > 0,
    sentiment: dq.sentimentDataAvailable ?? true,
    macro: dq.macroDataAvailable ?? true,
    insider: dq.insiderDataAvailable ?? true,
  };
  const weightOf: Record<string, number> = { fundamental: fw, technical: tw, sentiment: sw, macro: mw, insider: iw };
  const includedDims = Object.keys(included).filter(k => included[k]);
  let effWeights = weightOf;
  let renormalized = false;
  if (includedDims.length >= 2 && includedDims.length < 5) {
    const totalIncluded = includedDims.reduce((s, k) => s + weightOf[k], 0);
    effWeights = { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 };
    for (const k of includedDims) effWeights[k] = totalIncluded > 0 ? weightOf[k] / totalIncluded : 0;
    renormalized = true;
  }

  const analystScore = Math.round(
    scores.fundamental_score * effWeights.fundamental +
    scores.technical_score   * effWeights.technical +
    scores.sentiment_score   * effWeights.sentiment +
    scores.macro_score       * effWeights.macro +
    scores.insider_score     * effWeights.insider
  );

  const scoreThreshold = strategy?.score_threshold ?? strategy?.min_analyst_score ?? 60;
  const stopLossPct    = strategy?.stop_loss_pct ?? 7;
  const targetPct      = strategy?.target_pct    ?? 20;

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

  // LLM only writes thesis + direction — no score generation
  const thesisPrompt = buildThesisOnlyPrompt(symbol, isHeld, scores, analystScore, scoreThreshold, marketFocus) + trendNote;
  const llmResult = await callLLM({
    task: "screen",
    model: "llama-3.3-70b-versatile",
    prompt: thesisPrompt,
    symbol,
    agentLabel: "groq",
    maxTokens: 512,
  });

  const rawText = llmResult.text;
  const tokenUsage = { input: llmResult.tokensIn, output: llmResult.tokensOut };

  // Parse thesis response — LLM only returns { direction, summary, key_risks, catalysts }
  let thesis: { direction?: string; summary?: string; key_risks?: string[]; catalysts?: string[] } = {};
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) thesis = JSON.parse(match[0]);
  } catch { /* fallback to empty — scores are still written */ }

  const rawDirection: string = thesis.direction ?? (analystScore >= scoreThreshold ? "long" : "neutral");
  const signalDirection = !isHeld && rawDirection === "short" ? "neutral" : rawDirection;
  const directionNote   = rawDirection !== signalDirection ? ` [short→neutral: not a held position]` : "";

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
        _original_direction: rawDirection,
        _direction_override: rawDirection !== signalDirection,
        _data_quality: scores.dataQuality,
        _social_sentiment: socialResult ?? null,
        _options_signal:   optionsResult ?? null,
        _using_champion_weights: usingChampion,
      },
    })
    .select()
    .single();

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
    status: "pending",
    source,
    rationale: (thesis.summary ?? `Score: ${analystScore}/100`) + directionNote,
    // NOTE: no price_target / stop_loss here — those columns don't exist on
    // agent_signals (only stop_loss_pct / take_profit_pct do). Including them made
    // every PostgREST insert fail with PGRST204, and the undefined-column recovery
    // below only strips `market`, so the retry failed too and the signal was
    // silently dropped — zeroing out the whole pipeline. PaperTrader sets targets
    // at fill time from the real price anyway.
    asset_class:  assetClass,
    market, // Phase 4: routes the signal to its market's paper pool + champion
  };
  // Capture the inserted row's id (Research Journal needs this to join
  // decision_observations -> pipeline_stage_events -> trade_proposals ->
  // paper_trades by a shared signal_id, instead of null throughout).
  let insertedSignalId: string | null = null;
  {
    const { data, error } = await supabase.from("agent_signals").insert(signalRow).select("id").maybeSingle();
    // Strip `market` ONLY when the column is genuinely undefined (pre-057) — never
    // on a transient/constraint error, which would silently drop the market tag.
    const undefinedCol = error && (["42703", "PGRST204"].includes(String(error.code ?? "")) ||
      /column .* does not exist|could not find the '.*' column/i.test(String(error.message ?? "")));
    if (undefinedCol) {
      delete signalRow.market;
      const retry = await supabase.from("agent_signals").insert(signalRow).select("id").maybeSingle();
      insertedSignalId = retry.data?.id ?? null;
    } else if (error) {
      console.error("[research-agent] agent_signals insert failed:", error.message);
    } else {
      insertedSignalId = data?.id ?? null;
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
  try {
    const availability_mask = {
      fundamental: scores.dataQuality?.fundamentalDataAvailable ?? !(scores.evidence?.fundamental as any)?.note,
      technical:   (scores.dataQuality?.technicalDataPoints ?? 0) > 0,
      sentiment:   scores.dataQuality?.sentimentDataAvailable ?? !(scores.evidence?.sentiment as any)?.note,
      macro:       scores.dataQuality?.macroDataAvailable ?? !(scores.evidence?.macro as any)?.note,
      insider:     scores.dataQuality?.insiderDataAvailable ?? !(scores.evidence?.insider as any)?.note,
    };
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
    const { data: obsRow, error: obsErr } = await supabase.from("decision_observations").insert({
      market,
      symbol,
      strategy_version_id: null,            // filled when champion row id is loaded; else null
      weights_used: effWeights, // the ACTUALLY-APPLIED weights (post-renormalization), not the base profile split
      used_champion: usingChampion,
      features: {
        ...(scores.evidence ?? {}), regime, ...(screener ? { screener } : {}),
        weighting: { renormalized, included_dims: includedDims, base_weights: weightOf, applied_weights: effWeights },
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
    }).select("id").maybeSingle();
    if (obsErr && !/does not exist|could not find/i.test(obsErr.message ?? "")) {
      console.error("[research-agent] decision_observations insert failed:", obsErr.message);
    }

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
            ? `Score ${analystScore} >= threshold ${scoreThreshold ?? 60}`
            : `Score ${analystScore} < threshold ${scoreThreshold ?? 60}${signalDirection !== "long" ? ` (direction: ${signalDirection})` : ""}`,
          detail: { analyst_score: analystScore, score_threshold: scoreThreshold ?? 60, direction: signalDirection, screener },
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
          const sfw = cwShadow("fundamental", "fundamental_weight") ?? fw;
          const stw = cwShadow("technical", "technical_weight") ?? tw;
          const ssw = cwShadow("sentiment", "sentiment_weight") ?? sw;
          const smw = cwShadow("macro", "macro_weight") ?? mw;
          const siw = cwShadow("insider", "insider_weight") ?? iw;
          const shadowScore = Math.round(
            scores.fundamental_score * sfw + scores.technical_score * stw +
            scores.sentiment_score * ssw + scores.macro_score * smw + scores.insider_score * siw
          );
          await supabase.from("shadow_decisions").insert({
            market, symbol, observation_id: obsRow.id, policy_version_id: sv.id,
            would_enter: shadowScore >= (scoreThreshold ?? 60), score: shadowScore,
          });
        }
      } catch (e) { console.error("[research-agent] shadow decision write threw:", e); }
    }
  } catch (e) { console.error("[research-agent] observation write threw:", e); }

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
  };
}
