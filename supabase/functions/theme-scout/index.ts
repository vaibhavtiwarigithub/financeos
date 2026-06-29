/**
 * theme-scout — Supabase Edge Function
 *
 * Schedule: Every weekday at 14:30 UTC (9:30 AM ET, after market open)
 * Purpose:  Groq Llama reads AV news + top movers → identifies 2-3 market themes
 *           → adds matching stocks to watchlist with reason + 30-day expiry
 *
 * Runs entirely in Supabase cloud — no laptop needed.
 * Uses Groq free tier (llama-3.3-70b-versatile). No Anthropic API required.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_THEMES = 3;
const MAX_CANDIDATES = 2;
const EXPIRE_DAYS = 30;

function jsonOk(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
function jsonError(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });
}

async function fetchAVNews(avKey: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=20&sort=LATEST&apikey=${avKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return "";
    const data = await res.json();
    return (data.feed ?? []).slice(0, 15).map((a: any) => a.title).join("\n");
  } catch { return ""; }
}

async function fetchTopMovers(avKey: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${avKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return "";
    const data = await res.json();
    const gainers = (data.top_gainers ?? []).slice(0, 5).map((g: any) => `${g.ticker} +${g.change_percentage}`).join(", ");
    return `Top gainers today: ${gainers}`;
  } catch { return ""; }
}

async function fetchGroq(groqKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function fetchCandidatesFromAV(theme: string, avKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${encodeURIComponent(theme)}&limit=10&sort=RELEVANCE&apikey=${avKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const tickers = new Set<string>();
    for (const article of (data.feed ?? []).slice(0, 10)) {
      for (const ts of (article.ticker_sentiment ?? [])) {
        if (ts.relevance_score > 0.3 && ts.ticker_sentiment_score > 0.1) tickers.add(ts.ticker);
      }
    }
    return [...tickers].slice(0, MAX_CANDIDATES);
  } catch { return []; }
}

serve(async (req) => {
  // Auth: Bearer cron secret
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) return jsonError("Unauthorized", 401);

  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  const groqKey = Deno.env.get("GROQ_API_KEY") ?? "";
  if (!avKey || !groqKey) return jsonError("Missing API keys", 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const [news, movers] = await Promise.all([fetchAVNews(avKey), fetchTopMovers(avKey)]);
  if (!news) return jsonOk({ skipped: true, reason: "No news data" });

  const prompt = `You are a quantitative equity analyst. Based on today's market news and price movers, identify ${MAX_THEMES} distinct investable themes. For each theme, provide specific US-listed stock tickers (market cap > $2B, liquid).

Today's news headlines:
${news}

${movers}

Respond with ONLY valid JSON (no markdown):
{
  "themes": [
    {
      "theme": "Short theme name (3-5 words)",
      "rationale": "1 sentence why this theme matters now",
      "criteria": "What company type fits",
      "candidates": ["TICK1", "TICK2"]
    }
  ]
}

Rules: distinct themes, max ${MAX_CANDIDATES} candidates each, real US equity tickers only, no broad ETFs.`;

  let themes: any[] = [];
  try {
    const raw = await fetchGroq(groqKey, prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");
    themes = JSON.parse(match[0]).themes ?? [];
  } catch (e) {
    return jsonError(`LLM parse failed: ${e}`, 500);
  }

  // Enrich candidates with AV topic sentiment
  const expiry = new Date(Date.now() + EXPIRE_DAYS * 86400000).toISOString();
  const rows: any[] = [];

  for (const t of themes.slice(0, MAX_THEMES)) {
    const avCandidates = await fetchCandidatesFromAV(t.theme, avKey);
    const merged = [...new Set([...(t.candidates ?? []), ...avCandidates])].slice(0, MAX_CANDIDATES);
    for (const sym of merged) {
      const clean = sym.trim().toUpperCase();
      if (!clean || clean.length > 10) continue;
      rows.push({
        symbol: clean,
        source: "llm_theme",
        theme: t.theme,
        reason: `${t.rationale} — ${t.criteria}`,
        notes: `Auto-added by Theme Scout (edge fn). Theme: ${t.theme}`,
        auto_added: true,
        expires_at: expiry,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length) {
    await supabase.from("watchlist").upsert(rows, { onConflict: "user_id,symbol", ignoreDuplicates: false });
    await supabase.from("agent_alerts").insert({
      severity: "info",
      category: "watchlist",
      title: `Theme Scout: ${rows.length} stocks added`,
      detail: `Themes: ${themes.map((t: any) => t.theme).join(", ")} → ${rows.map((r: any) => r.symbol).join(", ")}`,
      auto_expire_at: new Date(Date.now() + 86400000).toISOString(),
    });
  }

  return jsonOk({ ok: true, themes, added: rows.length, symbols: rows.map((r: any) => r.symbol) });
});
