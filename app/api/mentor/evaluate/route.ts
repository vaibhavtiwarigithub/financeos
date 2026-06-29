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

2. Verify each factual claim in the user's reasoning against real data. Be specific about what checks out and what doesn't.

3. Score the reasoning quality 0-100 using this exact rubric:
   - Clarity & specificity (20pts): Is there a specific, falsifiable claim with concrete triggers?
   - Factual accuracy (30pts): Do their facts match real data? Deduct 5pts per wrong claim.
   - Risk awareness (20pts): Did they acknowledge the bear case or potential failure modes?
   - Contrarian/independent thinking (15pts): Is this crowded consensus or genuine independent analysis?
   - Exit strategy (15pts): Do they know when they'd be wrong and what their exit is?

4. Identify cognitive biases present (use exact names from this list):
   fomo, anchoring, recency_bias, confirmation_bias, herd_mentality, overconfidence, loss_aversion, narrative_fallacy

5. Steelman the bear case — argue as convincingly as possible AGAINST this thesis even if it's good.

IMPORTANT: Return ONLY valid JSON. No markdown code fences, no explanation before or after. Exactly this format:
{
  "score": <integer 0-100>,
  "verdict": <"strong" | "sound" | "mixed" | "flawed" | "emotional">,
  "bias_flags": [<bias names as strings, empty array if none>],
  "what_is_right": "<specific things they got right, cite real data>",
  "what_is_wrong": "<specific errors or gaps, cite real data that contradicts them>",
  "bear_case": "<steelmanned bear thesis, 2-3 sentences>",
  "suggestions": "<3 specific, actionable ways to improve this type of reasoning in the future>",
  "data_used": "<key metrics you actually pulled: price, P/E, RSI, revenue growth trend etc.>"
}
`.trim();

interface EvalResult {
  score: number;
  verdict: string;
  bias_flags: string[];
  what_is_right: string;
  what_is_wrong: string;
  bear_case: string;
  suggestions: string;
  data_used: string;
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
