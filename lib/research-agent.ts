import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

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
};

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

// Phase 1A — fetch current Robinhood holdings from Trading account
export async function fetchHoldings(): Promise<string[]> {
  const prompt = `Call the Robinhood MCP tool get_equity_positions with account_number: "${TRADING_ACCOUNT}"

From the response, extract the symbol from each position (the symbol field or ticker field inside each position object).
Return ONLY a JSON array of ticker strings (no markdown, no explanation):
["AAPL","NVDA","TSLA"]

If the tool fails or returns no positions, return: []`;

  try {
    const stdout = await execClaude(prompt, 60000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr: unknown[] = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 6)
      .map(s => s.toUpperCase());
  } catch {
    return [];
  }
}

// Phase 1C — dual-bucket screener: momentum + value
export async function runScreener(): Promise<string[]> {
  const prompt = `Run TWO stock screening passes using the FinancialDatasets screen_stocks tool.

Pass 1 — Momentum bucket (call screen_stocks):
filters:
- field: "revenue_growth", operator: "gt", value: 0.15
- field: "earnings_growth", operator: "gt", value: 0.10
- field: "gross_margin", operator: "gt", value: 0.25
- field: "return_on_equity", operator: "gt", value: 0.15
- field: "market_cap", operator: "gt", value: 2000000000
limit: 10

Pass 2 — Value bucket (call screen_stocks):
filters:
- field: "pe_ratio", operator: "gt", value: 0
- field: "pe_ratio", operator: "lt", value: 18
- field: "free_cash_flow_yield", operator: "gt", value: 0.04
- field: "debt_to_equity", operator: "lt", value: 1.0
- field: "market_cap", operator: "gt", value: 1000000000
limit: 10

After BOTH tool calls complete, combine unique symbols from both results.
Return ONLY a JSON array of stock ticker symbols (no ETFs, no REITs, no explanation):
["MSFT","GOOGL","JNJ"]

Max 6 symbols total. If both screens fail, return []`;

  try {
    const stdout = await execClaude(prompt, 90000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr: unknown[] = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 6)
      .slice(0, 6)
      .map(s => s.toUpperCase());
  } catch {
    return [];
  }
}

// Gather full symbol batch: holdings + watchlist + screener candidates
export async function gatherSymbols(
  supabase: any,
  manualOverride?: string[]
): Promise<SymbolEntry[]> {
  if (manualOverride && manualOverride.length > 0) {
    return manualOverride.map(s => ({
      symbol: s.toUpperCase(),
      isHeld: false,
      isEtf: isEtfSymbol(s),
    }));
  }

  const [holdings, watchlistResult, screenerSymbols] = await Promise.all([
    fetchHoldings(),
    supabase.from("watchlist").select("symbol"),
    runScreener(),
  ]);

  const watchlistSymbols: string[] =
    (watchlistResult.data ?? []).map((r: any) => String(r.symbol).toUpperCase());

  const result = new Map<string, SymbolEntry>();

  for (const sym of holdings) {
    result.set(sym, { symbol: sym, isHeld: true, isEtf: isEtfSymbol(sym) });
  }
  for (const sym of watchlistSymbols) {
    if (!result.has(sym)) {
      result.set(sym, { symbol: sym, isHeld: false, isEtf: isEtfSymbol(sym) });
    }
  }

  let screenerAdded = 0;
  for (const sym of screenerSymbols) {
    if (result.has(sym) || screenerAdded >= 3) continue;
    result.set(sym, { symbol: sym, isHeld: false, isEtf: false });
    screenerAdded++;
  }

  const cap = parseInt(process.env.RESEARCH_MAX_SYMBOLS ?? "10");
  return Array.from(result.values()).slice(0, cap);
}

function buildStockPrompt(symbol: string, isHeld: boolean): string {
  const heldNote = isHeld
    ? `\nIMPORTANT: This is a CURRENTLY HELD position. If analysis is bearish, set direction to "short" as an exit signal. Do NOT override to neutral.`
    : `\nNew candidate position. Only output direction "long" or "neutral" — never "short".`;

  return `You are a professional equity analyst. Research ${symbol} using these tools in order:

1. Call get_financial_metrics_snapshot (FinancialDatasets) for fundamentals: P/E, revenue growth, margins, FCF yield, ROE
2. Call RSI (Alpha Vantage) with symbol=${symbol}, interval=daily — check if RSI > 60 (momentum) or < 40 (oversold)
3. Call EMA (Alpha Vantage) with symbol=${symbol}, interval=daily, time_period=50 — compare to current price for trend direction
4. Call NEWS_SENTIMENT (Alpha Vantage) with tickers=${symbol} — get overall sentiment score and top 3 headlines
5. Call INSIDER_TRANSACTIONS (Alpha Vantage) with symbol=${symbol} — note recent insider buying or selling
6. Call get_earnings (FinancialDatasets) — last 2 quarters: beat or miss vs estimates?

After gathering data, synthesize all signals. Output ONLY a JSON object (no markdown, no prose):

{"symbol":"${symbol}","fundamental_score":75,"technical_score":70,"sentiment_score":72,"macro_score":65,"insider_score":60,"direction":"long","conviction":70,"summary":"2-3 sentence thesis citing actual numbers","key_risks":["specific risk 1","specific risk 2"],"catalysts":["specific catalyst 1","specific catalyst 2"]}

Scoring guide:
- fundamental_score: based on P/E vs sector, revenue growth, margins, FCF yield
- technical_score: based on RSI + price vs 50-day EMA
- sentiment_score: based on NEWS_SENTIMENT score (scale 0-1 → 0-100)
- macro_score: sector tailwinds, interest rate sensitivity, geopolitical exposure
- insider_score: 80+ if net buying, 20- if heavy selling, 50 if neutral
- conviction: your overall confidence 0-100
- direction must cite which signals drove it${heldNote}`;
}

