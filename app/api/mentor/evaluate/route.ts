import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";
import { requireOwner } from "@/lib/auth/require-owner";
import { normaliseRubric } from "@/lib/mentor/rubric";

export const dynamic = "force-dynamic";

// This route declared NO maxDuration and inherited the platform default, which a
// reasoning call cannot finish inside. Measured 2026-09-02, a floored
// mentor-evaluate call took 94.8s end to end (deepseek-v4-pro, 16k budget,
// 3,913 output tokens). That run was verified on a LOCAL dev server, which has
// no function timeout — in production it would have been killed, so "verified
// working" locally proved the model, not the deployment.
export const maxDuration = 150;

/**
 * Budget for one evaluation.
 *
 * Was 2000 — under half the router's 4096 default — while `mentor-evaluate` is
 * assigned a REASONING model and this prompt demands a large JSON object (score,
 * verdict, biases, six dimensions, six observations, bear case, suggestions).
 * The model spent the entire budget on reasoning and returned empty content with
 * finish_reason=length, so every submission 500'd. One successful evaluation was
 * ever recorded, on 2026-07-12.
 *
 * Sized for reasoning PLUS the answer. The router also retries a truncated
 * reasoner once with headroom (isTruncatedReasoning), but relying on that would
 * pay for two calls on every single evaluation.
 */
const MENTOR_EVALUATE_MAX_TOKENS = 16000;

const EVAL_PROMPT = (symbol: string, action: string, entryType: string, reasoning: string) => `
You are a professional investment analyst and trading coach. Evaluate this trade thesis rigorously.

SYMBOL: ${symbol}
ACTION: ${action.toUpperCase()} (${entryType === "post_trade" ? "already executed" : "considering buying/selling"})
ENTRY TYPE: ${entryType === "post_trade" ? "Post-trade justification (they already acted)" : "Pre-trade thesis (evaluating before acting)"}

USER REASONING:
"${reasoning}"

YOUR TASKS:
1. You are evaluating from reasoning ALONE — you do NOT have live market-data tools in this pass. Do NOT invent specific figures (price, P/E, RSI, YTD return, moving averages). Where the user's claim depends on current data you cannot verify, treat it as UNVERIFIED and say so explicitly rather than fabricating a number.

2. Judge the internal logic, specificity, and falsifiability of each claim. Use your general knowledge of the company/sector only where it is reliable and not time-sensitive; flag anything time-sensitive as unverified.

3. Score overall reasoning quality 0-100 using this rubric. Return the per-category
   breakdown in "rubric" AND make "score" the exact sum of the "points_awarded"
   values — the breakdown is where the score comes from, not a decoration beside it:
   - Clarity & specificity (20pts): Specific, falsifiable claim with concrete triggers?
   - Plausibility & internal consistency (30pts): Are the claims coherent and consistent with well-known facts about the company/sector? Flag unverifiable time-sensitive claims but do NOT heavily penalize claims you simply cannot check.
   - Risk awareness (20pts): Bear case acknowledged?
   - Contrarian thinking (15pts): Crowded consensus or independent analysis?
   - Exit strategy (15pts): Know when they're wrong and what the exit is?

4. Score these 6 BEHAVIOR DIMENSIONS (each 0-100, honest assessment):
   - sector_awareness: Choosing the right sector/industry for current macro environment? Aware of sector rotation? Does this stock fit its sector's relative strength?
   - emotional_discipline: Evidence of FOMO, panic, revenge trading, or over-attachment? Or cool, systematic reasoning?
   - risk_management: Proper position sizing mentioned? Stop loss defined? Not over-concentrating? Acknowledges max loss?
   - thesis_quality: Entry catalyst clearly identified? Thesis is falsifiable and specific? Not vague? Based on data?
   - entry_timing: Entry at a logical technical level? Not chasing? Not too early? Understands the setup?
   - big_picture: Trading WITH the macro backdrop? Understands sector rotation, Fed policy, market regime? Not fighting the tape?

5. Identify cognitive biases (from: fomo, anchoring, recency_bias, confirmation_bias, herd_mentality, overconfidence, loss_aversion, narrative_fallacy)

6. Write one specific 1-sentence observation per dimension (what you noticed, good or bad)

7. Steelman the bear case (2-3 sentences against this thesis)

IMPORTANT: Return ONLY valid JSON, no markdown fences, no text before or after:
{
  "score": <integer 0-100>,
  "rubric": [
    {"category": "clarity_specificity",   "points_available": 20, "points_awarded": <0-20>, "finding": "<one sentence: what cost or earned the points>"},
    {"category": "plausibility",          "points_available": 30, "points_awarded": <0-30>, "finding": "<one sentence>"},
    {"category": "risk_awareness",        "points_available": 20, "points_awarded": <0-20>, "finding": "<one sentence>"},
    {"category": "contrarian_thinking",   "points_available": 15, "points_awarded": <0-15>, "finding": "<one sentence>"},
    {"category": "exit_strategy",         "points_available": 15, "points_awarded": <0-15>, "finding": "<one sentence>"}
  ],
  "verdict": <"strong" | "sound" | "mixed" | "flawed" | "emotional">,
  "bias_flags": [<bias names>],
  "what_is_right": "<specific things right, cite data>",
  "what_is_wrong": "<specific errors/gaps, cite data>",
  "bear_case": "<steelmanned bear thesis>",
  "suggestions": "<3 actionable improvements>",
  "data_used": "<what you could NOT verify without market data — name the unverified claims, do not invent figures>",
  "dimensions": {
    "sector_awareness": <0-100>,
    "emotional_discipline": <0-100>,
    "risk_management": <0-100>,
    "thesis_quality": <0-100>,
    "entry_timing": <0-100>,
    "big_picture": <0-100>
  },
  "dimension_observations": {
    "sector_awareness": "<1 sentence observation>",
    "emotional_discipline": "<1 sentence observation>",
    "risk_management": "<1 sentence observation>",
    "thesis_quality": "<1 sentence observation>",
    "entry_timing": "<1 sentence observation>",
    "big_picture": "<1 sentence observation>"
  }
}
`.trim();

