import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llm-router";
import { createServiceClient } from "@/lib/supabase/service";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";
import type { MarketOverview } from "@/app/api/markets/overview/route";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

const PAIRS = [
  { bull: "TQQQ", bear: "SQQQ", label: "Nasdaq" },
  { bull: "SOXL", bear: "SOXS", label: "Semiconductors" },
  { bull: "SPXL", bear: "SPXS", label: "S&P 500" },
  { bull: "FAS",  bear: "FAZ",  label: "Financials" },
  { bull: "UGL",  bear: "GLL",  label: "Gold" },
];

const MACRO_TICKERS = ["SPY", "QQQ", "IWM", "SMH", "GLD", "USO", "VIX"];

// Fetch the same indices/sector data that the Market Snapshot cards render on
// this page (via /api/markets/overview), so the thesis is grounded in the
// exact real, current numbers the user sees above it — not a separate,
// independently-fetched (and often empty) leveraged-ETF context.
async function fetchOverviewContext(origin: string): Promise<MarketOverview | null> {
  try {
    const res = await fetch(`${origin}/api/markets/overview`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as MarketOverview;
    if (!json.indices?.length && !json.sectors?.length) return null;
    return json;
  } catch {
    return null;
  }
}

interface QuoteResult {
  symbol: string;
  close: number;
  open: number;
  changePct: number;
}

async function fetchQuote(symbol: string, apiKey: string | undefined): Promise<QuoteResult | null> {
  if (apiKey) {
    try {
      const res = await fetch(
        `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`,
        { headers: { Accept: "application/json" } }
      );
      if (res.ok) {
        const data = await res.json();
        const r = data.results?.[0];
        if (r && r.o && r.c) {
          return {
            symbol,
            close: r.c,
            open: r.o,
            changePct: ((r.c - r.o) / r.o) * 100,
          };
        }
      }
    } catch {
      // fall through
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const force = req.nextUrl.searchParams.get("force") === "true";
  const today = new Date().toISOString().slice(0, 10);
  const svc = createServiceClient();

  // Return cached thesis unless force=true
  if (!force) {
    const { data: cached } = await svc
      .from("briefings")
      .select("content, created_at")
      .eq("date", today)
      .eq("session", "thesis")
      .maybeSingle();

    if (cached) {
      return NextResponse.json({
        thesis: cached.content,
        pairs: [],
        macro: [],
        generatedAt: cached.created_at,
        cached: true,
      });
    }
  }

  const apiKey = process.env.MASSIVE_API_KEY;

  // Fetch all tickers
  const allTickers = [
    ...PAIRS.flatMap(p => [p.bull, p.bear]),
    ...MACRO_TICKERS,
  ];
  const rawResults = await Promise.allSettled(
    allTickers.map(sym => fetchQuote(sym, apiKey))
  );
  const quoteMap = new Map<string, QuoteResult>();
  allTickers.forEach((sym, i) => {
    const r = rawResults[i];
    if (r.status === "fulfilled" && r.value) quoteMap.set(sym, r.value);
  });

  // The real, current index + sector data — same source as the Market
  // Snapshot cards rendered on this page. This is the primary grounding for
  // the thesis; the leveraged-pair signals below are supplementary color.
  const overview = await fetchOverviewContext(req.nextUrl.origin);

  const hasData = quoteMap.size > 0 || !!overview;

  // Build pair results
  const pairResults = PAIRS.map(p => {
    const bull = quoteMap.get(p.bull);
    const bear = quoteMap.get(p.bear);
    let direction: "BULL" | "BEAR" | "MIXED" = "MIXED";
    if (bull && bear) {
      if (bull.changePct > 0 && bull.changePct > bear.changePct) direction = "BULL";
      else if (bear.changePct > 0 && bear.changePct > bull.changePct) direction = "BEAR";
    }
    return {
      label: p.label,
      bull: { symbol: p.bull, changePct: bull?.changePct ?? null },
      bear: { symbol: p.bear, changePct: bear?.changePct ?? null },
      direction,
    };
  });

  // Build macro results
  const macroResults = MACRO_TICKERS.map(sym => {
    const q = quoteMap.get(sym);
    return { symbol: sym, price: q?.close ?? null, changePct: q?.changePct ?? null };
  });

  // Build context string for LLM
  let contextString = "";
  if (!hasData) {
    contextString = "Market data unavailable for this session.";
  } else {
    const sections: string[] = [];

    if (overview) {
      const indexLines = overview.indices.map(
        (i) => `${i.symbol} (${i.name}): $${i.price.toFixed(2)} (${i.changePct >= 0 ? "+" : ""}${i.changePct.toFixed(2)}%)`
      );
      const sectorLines = [...overview.sectors]
        .sort((a, b) => b.changePct - a.changePct)
        .map((s) => `${s.symbol} (${s.name}): ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`);
      sections.push("REAL-TIME INDICES (today's session):", ...indexLines);
      sections.push("", "SECTOR PERFORMANCE (today's session, best to worst):", ...sectorLines);
    }

    const pairLines = pairResults.map(p => {
      const bullStr = p.bull.changePct !== null ? `${p.bull.changePct >= 0 ? "+" : ""}${p.bull.changePct.toFixed(2)}%` : "N/A";
      const bearStr = p.bear.changePct !== null ? `${p.bear.changePct >= 0 ? "+" : ""}${p.bear.changePct.toFixed(2)}%` : "N/A";
      return `${p.label}: ${p.bull.symbol} ${bullStr} vs ${p.bear.symbol} ${bearStr} → [${p.direction}]`;
    });
    const macroLines = macroResults.map(m => {
      if (m.price === null) return `${m.symbol}: N/A`;
      const pctStr = m.changePct !== null ? ` (${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%)` : "";
      return `${m.symbol}: $${m.price.toFixed(2)}${pctStr}`;
    });
    sections.push("", "LEVERAGED PAIR SIGNALS:", ...pairLines);
    sections.push("", "ADDITIONAL MACRO TICKERS:", ...macroLines);

    contextString = sections.join("\n");
  }

  // Model is configurable from Settings -> Agents -> LLM Config
  // (agent_config, agent_name="markets-thesis") — defaults to deepseek-reasoner
  // since there's no ANTHROPIC_API_KEY today. Wrap so an LLM failure never
  // 500s the endpoint — return the market data with a null thesis instead.
  let thesis = "";
  let model = await getConfiguredModel(svc, "markets-thesis");
  let llmError: string | null = null;
  const thesisEnabled = await isAgentEnabled(svc, "markets-thesis");
  try {
    if (!thesisEnabled) throw new Error("markets-thesis is disabled in Settings -> Agents -> LLM Config");
    const llmResult = await callLLM({
      task: "thesis",
      model,
      prompt: `You are a macro analyst. Based on the following real market data from the most recent session, write a concise market thesis.

MARKET DATA:
${contextString}

Write:
**1-DAY THESIS** (2-3 sentences): What the data says about today's session momentum and what to watch.
**1-WEEK THESIS** (2-3 sentences): The dominant trend and what would confirm or refute it.
**NEXT SESSION PREDICTION** (1-2 sentences): Most likely scenario for the next trading day based on current momentum. State it as a directional call with the key risk.

Base everything on the data above. No invented events or data. Be specific about which sectors/assets are showing strength or weakness.`,
      maxTokens: 400,
    });
    thesis = llmResult.text;
    model = llmResult.model;
  } catch (e) {
    llmError = String(e);
  }

  const generatedAt = new Date().toISOString();

  // Cache only a real thesis (never cache an error placeholder for the day).
  if (thesis) {
    await svc.from("briefings").upsert(
      { date: today, session: "thesis", content: thesis, model },
      { onConflict: "date,session" }
    );
  }

  return NextResponse.json({
    thesis: thesis || null,
    pairs: pairResults,
    macro: macroResults,
    generatedAt,
    cached: false,
    dataAvailable: hasData,
    error: llmError ? "Thesis generation failed — market data shown below." : undefined,
  });
}