function buildEtfPrompt(symbol: string, isHeld: boolean): string {
  const sym = symbol.toUpperCase();
  const isBear = LEVERAGED_BEAR_ETFS.has(sym);

  const directionNote = isBear
    ? `This is an INVERSE/BEAR ETF. direction="long" means underlying is BEARISH (bear ETF profits). direction="short" means underlying is BULLISH (bear ETF loses — exit signal if held).`
    : `direction="long" means underlying sector/index is bullish (hold/buy). direction="short" means bearish on underlying.`;

  const heldNote = isHeld
    ? `This is a CURRENTLY HELD position. If conclusion is bearish for this ETF (accounting for bear/bull direction above), set direction="short" as an exit signal.`
    : `Not currently held. Use direction "long" or "neutral" only.`;

  return `Analyze the ETF/fund ${symbol}.

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

// Process a single symbol: research → write research_packet + agent_signal
export async function processSymbol(
  entry: SymbolEntry,
  supabase: any
): Promise<{ symbol: string; analystScore: number; direction: string; conviction: number; source: string }> {
  const { symbol, isHeld, isEtf } = entry;
  const source: string = isHeld ? "holding" : "screener";

  const prompt = isEtf ? buildEtfPrompt(symbol, isHeld) : buildStockPrompt(symbol, isHeld);

  const stdout = await execClaude(prompt, 90000);
  const claudeRaw = parseClaudeOutput(stdout);
  const parsed = extractParsed(claudeRaw);
  if (!parsed) throw new Error(`JSON parse failed for ${symbol}. Raw: ${claudeRaw.slice(0, 200)}`);

  const rawDirection: string = parsed.direction ?? "neutral";
  const signalDirection = !isHeld && rawDirection === "short" ? "neutral" : rawDirection;
  const directionNote =
    rawDirection !== signalDirection ? ` [short→neutral override: not a held position]` : "";

  const { data: packet } = await supabase
    .from("research_packets")
    .insert({
      symbol: parsed.symbol ?? symbol,
      fundamental_score: parsed.fundamental_score,
      technical_score: parsed.technical_score,
      sentiment_score: parsed.sentiment_score,
      macro_score: parsed.macro_score,
      insider_score: parsed.insider_score,
      summary: parsed.summary,
      key_risks: parsed.key_risks,
      catalysts: parsed.catalysts,
      is_held_position: isHeld,
      raw_data: {
        ...parsed,
        _original_direction: rawDirection,
        _direction_override: rawDirection !== signalDirection,
      },
    })
    .select()
    .single();

  const { data: weights } = await supabase.from("signal_weights").select("*").single();
  const fw = weights?.fundamental_weight ?? 0.30;
  const tw = weights?.technical_weight  ?? 0.25;
  const sw = weights?.sentiment_weight  ?? 0.20;
  const mw = weights?.macro_weight      ?? 0.15;
  const iw = weights?.insider_weight    ?? 0.10;

  const analystScore = Math.round(
    (parsed.fundamental_score ?? 50) * fw +
    (parsed.technical_score   ?? 50) * tw +
    (parsed.sentiment_score   ?? 50) * sw +
    (parsed.macro_score       ?? 50) * mw +
    (parsed.insider_score     ?? 50) * iw
  );

  await supabase.from("agent_signals").insert({
    symbol: parsed.symbol ?? symbol,
    direction: signalDirection,
    analyst_score: analystScore,
    conviction: parsed.conviction,
    agent_type: "research",
    research_packet_id: packet?.id ?? null,
    status: "pending",
    source,
    rationale: (parsed.summary ?? "") + directionNote,
  });

  return {
    symbol: parsed.symbol ?? symbol,
    analystScore,
    direction: signalDirection,
    conviction: parsed.conviction ?? 50,
    source,
  };
}