interface DimensionScores {
  sector_awareness: number;
  emotional_discipline: number;
  risk_management: number;
  thesis_quality: number;
  entry_timing: number;
  big_picture: number;
}

export interface RubricLine {
  category: string;
  points_available: number;
  points_awarded: number;
  finding: string;
}

interface EvalResult {
  score: number;
  rubric?: RubricLine[];
  rubric_normalised?: ReturnType<typeof normaliseRubric>;
  verdict: string;
  bias_flags: string[];
  what_is_right: string;
  what_is_wrong: string;
  bear_case: string;
  suggestions: string;
  data_used: string;
  dimensions?: DimensionScores;
  dimension_observations?: Record<string, string>;
}

function clampDimension(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "50"), 10);
  return Math.max(0, Math.min(100, isNaN(n) ? 50 : Math.round(n)));
}

function parseEval(text: string): EvalResult | null {
  // Strip markdown fences if present
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/gi, "").trim();
  // Find first { ... } block
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as EvalResult;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const symbol: string = (body.symbol ?? "").toUpperCase().trim();
  const action: string = body.action ?? "buy";
  const entry_type: string = body.entry_type ?? "pre_trade_thesis";
  const user_reasoning: string = (body.user_reasoning ?? "").trim();

  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (user_reasoning.length < 50) return NextResponse.json({ error: "reasoning too short (min 50 chars)" }, { status: 400 });

  const cfgSvc = createServiceClient();

  // Ground the evaluation in our own system's latest view on the symbol.
  const [{ data: pkt }, { data: sig }] = await Promise.all([
    cfgSvc.from("research_packets").select("summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, created_at").eq("symbol", symbol).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    cfgSvc.from("agent_signals").select("direction, analyst_score, rationale, status, created_at").eq("symbol", symbol).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  let agentContext = "";
  if (pkt || sig) {
    agentContext = "\n\n=== OUR SYSTEM'S OWN VIEW ON " + symbol + " (for you to compare the user's thesis against) ===\n";
    if (pkt) agentContext += `ResearchAgent: ${(pkt as any).summary ?? "n/a"} | risks: ${(pkt as any).key_risks ?? "n/a"} | scores fundamental:${(pkt as any).fundamental_score} technical:${(pkt as any).technical_score} sentiment:${(pkt as any).sentiment_score} macro:${(pkt as any).macro_score}\n`;
    if (sig) agentContext += `Latest signal: ${(sig as any).direction?.toUpperCase()} score ${(sig as any).analyst_score} (${(sig as any).status}) — ${(sig as any).rationale ?? ""}\n`;
    agentContext += "If the user's thesis contradicts or ignores this, say so explicitly in your evaluation.";
  }

  const prompt = EVAL_PROMPT(symbol, action, entry_type, user_reasoning) + agentContext;

  let raw: string;
  let tokenUsage = { input: 0, output: 0 };
  let usedModel = "deepseek-reasoner";
  try {
    // Production LLM path (was execClaude → PowerShell, which ENOENTs on Vercel).
    const res = await callLLM({ task: "evaluate", prompt, agentLabel: "mentor-evaluate", model: await getConfiguredModel(cfgSvc, "mentor-evaluate", "deepseek-reasoner"), symbol, maxTokens: MENTOR_EVALUATE_MAX_TOKENS });
    raw = res.text;
    usedModel = res.model;
    tokenUsage = { input: res.tokensIn, output: res.tokensOut };
  } catch (e) {
    // Record the FAILURE too. Previously only successes wrote an agent_runs row,
    // so a flow that had been broken since 2026-07-12 looked simply unused —
    // there was nothing to distinguish "nobody submitted" from "every submission
    // 500'd". Best-effort: never let logging mask the original error.
    try {
      await cfgSvc.from("agent_runs").insert({
        agent_type: "mentor_evaluate",
        status: "failed",
        trigger_source: "manual",
        symbols: [symbol],
        result_summary: `Evaluation FAILED for ${symbol} ${action}`,
        error: String(e).slice(0, 500),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      } as any);
    } catch { /* logging must not mask the real failure */ }
    return NextResponse.json({ error: "AI evaluation failed", detail: String(e) }, { status: 500 });
  }

  const evaluation = parseEval(raw);

  if (!evaluation) {
    return NextResponse.json({ error: "Could not parse AI response", raw: raw.slice(0, 500) }, { status: 500 });
  }

  // The rubric breakdown IS the score. A model asked for both a total and its
  // parts can return parts that do not add up, and showing the total beside a
  // contradicting breakdown puts an unauditable number next to its own
  // refutation — so the sum wins and the gap is reported.
  const rubric = normaliseRubric(evaluation.rubric, evaluation.score);
  evaluation.score = Math.max(0, Math.min(100, rubric.total));
  evaluation.rubric_normalised = rubric;

  // Save to trade_journal
  const svc = createServiceClient();
  const { data: entry, error: dbErr } = await svc.from("trade_journal").insert({
    user_id: session.user.id,
    symbol,
    action,
    entry_type,
    user_reasoning,
    ai_evaluation: [
      evaluation.what_is_right ? `✓ What's right: ${evaluation.what_is_right}` : "",
      evaluation.what_is_wrong ? `✗ What's wrong: ${evaluation.what_is_wrong}` : "",
      evaluation.bear_case ? `Bear case: ${evaluation.bear_case}` : "",
    ].filter(Boolean).join("\n\n"),
    ai_score: evaluation.score,
    verdict: evaluation.verdict,
    bias_flags: evaluation.bias_flags ?? [],
    suggestions: evaluation.suggestions,
    data_verified: {
      data_used: evaluation.data_used,
      tokens: tokenUsage,
      rubric: rubric.lines,
      score_discrepancy: rubric.discrepancy,
    },
    evaluated_at: new Date().toISOString(),
  } as any).select().single();

  if (dbErr) console.error("[evaluate] DB error:", dbErr.message);

  // Save dimension scores if present
  if (evaluation.dimensions && (entry as any)?.id) {
    const dim = evaluation.dimensions;
    const obs = evaluation.dimension_observations ?? {};
    await svc.from("mentor_dimension_logs").insert({
      journal_entry_id: (entry as any).id,
      trade_symbol: symbol,
      evaluated_at: new Date().toISOString().slice(0, 10),
      sector_awareness:     clampDimension(dim.sector_awareness),
      emotional_discipline: clampDimension(dim.emotional_discipline),
      risk_management:      clampDimension(dim.risk_management),
      thesis_quality:       clampDimension(dim.thesis_quality),
      entry_timing:         clampDimension(dim.entry_timing),
      big_picture:          clampDimension(dim.big_picture),
      observations: obs,
    } as any);
  }

  // Track token usage in agent_runs
  await svc.from("agent_runs").insert({
    agent_type: "mentor_evaluate",
    status: "completed",
    trigger_source: "manual",
    symbols: [symbol],
    result_summary: `Evaluated ${symbol} ${action} thesis — score ${evaluation.score}/100`,
    tokens_input: tokenUsage.input,
    tokens_output: tokenUsage.output,
    claude_calls: 1,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  } as any);

  return NextResponse.json({
    ok: true,
    evaluation,
    entry_id: (entry as any)?.id ?? null,
    meta: { agent: "Judgment Coach", agentKind: "grounded", model: usedModel },
  });
}
