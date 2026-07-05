import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runAgentLoop, ToolCall } from "@/lib/llm-router";

export const dynamic = "force-dynamic";

// MentorAgent — a true tool-use AI coach. Reasons over the user's actual
// behavior + learning progress + market regime + trading principles and returns
// personalized coaching (strengths, focus areas, one market-tailored lesson,
// grade + confidence, next milestone). Advisory/educational only.
// deepseek-reasoner (no ANTHROPIC_API_KEY → Claude tool-loops unavailable).

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "DEEPSEEK_API_KEY not set" }, { status: 503 });

  const svc = createServiceClient();

  async function toolExecutor(call: ToolCall): Promise<string> {
    switch (call.name) {
      case "query_behavior": {
        // Real trade history behavior (enriched trade_decisions) + closed paper trades
        const { data: decisions } = await svc.from("trade_decisions")
          .select("action, outcome_score, pattern_tags, macro_market_regime")
          .eq("enrichment_status", "enriched")
          .order("exec_date", { ascending: false })
          .limit(100);
        const rows = decisions ?? [];
        const buys = rows.filter((d: any) => d.action === "buy");
        const sells = rows.filter((d: any) => d.action === "sell");
        const avg = (a: any[]) => a.length ? a.reduce((s, d: any) => s + (d.outcome_score ?? 0), 0) / a.length : null;
        const tagCounts: Record<string, { n: number; score: number }> = {};
        for (const d of rows as any[]) {
          for (const t of (Array.isArray(d.pattern_tags) ? d.pattern_tags : [])) {
            tagCounts[t] ??= { n: 0, score: 0 };
            tagCounts[t].n++; tagCounts[t].score += d.outcome_score ?? 0;
          }
        }
        const patterns = Object.entries(tagCounts).map(([t, v]) => ({ tag: t, n: v.n, avg_outcome: Number((v.score / v.n).toFixed(2)) })).sort((a, b) => b.n - a.n).slice(0, 10);

        const { data: closed } = await svc.from("paper_trades")
          .select("symbol, outcome, pnl_pct").not("closed_at", "is", null).order("closed_at", { ascending: false }).limit(50);

        return JSON.stringify({
          real_trades_analyzed: rows.length,
          buy_avg_outcome: avg(buys), sell_avg_outcome: avg(sells),
          buy_vs_sell: buys.length && sells.length ? (avg(buys)! > avg(sells)! ? "better at buying" : "better at selling") : "insufficient",
          pattern_performance: patterns,
          paper_trades_closed: (closed ?? []).length,
          paper_win_rate: (closed ?? []).length ? Math.round((closed!.filter((t: any) => t.outcome === "win").length / closed!.length) * 100) : null,
        });
      }
      case "query_learning_progress": {
        const { count: closedCount } = await svc.from("paper_trades").select("*", { count: "exact", head: true }).not("closed_at", "is", null);
        const { data: runs } = await svc.from("learner_runs").select("run_date, hypotheses, win_rate_snapshot").order("run_date", { ascending: false }).limit(3);
        const { data: rescore } = await svc.from("learning_log").select("note").ilike("note", "[RESCORE]%").order("created_at", { ascending: false }).limit(5);
        return JSON.stringify({
          closed_trades: closedCount ?? 0,
          phase: (closedCount ?? 0) >= 10 ? "Phase 1 (weight-tuning unlocked)" : `Phase 0 (${closedCount ?? 0}/10 to unlock)`,
          recent_learner_runs: runs ?? [],
          rescore_flags: (rescore ?? []).map((r: any) => r.note),
        });
      }
      case "query_market_context": {
        const { data: macro } = await svc.from("macro_signals").select("regime, summary").order("created_at", { ascending: false }).limit(1).maybeSingle();
        return JSON.stringify({ regime: (macro as any)?.regime ?? "unknown", summary: (macro as any)?.summary ?? "" });
      }
      case "read_principles": {
        const { data: priors } = await svc.from("learning_priors").select("category, principle, confidence").eq("enabled", true).order("confidence", { ascending: false }).limit(15);
        return JSON.stringify({ principles: priors ?? [] });
      }
      case "finish":
        return JSON.stringify(call.arguments);
      default:
        return JSON.stringify({ error: `Unknown tool: ${call.name}` });
    }
  }

  const systemPrompt = `You are the MentorAgent — a personal trading coach for a retail investor using a governed paper+live quant platform. You are a TRUE AI AGENT: call tools, reason over the RESULTS, and produce grounded, personalized coaching. This is educational/advisory only — you never place trades or change strategy.

Your job: assess how the user is doing and coach them. Ground EVERYTHING in the tool data. If the data is thin (Phase 0, few closed trades), say so honestly and coach on PROCESS (journaling, patience, rule-following) rather than inventing outcome-based feedback.

Approach:
1. query_learning_progress — where are they in the learning curve?
2. query_behavior — what do they do well/badly (buy vs sell, pattern performance)?
3. query_market_context — what regime are we in, and how should that shape behavior?
4. read_principles — anchor advice in the platform's market principles.
5. finish — return structured coaching.

Be specific, warm but honest, and concrete. Tie the ONE lesson to BOTH the current market regime AND their actual gap. No generic platitudes.`;

  const initialMessage = `Coach me. Assess my trading progress and behavior from my real data, factor in the current market regime, and give me: what I'm doing well, what to focus on, one lesson for THIS market tailored to my gaps, and my next concrete milestone. Call the tools first, then finish.`;

  const MENTOR_TOOLS = [
    { name: "query_learning_progress", description: "Closed-trade count, Phase 0/1 status, recent LearnerAgent hypotheses, and rescore flags.", parameters: { type: "object", properties: {} } },
    { name: "query_behavior", description: "The user's real trading behavior: buy vs sell accuracy, pattern_tag performance from enriched trade_decisions, and paper trade win rate.", parameters: { type: "object", properties: {} } },
    { name: "query_market_context", description: "Current macro market regime + summary.", parameters: { type: "object", properties: {} } },
    { name: "read_principles", description: "Human-written Bayesian market principles to anchor advice.", parameters: { type: "object", properties: {} } },
    { name: "finish", description: "Return the coaching. grade 0-100 (discipline/progress), confidence 0-1, strengths[], focus_areas[] (each a short string), lesson (one, market-tailored), market_note, next_milestone.", parameters: { type: "object", properties: { grade: { type: "integer", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 1 }, strengths: { type: "array", items: { type: "string" } }, focus_areas: { type: "array", items: { type: "string" } }, lesson: { type: "string" }, market_note: { type: "string" }, next_milestone: { type: "string" } }, required: ["grade", "confidence", "strengths", "focus_areas", "lesson", "market_note", "next_milestone"] } },
  ];

  try {
    const loop = await runAgentLoop({
      model: "deepseek-reasoner",
      systemPrompt, initialMessage,
      tools: MENTOR_TOOLS, toolExecutor,
      maxIterations: 10, task: "evaluate", agentLabel: "mentor",
    });

    const finishCall = loop.toolCalls.find(c => c.name === "finish");
    // The model must have produced a real coaching payload — don't persist/return
    // an all-null row as success.
    if (!finishCall) {
      return NextResponse.json({ error: "Mentor did not produce coaching (no finish call)" }, { status: 502 });
    }
    const a: any = finishCall.args ?? {};
    if (!a.lesson && !(Array.isArray(a.focus_areas) && a.focus_areas.length)) {
      return NextResponse.json({ error: "Mentor coaching was empty" }, { status: 502 });
    }

    const { data: saved, error: saveErr } = await svc.from("mentor_insights").insert({
      grade: Number.isFinite(a.grade) ? Math.round(a.grade) : null,
      confidence: Number.isFinite(a.confidence) ? a.confidence : null,
      strengths: Array.isArray(a.strengths) ? a.strengths : [],
      focus_areas: Array.isArray(a.focus_areas) ? a.focus_areas : [],
      lesson: a.lesson ?? null,
      market_note: a.market_note ?? null,
      next_milestone: a.next_milestone ?? null,
      model: "deepseek-reasoner",
      tokens_in: loop.tokensIn, tokens_out: loop.tokensOut,
    }).select("id, created_at").single();

    if (saveErr || !saved) {
      return NextResponse.json({ error: `Mentor save failed: ${saveErr?.message ?? "no row"}` }, { status: 500 });
    }

    return NextResponse.json({
      id: (saved as any)?.id, createdAt: (saved as any)?.created_at,
      grade: a.grade, confidence: a.confidence, strengths: a.strengths, focus_areas: a.focus_areas,
      lesson: a.lesson, market_note: a.market_note, next_milestone: a.next_milestone,
      steps: loop.steps, tokensIn: loop.tokensIn, tokensOut: loop.tokensOut,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Mentor coaching failed: ${e.message}` }, { status: 500 });
  }
}

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data } = await svc.from("mentor_insights").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();

  // Staleness check: the cached insight goes stale if a new paper position was
  // opened or a new signal was written after it, since the coaching text quotes
  // "current" positions/signals verbatim (e.g. "before your first paper trade",
  // "mega-cap tech signals"). Rather than a blind TTL, regenerate when there's
  // new relevant activity the cached row never saw.
  const insight = (data as any) ?? null;
  let stale = false;
  if (insight?.created_at) {
    const since = insight.created_at;
    const [{ count: newPositions }, { count: newSignals }] = await Promise.all([
      svc.from("paper_positions").select("*", { count: "exact", head: true }).gt("opened_at", since),
      svc.from("agent_signals").select("*", { count: "exact", head: true }).gt("created_at", since),
    ]);
    stale = (newPositions ?? 0) > 0 || (newSignals ?? 0) > 0;
  }

  return NextResponse.json({ insight, stale });
}
