// Theme Scout — weekly discovery job, independent of ResearchAgent.
// Cheap LLM (Groq Llama 3.3 free) reads market news → extracts 2-3 themes → screens stocks → adds to watchlist with reason.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { avCachedFetch } from "@/lib/av-cache";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchUsOverview } from "@/lib/data/fundamentals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY ?? "";
const MAX_THEME_STOCKS = 2;  // per theme
const MAX_THEMES = 3;
const EXPIRE_DAYS = 7;

// NOTE: Theme Scout is deliberately a PLAIN news-driven scout — it surfaces the
// day's news-implied themes only. It is NOT the alpha source and does NOT hardcode
// a thematic bet (an earlier curated AI/semis/energy "spine" was reverted). The
// durable discovery redesign — factor/edge screening + IC validation + a regime
// filter — is specced in features/edge-factor-discovery/FEATURE_ARCHITECTURE.md.

async function fetchAvMarketNews(): Promise<string> {
  if (!AV_KEY) return "";
  try {
    // Day-cached + budget-guarded (shared AV budget with research).
    const data = await avCachedFetch(
      "NEWS_LATEST",
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=20&sort=LATEST&apikey=${AV_KEY}`,
      10000
    );
    return ((data?.feed ?? []).slice(0, 15).map((a: any) => `${a.title} [${a.source}]`).join("\n")) || "";
  } catch { return ""; }
}

async function fetchMarketNews(): Promise<string> {
  try {
    const query = '("stock market" OR earnings OR acquisition OR regulation) sourcelang:english';
    const data = await providerCachedFetch(
      "gdelt",
      "THEME_SCOUT_MARKET_NEWS",
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=30&timespan=2d`,
      { timeoutMs: 10000, maxAgeDays: 1 },
    );
    const headlines = Array.isArray((data as any)?.articles)
      ? (data as any).articles
        .map((article: any) => String(article?.title ?? "").replace(/[\r\n]+/g, " ").slice(0, 240))
        .filter(Boolean)
        .slice(0, 20)
      : [];
    if (headlines.length > 0) return headlines.join("\n");
  } catch { /* AV is a bounded emergency reserve below */ }
  return fetchAvMarketNews();
}

async function fetchTopGainersLosers(): Promise<string> {
  if (!AV_KEY) return "";
  try {
    const data = await avCachedFetch(
      "TOP_GAINERS_LOSERS",
      `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${AV_KEY}`,
      10000
    );
    const gainers = (data?.top_gainers ?? []).slice(0, 5).map((g: any) => `${g.ticker} +${g.change_percentage}`).join(", ");
    return gainers ? `Top gainers: ${gainers}` : "";
  } catch { return ""; }
}

// NOTE: the previous AV-topics screen was removed. AV NEWS_SENTIMENT `topics=`
// only accepts a fixed enum (technology, earnings, ipo, …); passing a free-text
// theme name returned nothing useful while still spending ~3 AV calls/day. The
// LLM's own per-theme candidates are the real source and are still gated by the
// deterministic tickerExists() check below, so nothing of value was lost.

// Deterministic existence check — the LLM can hallucinate a plausible-looking
// ticker (wrong exchange, delisted, wrong company). Confirms the symbol
// resolves through the shared US fundamentals chain before it can enter the
// research universe; Alpha Vantage is only that chain's final reserve.
async function tickerExists(symbol: string): Promise<boolean> {
  try {
    // Use the same redundant resolver as research. Its provider caches prevent
    // duplicate network work when the symbol was already resolved recently.
    const resolved = await fetchUsOverview(symbol, async () => {
      if (!AV_KEY) return {};
      return avCachedFetch(
        `OVERVIEW:${symbol.toUpperCase()}`,
        `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`,
        8000,
      );
    });
    return resolved.source !== "unavailable"
      && typeof resolved.overview.Symbol === "string"
      && resolved.overview.Symbol.length > 0;
  } catch { return false; }
}

interface ThemeResult {
  theme: string;
  rationale: string;
  criteria: string;
  candidates: string[];
}

