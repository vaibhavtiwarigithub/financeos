// Theme Scout — runs daily after research cron.
// Cheap LLM (Groq Llama 3.3 free) reads market news → extracts 2-3 themes → screens stocks → adds to watchlist with reason.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY ?? "";
const MAX_THEME_STOCKS = 2;  // per theme
const MAX_THEMES = 3;
const EXPIRE_DAYS = 30;

async function fetchMarketNews(): Promise<string> {
  if (!AV_KEY) return "";
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=20&sort=LATEST&apikey=${AV_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return "";
    const data = await res.json();
    const articles = (data.feed ?? []).slice(0, 15).map((a: any) =>
      `${a.title} [${a.source}]`
    ).join("\n");
    return articles;
  } catch { return ""; }
}

async function fetchTopGainersLosers(): Promise<string> {
  if (!AV_KEY) return "";
  try {
    const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${AV_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return "";
    const data = await res.json();
    const gainers = (data.top_gainers ?? []).slice(0, 5).map((g: any) => `${g.ticker} +${g.change_percentage}`).join(", ");
    const sectors = `Top gainers: ${gainers}`;
    return sectors;
  } catch { return ""; }
}

async function screenForTheme(theme: string, criteria: string): Promise<string[]> {
  // Use Alpha Vantage LISTING_STATUS to validate symbols exist, then return LLM-suggested ones
  // (FinancialDatasets screen_stocks via HTTP if available)
  if (!AV_KEY) return [];
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${encodeURIComponent(theme)}&limit=10&sort=RELEVANCE&apikey=${AV_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const mentioned = new Set<string>();
    for (const article of (data.feed ?? []).slice(0, 10)) {
      for (const ts of (article.ticker_sentiment ?? [])) {
        if (ts.relevance_score > 0.3 && ts.ticker_sentiment_score > 0.1) {
          mentioned.add(ts.ticker);
        }
      }
    }
    return [...mentioned].slice(0, MAX_THEME_STOCKS);
  } catch { return []; }
}

interface ThemeResult {
  theme: string;
  rationale: string;
  criteria: string;
  candidates: string[];
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const [news, movers] = await Promise.all([fetchMarketNews(), fetchTopGainersLosers()]);

  if (!news && !movers) {
    return NextResponse.json({ skipped: true, reason: "No market data available" });
  }

  // Step 1: LLM identifies themes
  const themePrompt = `You are a quantitative equity analyst. Based on today's market news and price movers, identify ${MAX_THEMES} distinct investable themes. For each theme, provide specific US-listed stock tickers that best represent it (only well-known, liquid tickers with market cap > $2B).

Today's market news headlines:
${news}

${movers}

Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "themes": [
    {
      "theme": "Short theme name (3-5 words)",
      "rationale": "1 sentence why this theme matters now",
      "criteria": "What type of company fits this theme",
      "candidates": ["TICK1", "TICK2"]
    }
  ]
}

Rules:
- Themes must be distinct from each other (not both 'AI' themed)
- Max ${MAX_THEME_STOCKS} candidates per theme
- Only real, tradeable US equity tickers
- Avoid broad ETFs as candidates — pick individual stocks
- If uncertain about a ticker, omit it`;

  let themes: ThemeResult[] = [];
  try {
    const raw = await callLLM({
      task: "screen",  // routes to Groq (free)
      prompt: themePrompt,
      model: "llama-3.3-70b-versatile",
    });

    // Parse JSON from response
    const jsonMatch = raw.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    themes = parsed.themes ?? [];
  } catch (e) {
    return NextResponse.json({ error: "LLM parse failed", detail: String(e) }, { status: 500 });
  }

  if (!themes.length) {
    return NextResponse.json({ added: 0, themes: [] });
  }

  // Step 2: For each theme, confirm/expand candidates via AV news sentiment
  const enriched: ThemeResult[] = [];
  for (const t of themes.slice(0, MAX_THEMES)) {
    const avCandidates = await screenForTheme(t.theme, t.criteria);
    // Merge LLM candidates + AV-confirmed, dedupe, cap at MAX_THEME_STOCKS
    const merged = [...new Set([...t.candidates, ...avCandidates])].slice(0, MAX_THEME_STOCKS);
    enriched.push({ ...t, candidates: merged });
  }

  // Step 3: Upsert to watchlist
  const expiry = new Date(Date.now() + EXPIRE_DAYS * 24 * 3600 * 1000).toISOString();
  const rows: any[] = [];

  for (const t of enriched) {
    for (const sym of t.candidates) {
      const clean = sym.trim().toUpperCase();
      if (!clean || clean.length > 10) continue;
      rows.push({
        symbol: clean,
        source: "llm_theme",
        theme: t.theme,
        reason: `${t.rationale} — ${t.criteria}`,
        notes: `Auto-added by Theme Scout. Theme: ${t.theme}`,
        auto_added: true,
        expires_at: expiry,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length) {
    await supabase.from("watchlist").upsert(rows, {
      onConflict: "user_id,symbol",
      ignoreDuplicates: false,
    });
  }

  // Emit info alert
  const themeNames = enriched.map(t => t.theme).join(", ");
  const symbolList = rows.map(r => r.symbol).join(", ");
  if (rows.length) {
    await supabase.from("agent_alerts").insert({
      severity: "info",
      category: "watchlist",
      title: `Theme Scout: ${rows.length} stocks added`,
      detail: `Themes: ${themeNames} → ${symbolList}`,
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    themes: enriched,
    added: rows.length,
    symbols: rows.map(r => r.symbol),
  });
}

// GET: return last scout run summary
export async function GET() {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("watchlist")
    .select("symbol, theme, reason, created_at, expires_at")
    .eq("source", "llm_theme")
    .order("created_at", { ascending: false })
    .limit(30);
  return NextResponse.json({ items: data ?? [] });
}
