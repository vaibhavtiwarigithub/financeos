import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llm-router";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const PAIRS = [
  { bull: "TQQQ", bear: "SQQQ", label: "Nasdaq" },
  { bull: "SOXL", bear: "SOXS", label: "Semiconductors" },
  { bull: "SPXL", bear: "SPXS", label: "S&P 500" },
  { bull: "FAS",  bear: "FAZ",  label: "Financials" },
  { bull: "UGL",  bear: "GLL",  label: "Gold" },
];

const MACRO_TICKERS = ["SPY", "QQQ", "IWM", "SMH", "GLD", "USO", "VIX"];

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

  const hasData = quoteMap.size > 0;

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
    contextString = [
      "LEVERAGED PAIR SIGNALS:",
      ...pairLines,
      "",
      "MACRO OVERVIEW:",
      ...macroLines,
    ].join("\n");
  }

  // Route to DeepSeek: there is no ANTHROPIC_API_KEY, so a Claude-routed task
  // would fall back to the CLI subprocess and can fail → 500. DeepSeek works and
  // is fine for a market-summary. Wrap so an LLM failure never 500s the endpoint —
  // return the market data with a null thesis instead.
  let thesis = "";
  let model = "deepseek-chat";
  let llmError: string | null = null;
  try {
    const llmResult = await callLLM({
      task: "thesis",
      model: "deepseek-chat",
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
