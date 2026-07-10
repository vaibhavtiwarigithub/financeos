import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";
import { computeTechnicals, scoreTechnicals, Candle } from "../_shared/technicals.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const HOLDINGS_ACCOUNT = "965848641";

// ─── FinancialDatasets screener ───────────────────────────────────────────────

async function screenCandidates(fdKey: string): Promise<string[]> {
  if (!fdKey) return [];
  const headers = { "Content-Type": "application/json", "X-API-KEY": fdKey };

  const momentum = {
    filters: [
      { field: "revenue_growth", operator: "gt", value: 0.10 },
      { field: "earnings_growth", operator: "gt", value: 0 },
      { field: "market_cap", operator: "gt", value: 1_000_000_000 },
      { field: "pe_ratio", operator: "lt", value: 60 },
    ],
    limit: 8,
  };

  const value = {
    filters: [
      { field: "pe_ratio", operator: "gt", value: 0 },
      { field: "pe_ratio", operator: "lt", value: 20 },
      { field: "free_cash_flow_yield", operator: "gt", value: 0.03 },
      { field: "return_on_equity", operator: "gt", value: 0.15 },
      { field: "market_cap", operator: "gt", value: 500_000_000 },
    ],
    limit: 7,
  };

  try {
    const [mRes, vRes] = await Promise.all([
      fetch("https://api.financialdatasets.ai/stocks/screener/", {
        method: "POST", headers, body: JSON.stringify(momentum),
        signal: AbortSignal.timeout(12000),
      }).then(r => r.json()).catch(() => null),
      fetch("https://api.financialdatasets.ai/stocks/screener/", {
        method: "POST", headers, body: JSON.stringify(value),
        signal: AbortSignal.timeout(12000),
      }).then(r => r.json()).catch(() => null),
    ]);

    const mTickers: string[] = (mRes?.results ?? mRes?.data ?? []).map((s: any) => s.ticker ?? s.symbol).filter(Boolean);
    const vTickers: string[] = (vRes?.results ?? vRes?.data ?? []).map((s: any) => s.ticker ?? s.symbol).filter(Boolean);
    return [...new Set([...mTickers, ...vTickers])];
  } catch { return []; }
}

// ─── Data fetchers ───────────────────────────────────────────────────────────

async function fetchAVOverview(symbol: string, avKey: string): Promise<any> {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) });
    return await r.json();
  } catch { return {}; }
}

