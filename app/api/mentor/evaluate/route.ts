import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execClaude, parseClaudeOutput, parseTokenUsage } from "@/lib/claude-exec";

export const dynamic = "force-dynamic";

const EVAL_PROMPT = (symbol: string, action: string, entryType: string, reasoning: string) => `
You are a professional investment analyst and trading coach. Evaluate this trade thesis rigorously.

SYMBOL: ${symbol}
ACTION: ${action.toUpperCase()} (${entryType === "post_trade" ? "already executed" : "considering buying/selling"})
ENTRY TYPE: ${entryType === "post_trade" ? "Post-trade justification (they already acted)" : "Pre-trade thesis (evaluating before acting)"}

USER REASONING:
"${reasoning}"

YOUR TASKS:
1. Use your available tools (FinancialDatasets, Alpha Vantage) to pull REAL current data on ${symbol}:
   - Current price, 52-week range, YTD return
   - P/E, revenue growth, EPS trend (last 4 quarters)
   - RSI, moving averages (50d/200d)
   - Recent news sentiment (last 30 days)

2. Verify each factual claim in the user's reasoning against real data.

3. Score overall reasoning quality 0-100 using this rubric:
   - Clarity & specificity (20pts): Specific, falsifiable claim with concrete triggers?
   - Factual accuracy (30pts): Facts match real data? Deduct 5pts per wrong claim.
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
  "verdict": <"strong" | "sound" | "mixed" | "flawed" | "emotional">,
  "bias_flags": [<bias names>],
  "what_is_right": "<specific things right, cite data>",
  "what_is_wrong": "<specific errors/gaps, cite data>",
  "bear_case": "<steelmanned bear thesis>",
  "suggestions": "<3 actionable improvements>",
  "data_used": "<key metrics pulled>",
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

interface EvalResult {
  score: number;
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

function parseEval(raw: string): EvalResult | null {
  const text = parseClaudeOutput(raw);
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

  const prompt = EVAL_PROMPT(symbol, action, entry_type, user_reasoning);

  let raw: string;
  try {
    raw = await execClaude(prompt, 120_000);
  } catch (e) {
    return NextResponse.json({ error: "AI evaluation failed", detail: String(e) }, { status: 500 });
  }

  const evaluation = parseEval(raw);
  const tokenUsage = parseTokenUsage(raw);

  if (!evaluation) {
    return NextResponse.json({ error: "Could not parse AI response", raw: parseClaudeOutput(raw).slice(0, 500) }, { status: 500 });
  }

  // Clamp score
  evaluation.score = Math.max(0, Math.min(100, Math.round(evaluation.score)));

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
    data_verified: { data_used: evaluation.data_used, tokens: tokenUsage },
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
  });
}