export async function POST(req: NextRequest) {
  // Cron OR owner. This was cron-secret-only, so the ▶ Run button on
  // /dashboard/agents — which posts from the browser with no cron secret
  // (AgentsPage.tsx sends Content-Type and nothing else) — 401'd on every click.
  // The documented way to run Theme Scout by hand had never worked. GET below was
  // already owner-gated; only POST was missing the same path.
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const supabase = createServiceClient();
  const news = await fetchMarketNews();
  // Movers are a final AV reserve only when neither GDELT nor AV news yielded
  // usable headlines. A normal scout run spends no AV call here.
  const movers = news ? "" : await fetchTopGainersLosers();

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
      task: "screen",
      prompt: themePrompt,
      // User-selectable in Settings → Agents → LLM Config (agent_name="theme-scout").
      // Default stays Groq llama (free) — the panel now controls it for real.
      model: await getConfiguredModel(supabase, "theme-scout", "llama-3.3-70b-versatile"),
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

  // Step 2: For each theme, confirm/expand candidates via AV news sentiment,
  // then require EVERY candidate — LLM-suggested or AV-mentioned — to pass a
  // deterministic existence check before it's trusted. Previously LLM
  // candidates were merged in unconditionally even when AV theme-relevance
  // confirmation came back empty (rate-limited/no feed), letting hallucinated
  // or non-existent tickers seed the research universe.
  const enriched: ThemeResult[] = [];
  const quarantined: string[] = [];
  for (const t of themes.slice(0, MAX_THEMES)) {
    const candidateSet = [...new Set(t.candidates)];
    const verified: string[] = [];
    for (const sym of candidateSet) {
      const clean = sym.trim().toUpperCase();
      if (!clean || clean.length > 10) continue;
      if (await tickerExists(clean)) verified.push(clean);
      else quarantined.push(clean);
    }
    enriched.push({ ...t, candidates: verified.slice(0, MAX_THEME_STOCKS) });
  }

  // Step 3: Upsert to watchlist, owned by the app's profile (single-user app —
  // matches the pattern research/cron and paper-trade use). Previously these
  // rows were inserted with no user_id at all while watchlist.user_id is a
  // not-null FK in the original schema — an owned row lets research/watchlist
  // read paths and the unique(user_id,symbol) constraint work as designed
  // instead of relying on incidental NULL-tolerant columns.
  const { data: ownerProfile } = await supabase.from("profiles").select("id").limit(1).maybeSingle();
  const ownerId = (ownerProfile as any)?.id ?? null;
  if (!ownerId) {
    await supabase.from("agent_alerts").insert({
      severity: "error",
      category: "watchlist",
      title: "Theme Scout: owner profile unavailable",
      detail: "No owner profile could be resolved, so Theme Scout refused to create unowned watchlist rows.",
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    return NextResponse.json({ error: "Owner profile unavailable; no watchlist rows written" }, { status: 500 });
  }

  const expiry = new Date(Date.now() + EXPIRE_DAYS * 24 * 3600 * 1000).toISOString();
  const rowsBySymbol = new Map<string, any>();

  for (const t of enriched) {
    for (const clean of t.candidates) {
      rowsBySymbol.set(clean, {
        user_id: ownerId,
        symbol: clean,
        source: "llm_theme",
        theme: t.theme,
        reason: `${t.rationale} — ${t.criteria}`,
        notes: `Auto-added by Theme Scout. Theme: ${t.theme}`,
        auto_added: true,
        expires_at: expiry,
        updated_at: new Date().toISOString(),
        // Tag the market EXPLICITLY rather than inheriting the column default.
        // Relying on the default is what produced capitalized 'US' rows that the
        // watchlist GET's lowercase filter couldn't match. This scout prompts for
        // and existence-checks US equities only (tickerExists → Alpha Vantage
        // OVERVIEW), so 'us' is correct; a .NS/.BO name would still classify
        // correctly if the prompt ever changes.
        market: /\.(NS|BO)$/i.test(clean) ? "india" : "us",
      });
    }
  }
  const candidateRows = [...rowsBySymbol.values()];
  const candidateSymbols = candidateRows.map((row) => row.symbol);
  const { data: existingRows } = candidateSymbols.length
    ? await supabase.from("watchlist").select("symbol, source").eq("user_id", ownerId).in("symbol", candidateSymbols)
    : { data: [] as any[] };
  const protectedSymbols = new Set(
    (existingRows ?? [])
      .filter((row: any) => row.source !== "llm_theme")
      .map((row: any) => String(row.symbol).toUpperCase()),
  );
  const rows = candidateRows.filter((row) => !protectedSymbols.has(row.symbol));

  // Keep historical invalid writes for audit, but expire them so nullable-owner
  // duplicates cannot keep expanding the active research universe.
  const cleanupAt = new Date().toISOString();
  await supabase.from("watchlist").update({ expires_at: cleanupAt })
    .eq("source", "llm_theme").is("user_id", null)
    .or(`expires_at.is.null,expires_at.gt.${cleanupAt}`);

  if (rows.length) {
    const { error: upsertErr } = await supabase.from("watchlist").upsert(rows, {
      onConflict: "user_id,symbol",
      ignoreDuplicates: false,
    });
    if (upsertErr) {
      console.error("[theme-scout] watchlist upsert failed:", upsertErr.message);
      await supabase.from("agent_alerts").insert({
        severity: "warning",
        category: "watchlist",
        title: "Theme Scout: watchlist write failed",
        detail: upsertErr.message,
        auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    }
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
    quarantined, // candidates the LLM/AV surfaced that failed the existence check — never inserted
  });
}

// GET: return last scout run summary
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("watchlist")
    .select("symbol, theme, reason, created_at, expires_at")
    .eq("source", "llm_theme")
    .order("created_at", { ascending: false })
    .limit(30);
  return NextResponse.json({ items: data ?? [] });
}
