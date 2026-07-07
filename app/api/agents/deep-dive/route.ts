import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";
import { avCachedFetch } from "@/lib/av-cache";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

// Deep-Dive Debate — adversarial multi-agent analysis for one symbol.
// Analyst layer → Bull/Bear debate → Risk debate → Portfolio Manager verdict.
// Reasons over data we already have (live quote + our own signal scores + macro),
// so it burns no Alpha Vantage budget. On-demand only. Model is configurable
// from Settings -> Agents -> LLM Config (agent_config, agent_name="deep-dive")
// — defaults to deepseek-reasoner since there's no ANTHROPIC_API_KEY today.

async function fetchQuote(symbol: string): Promise<{ price: number; changePct: number; source: string } | null> {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(`https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json();
        const r = data.results?.[0];
        if (r && r.o) return { price: r.c, changePct: ((r.c - r.o) / r.o) * 100, source: "massive" };
      }
    } catch { /* fall through */ }
  }
  const svc = createServiceClient();
  const { data } = await svc.from("price_cache").select("close, open").eq("symbol", symbol).order("date", { ascending: false }).limit(1);
  const c = data?.[0] as any;
  if (c) return { price: Number(c.close), changePct: ((Number(c.close) - Number(c.open)) / Number(c.open)) * 100, source: "cache" };
  return null;
}

// Real fundamentals via Alpha Vantage OVERVIEW (1 call per deep-dive). AV free
// tier is 25/day; deep-dive is on-demand + low-frequency so this stays in budget.
// Grounds the debate in actual numbers instead of the model's training memory.
async function fetchFundamentals(symbol: string): Promise<string | null> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) return null;
  try {
    const d: any = await avCachedFetch(`OVERVIEW:${symbol}`, `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${avKey}`, 12_000);
    if (!d || !d.Symbol) return null; // rate-limited or unknown symbol
    const pick = (k: string) => d[k] && d[k] !== "None" ? d[k] : "n/a";
    return `sector=${pick("Sector")}, industry=${pick("Industry")}, PE=${pick("PERatio")}, PEG=${pick("PEGRatio")}, profitMargin=${pick("ProfitMargin")}, marketCap=${pick("MarketCapitalization")}, 52wHigh=${pick("52WeekHigh")}, 52wLow=${pick("52WeekLow")}, analystTarget=${pick("AnalystTargetPrice")}, EPS=${pick("EPS")}`;
  } catch { return null; }
}

interface Acc { tokensIn: number; tokensOut: number; costUsd: number; }
function tally(acc: Acc, r: { tokensIn: number; tokensOut: number; costUsd: number }) {
  acc.tokensIn += r.tokensIn; acc.tokensOut += r.tokensOut; acc.costUsd += r.costUsd;
}

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").toUpperCase().trim();
  // Canonical US ticker grammar (1-5 alnum + optional .X/-X class), so junk like
  // "AAPL/?x" can't reach the provider URL path.
  if (!/^[A-Z]{1,5}([.-][A-Z]{1,2})?$/.test(symbol)) return NextResponse.json({ error: "valid US ticker required" }, { status: 400 });

  if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "DEEPSEEK_API_KEY not set" }, { status: 503 });

  const svc = createServiceClient();
  if (!(await isAgentEnabled(svc, "deep-dive"))) {
    return NextResponse.json({ error: "deep-dive is disabled in Settings -> Agents -> LLM Config" }, { status: 200 });
  }
  const model = await getConfiguredModel(svc, "deep-dive");

  // ── Data bundle: quote + fundamentals + our signal scores + macro + holding ──
  const [quote, fundamentals, { data: sig }, { data: macro }, { data: pos }, { data: wl }] = await Promise.all([
    fetchQuote(symbol),
    fetchFundamentals(symbol),
    svc.from("agent_signals").select("direction, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, rationale, created_at").eq("symbol", symbol).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("macro_signals").select("regime, summary, created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("paper_positions").select("qty").eq("symbol", symbol).maybeSingle(),
    svc.from("watchlist_items").select("company_name").eq("symbol", symbol).limit(1).maybeSingle(),
  ]);

  const isHeld = !!pos && (pos as any).qty > 0;
  const companyName = (wl as any)?.company_name ?? symbol;
  const s = sig as any;

  const bundle = [
    `SYMBOL: ${symbol} (${companyName})`,
    quote ? `PRICE: $${quote.price?.toFixed(2)} (${quote.changePct >= 0 ? "+" : ""}${quote.changePct?.toFixed(2)}% last session, src=${quote.source})` : `PRICE: unavailable`,
    fundamentals ? `FUNDAMENTALS (Alpha Vantage): ${fundamentals}` : `FUNDAMENTALS: unavailable`,
    `HELD IN PAPER PORTFOLIO: ${isHeld ? "YES" : "NO"}`,
    s ? `PRIOR RESEARCH SIGNAL (${new Date(s.created_at).toISOString().slice(0,10)}): direction=${s.direction}, analyst_score=${s.analyst_score}/100 | dims: fundamental=${s.fundamental_score ?? "?"}, technical=${s.technical_score ?? "?"}, sentiment=${s.sentiment_score ?? "?"}, macro=${s.macro_score ?? "?"}, insider=${s.insider_score ?? "?"}\n  rationale: ${(s.rationale ?? "").slice(0, 400)}` : `PRIOR RESEARCH SIGNAL: none on record`,
    macro ? `MACRO REGIME: ${(macro as any).regime} — ${((macro as any).summary ?? "").slice(0, 300)}` : `MACRO REGIME: unknown`,
  ].join("\n");

  const acc: Acc = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const run = async (role: string, model: string, prompt: string, maxTokens = 550) => {
    const r = await callLLM({ task: "thesis", model, prompt, maxTokens, symbol, agentLabel: "deep-dive" });
    tally(acc, r);
    return r.text.trim();
  };

  const dataHeader = `MARKET DATA (reason ONLY from this; do not invent numbers):\n${bundle}\n\n`;

  try {
    // ── Analyst layer (parallel) ──────────────────────────────────────────────
    const [market, sentiment, fundamentals, macroReport] = await Promise.all([
      run("market", model, `${dataHeader}You are a MARKET/TECHNICAL analyst. In 4-6 sentences, assess ${symbol}'s price action, momentum, and technical posture from the data. State one bullish and one bearish technical point. Be concrete.`),
      run("sentiment", model, `${dataHeader}You are a SENTIMENT/NEWS analyst. In 4-6 sentences, assess the sentiment picture for ${symbol} from the signal scores and rationale. Note what would shift sentiment. If sentiment data is thin, say so.`),
      run("fundamentals", model, `${dataHeader}You are a FUNDAMENTALS analyst. In 4-6 sentences, assess ${symbol}'s fundamental case from the fundamental score and rationale. State the core bull thesis and the main fundamental risk.`),
      run("macro", model, `${dataHeader}You are a MACRO analyst. In 3-5 sentences, assess how the current macro regime affects ${symbol} specifically. Is the macro backdrop a tailwind or headwind for this name/sector?`),
    ]);

    const analystBlock = `ANALYST REPORTS:\n[MARKET/TECHNICAL]\n${market}\n\n[SENTIMENT]\n${sentiment}\n\n[FUNDAMENTALS]\n${fundamentals}\n\n[MACRO]\n${macroReport}\n\n`;

    // ── Research debate (parallel advocates) ──────────────────────────────────
    const [bull, bear] = await Promise.all([
      run("bull", model, `${dataHeader}${analystBlock}You are the BULL advocate. Build the strongest evidence-based case to BUY ${symbol}. 4-6 sentences. Cite the analyst reports. No hype — argue from the data.`),
      run("bear", model, `${dataHeader}${analystBlock}You are the BEAR advocate. Build the strongest evidence-based case to AVOID or SELL ${symbol}. 4-6 sentences. Cite the analyst reports. Focus on real risks, not generic caution.`),
    ]);

    const research_evaluator = await run("evaluator", model,
      `${dataHeader}${analystBlock}BULL CASE:\n${bull}\n\nBEAR CASE:\n${bear}\n\nYou are the RESEARCH EVALUATOR. Weigh both cases. Which is stronger and why? State a lean (Bullish / Bearish / Neutral) with the single most decisive factor. 4-6 sentences.`, 650);

    // ── Risk debate (one call, three perspectives) ────────────────────────────
    const risk = await run("risk", model,
      `${dataHeader}RESEARCH EVALUATION:\n${research_evaluator}\n\nYou are the RISK DESK. Give three brief perspectives on entering ${symbol} now:\n- RISKY (aggressive): why act now\n- SAFE (conservative): what could impair capital\n- NEUTRAL: the balanced staged approach\nThen one line: the key risk that must be watched. Keep each to 1-2 sentences.`, 650);

    // ── Portfolio Manager verdict ─────────────────────────────────────────────
    const longOnlyRule = isHeld
      ? `${symbol} IS currently held. Allowed verdicts: HOLD, SELL, or BUY (add).`
      : `${symbol} is NOT held. This is a LONG-ONLY system for new positions. Allowed verdicts: BUY or PASS (never SELL a name you don't own).`;

    const pm = await run("pm", model,
      `${dataHeader}RESEARCH EVALUATION:\n${research_evaluator}\n\nRISK DESK:\n${risk}\n\nYou are the PORTFOLIO MANAGER. Make the final call for ${symbol}.\n${longOnlyRule}\n\nWrite 4-6 sentences of rationale synthesizing the debate, then end with EXACTLY this line and nothing after:\nVERDICT: <BUY|HOLD|SELL|PASS> | CONVICTION: <integer 0-100>`, 700);

    // Parse verdict + conviction
    const vMatch = pm.match(/VERDICT:\s*(BUY|HOLD|SELL|PASS)/i);
    const cMatch = pm.match(/CONVICTION:\s*(\d{1,3})/i);
    let verdict = (vMatch?.[1] ?? "PASS").toUpperCase();
    let conviction = cMatch ? Math.min(100, Math.max(0, parseInt(cMatch[1]))) : 0;
    // Enforce long-only: never SELL an unheld name
    if (!isHeld && verdict === "SELL") verdict = "PASS";
    const summary = pm.replace(/VERDICT:[\s\S]*$/i, "").trim();

    const reports = { market, sentiment, fundamentals, macro: macroReport, bull, bear, research_evaluator, risk, portfolio_manager: pm };

    const { data: saved, error: saveErr } = await svc.from("deep_analyses").insert({
      symbol, verdict, conviction, summary, reports, model,
      tokens_in: acc.tokensIn, tokens_out: acc.tokensOut, cost_usd: Number(acc.costUsd.toFixed(5)),
    }).select("id, created_at").single();

    // Don't report success for an analysis that was never persisted.
    if (saveErr || !saved) {
      return NextResponse.json({ error: `Deep-dive save failed: ${saveErr?.message ?? "no row returned"}`, partialCost: Number(acc.costUsd.toFixed(5)) }, { status: 500 });
    }

    return NextResponse.json({
      id: (saved as any)?.id,
      symbol, verdict, conviction, summary, reports,
      isHeld, quote, priorSignal: s ? { analyst_score: s.analyst_score, direction: s.direction } : null,
      model, tokensIn: acc.tokensIn, tokensOut: acc.tokensOut, costUsd: Number(acc.costUsd.toFixed(5)),
      createdAt: (saved as any)?.created_at,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Deep-dive failed: ${e.message}`, partialCost: Number(acc.costUsd.toFixed(5)) }, { status: 500 });
  }
}

// GET latest stored analysis for a symbol
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("deep_analyses").select("*").eq("symbol", symbol).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ analysis: data ?? null });
}