async function fetchAVCandles(symbol: string, avKey: string): Promise<Candle[]> {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=compact&apikey=${avKey}`, { signal: AbortSignal.timeout(12000) });
    const json = await r.json();
    const series = json?.["Time Series (Daily)"] ?? {};
    return Object.entries(series).map(([date, v]: [string, any]) => ({
      date,
      close: parseFloat(v["5. adjusted close"] ?? v["4. close"]),
      high: parseFloat(v["2. high"]),
      low: parseFloat(v["3. low"]),
      open: parseFloat(v["1. open"]),
      volume: parseInt(v["6. volume"] ?? "0"),
    })).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

async function fetchSocialSentiment(symbol: string, avKey: string): Promise<{ bullishPct: number; bearishPct: number; sentimentScore: number }> {
  const empty = { bullishPct: 50, bearishPct: 50, sentimentScore: 50 };
  try {
    const [stwits, avNews] = await Promise.all([
      fetch(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null),
      fetch(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbol}&limit=20&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null),
    ]);

    let stwitsScore = 50;
    if (stwits?.messages) {
      const msgs = stwits.messages.slice(0, 30);
      const bulls = msgs.filter((m: any) => m.entities?.sentiment?.basic === "Bullish").length;
      const bears = msgs.filter((m: any) => m.entities?.sentiment?.basic === "Bearish").length;
      const total = bulls + bears;
      if (total > 0) stwitsScore = (bulls / total) * 100;
    }

    let avScore = 50;
    if (avNews?.feed) {
      const relevantFeed = avNews.feed.filter((a: any) =>
        a.ticker_sentiment?.some((ts: any) => ts.ticker === symbol)
      );
      if (relevantFeed.length > 0) {
        const sentiments = relevantFeed.map((a: any) => {
          const ts = a.ticker_sentiment?.find((t: any) => t.ticker === symbol);
          return parseFloat(ts?.ticker_sentiment_score ?? "0");
        });
        const avg = sentiments.reduce((a: number, b: number) => a + b, 0) / sentiments.length;
        avScore = 50 + avg * 50;
      }
    }

    const combined = stwitsScore * 0.4 + avScore * 0.6;
    return { bullishPct: combined, bearishPct: 100 - combined, sentimentScore: Math.round(combined) };
  } catch { return empty; }
}

async function fetchInsider(symbol: string, avKey: string): Promise<{ netScore: number }> {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${symbol}&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) });
    const json = await r.json();
    const txns = json?.data ?? [];
    let buyVal = 0, sellVal = 0;
    for (const t of txns.slice(0, 20)) {
      const val = parseFloat(t.transaction_amount ?? "0");
      if (t.transaction_type === "P" || t.transaction_type === "A") buyVal += val;
      else if (t.transaction_type === "S" || t.transaction_type === "D") sellVal += val;
    }
    const total = buyVal + sellVal;
    return { netScore: total > 0 ? Math.round((buyVal / total) * 100) : 50 };
  } catch { return { netScore: 50 }; }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreFundamentals(overview: any, isEtf = false): number {
  if (isEtf) return 60;
  if (!overview?.Symbol) return 50;
  let score = 50;
  const pe = parseFloat(overview.PERatio ?? "0");
  if (pe > 0 && pe < 20) score += 15;
  else if (pe >= 20 && pe < 35) score += 8;
  else if (pe >= 35 && pe < 60) score -= 5;
  else if (pe >= 60) score -= 15;
  const margin = parseFloat(overview.ProfitMargin ?? "0");
  if (margin > 0.20) score += 15;
  else if (margin > 0.10) score += 8;
  else if (margin > 0) score += 3;
  else score -= 10;
  const roe = parseFloat(overview.ReturnOnEquityTTM ?? "0");
  if (roe > 0.20) score += 10;
  else if (roe > 0.10) score += 5;
  else if (roe < 0) score -= 10;
  const revGrowth = parseFloat(overview.QuarterlyRevenueGrowthYOY ?? "0");
  if (revGrowth > 0.20) score += 10;
  else if (revGrowth > 0.10) score += 5;
  else if (revGrowth < 0) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeScores(opts: {
  fundamentalScore: number; technicalScore: number;
  sentimentScore: number; macroScore: number; insiderScore: number;
}): number {
  const raw = opts.fundamentalScore * 0.25 + opts.technicalScore * 0.30 +
    opts.sentimentScore * 0.20 + opts.macroScore * 0.15 + opts.insiderScore * 0.10;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

async function fetchMacroScore(supabase: any): Promise<number> {
  try {
    const { data } = await supabase.from("macro_signals").select("danger_score")
      .order("generated_at", { ascending: false }).limit(1).single();
    if (data?.danger_score != null) return 100 - Number(data.danger_score);
  } catch {}
  return 60;
}

// ─── Thesis via Groq ─────────────────────────────────────────────────────────

const DOCTRINE_PREAMBLE = `§1 You are a REASONER, not a data source. Numbers are pre-computed. Your job: write direction, summary, risks, catalysts.
§2 Never generate prices, market caps, or percentages. They are already computed and passed to you.
§3 If asked for a number that wasn't given, say "not provided". Do not hallucinate.
§4 Output must be terse: 1-2 sentence summary, 2 risks, 1-2 catalysts.`;

async function buildThesis(opts: {
  symbol: string; overview: any;
  fundamentalScore: number; technicalScore: number; sentimentScore: number;
  macroScore: number; insiderScore: number; analystScore: number;
  technicals: ReturnType<typeof computeTechnicals>; groqKey: string;
}): Promise<{ direction: string; summary: string; risks: string[]; catalysts: string[] }> {
  const { symbol, overview, fundamentalScore, technicalScore, sentimentScore, macroScore, insiderScore, analystScore, technicals, groqKey } = opts;
  const isEtf = !overview.PERatio || overview.AssetType === "Exchange Traded Fund";
  const sector = overview.Sector ?? "Unknown";

  const prompt = `${DOCTRINE_PREAMBLE}

Symbol: ${symbol} | Sector: ${sector} | ETF: ${isEtf}
Composite Score: ${analystScore}/100
Components: fundamentals=${fundamentalScore} | technicals=${technicalScore} | sentiment=${sentimentScore} | macro=${macroScore} | insider=${insiderScore}
Technicals: RSI14=${technicals.rsi14 ?? "N/A"} trend20d=${technicals.trend20d ?? "N/A"} vsEMA50=${technicals.priceVsEma50 ?? "N/A"}
Company: ${(overview.Description ?? "").slice(0, 200)}

Reply JSON only: { "direction": "long"|"short"|"neutral", "summary": "...", "risks": ["...","..."], "catalysts": ["..."] }`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 400, temperature: 0.2 }),
      signal: AbortSignal.timeout(25000),
    });
    const json = await r.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    const cleaned = text.trim().replace(/^```json?\n?/, "").replace(/```$/, "");
    const parsed = JSON.parse(cleaned);
    return {
      direction: parsed.direction ?? "neutral",
      summary: parsed.summary ?? "",
      risks: parsed.risks ?? [],
      catalysts: parsed.catalysts ?? [],
    };
  } catch {
    return { direction: "neutral", summary: "Could not generate thesis", risks: [], catalysts: [] };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!CRON_SECRET || !auth.includes(CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  const groqKey = Deno.env.get("GROQ_API_KEY") ?? "";
  const fdKey = Deno.env.get("FINANCIALDATASETS_API_KEY") ?? "";
  if (!avKey || !groqKey) {
    return new Response(JSON.stringify({ error: "Missing ALPHA_VANTAGE_API_KEY or GROQ_API_KEY" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // ── Load Robinhood holdings from positions_json (correct schema) ───────────
  const { data: latestSnapshot } = await supabase
    .from("live_account_snapshots")
    .select("positions_json, equity, portfolio_value, captured_at")
    .eq("account_id", HOLDINGS_ACCOUNT)
    .order("captured_at", { ascending: false })
    .limit(1)
    .single();

  // positions_json is an array of position objects from robin_stocks
  const rawPositions: any[] = Array.isArray(latestSnapshot?.positions_json)
    ? latestSnapshot.positions_json
    : Object.values(latestSnapshot?.positions_json ?? {});

  const holdingSymbols = new Set(
    rawPositions.map((p: any) => (p.symbol ?? p.ticker ?? "")).filter(Boolean).map((s: string) => s.toUpperCase())
  );

  // ── Gather all symbols: holdings + watchlist + screener ───────────────────
  const [{ data: watchlist }, screenerSymbols] = await Promise.all([
    supabase.from("watchlist").select("symbol").limit(15),
    screenCandidates(fdKey),
  ]);

  const watchlistSymbols = (watchlist ?? []).map((w: any) => w.symbol as string);
  const allSymbols = [...new Set([...holdingSymbols, ...watchlistSymbols, ...screenerSymbols])].filter(Boolean);

  if (allSymbols.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, reason: "No symbols — watchlist empty, no holdings, screener returned 0" }), { headers: { "Content-Type": "application/json" } });
  }

  const macroScore = await fetchMacroScore(supabase);

  const processed: string[] = [];
  const errors: string[] = [];

  for (const symbol of allSymbols) {
    try {
      const isHolding = holdingSymbols.has(symbol);

      const [overview, candles, sentiment, insider] = await Promise.all([
        fetchAVOverview(symbol, avKey),
        fetchAVCandles(symbol, avKey),
        fetchSocialSentiment(symbol, avKey),
        fetchInsider(symbol, avKey),
      ]);

      const technicals = computeTechnicals(candles);
      const isEtf = !overview.PERatio || overview.AssetType === "Exchange Traded Fund";

      const fundamentalScore = scoreFundamentals(overview, isEtf);
      const technicalScore = scoreTechnicals(technicals);
      const sentimentScore = Math.max(0, Math.min(100, sentiment.sentimentScore));
      const insiderScore = insider.netScore;

      const analystScore = computeScores({ fundamentalScore, technicalScore, sentimentScore, macroScore, insiderScore });

      const thesis = await buildThesis({
        symbol, overview, fundamentalScore, technicalScore, sentimentScore,
        macroScore, insiderScore, analystScore, technicals, groqKey,
      });

      const now = new Date().toISOString();

      await supabase.from("agent_signals").insert({
        symbol,
        agent_label: "research",
        direction: thesis.direction,
        analyst_score: analystScore,
        summary: thesis.summary,
        risks: JSON.stringify(thesis.risks),
        catalysts: JSON.stringify(thesis.catalysts),
        is_holding: isHolding,
        fundamental_score: fundamentalScore,
        technical_score: technicalScore,
        sentiment_score: sentimentScore,
        macro_score: macroScore,
        insider_score: insiderScore,
        created_at: now,
      });

      // Write research packet using actual column names
      void supabase.from("research_packets").insert({
        symbol,
        summary: thesis.summary,
        fundamental_score: fundamentalScore,
        technical_score: technicalScore,
        macro_score: macroScore,
        insider_score: insiderScore,
        is_held_position: isHolding,
        agent_label: "research",
        catalysts: thesis.catalysts,
        key_risks: thesis.risks,
        raw_data: { rsi14: technicals.rsi14, trend20d: technicals.trend20d, analystScore, priceVsEma50: technicals.priceVsEma50 },
        created_at: now,
      });

      processed.push(symbol);
    } catch (e: any) {
      errors.push(`${symbol}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    processed,
    errors,
    macroScore,
    holdingsLoaded: holdingSymbols.size,
    snapshotAge: latestSnapshot?.captured_at ?? null,
  }), { headers: { "Content-Type": "application/json" } });
});
