import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

const CRON_SECRET = "fos-cron-k9x2m7p4-2026";
const MAX_ITERATIONS = 18;
const PHASE0_MIN_TRADES = 10;

// â"€â"€â"€ DeepSeek tool-use loop â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

type Message = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string };

async function runAgentLoop(opts: {
  systemPrompt: string;
  userMessage: string;
  tools: any[];
  toolHandlers: Record<string, (args: any) => Promise<any>>;
  dsKey: string;
}): Promise<{ messages: Message[]; iterations: number }> {
  const { systemPrompt, userMessage, tools, toolHandlers, dsKey } = opts;
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${dsKey}` },
      body: JSON.stringify({ model: "deepseek-chat", messages, tools, tool_choice: "auto", max_tokens: 1500, temperature: 0.2 }),
      signal: AbortSignal.timeout(40000),
    });
    const json = await r.json();
    const msg = json?.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    for (const tc of msg.tool_calls) {
      const fn = tc.function?.name;
      const args = JSON.parse(tc.function?.arguments ?? "{}");
      let result: any;
      if (fn === "finish") { return { messages, iterations }; }
      try {
        result = fn && toolHandlers[fn] ? await toolHandlers[fn](args) : { error: `Unknown tool: ${fn}` };
      } catch (e: any) {
        result = { error: e.message };
      }
      messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id, name: fn });
    }
  }
  return { messages, iterations };
}

// â"€â"€â"€ Main â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.includes(CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const dsKey = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  if (!dsKey) {
    return new Response(JSON.stringify({ error: "Missing DEEPSEEK_API_KEY" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const runId = crypto.randomUUID();
  const runStarted = new Date().toISOString();

  // â"€â"€ Phase A: Rule-based position reassessment â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const phaseAResults: any[] = [];
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: openTrades } = await supabase
      .from("paper_trades")
      .select("id, symbol, entry_price, executed_at, analyst_score_at_entry")
      .is("outcome", null)
      .lte("executed_at", cutoff);

    for (const trade of openTrades ?? []) {
      const { data: latestSignal } = await supabase
        .from("agent_signals")
        .select("analyst_score, direction")
        .eq("symbol", trade.symbol)
        .order("created_at", { ascending: false })
        .limit(1).single();

      if (!latestSignal) continue;
      const currentScore = Number(latestSignal.analyst_score ?? 50);
      if (currentScore < 40 && latestSignal.direction !== "long") {
        await supabase.from("paper_trades").update({ llm_exit: true }).eq("id", trade.id);
        phaseAResults.push({ symbol: trade.symbol, action: "flagged_exit", score: currentScore });
      }
    }
  } catch (e: any) {
    phaseAResults.push({ error: e.message });
  }

  // â"€â"€ Phase B: DeepSeek agent loop â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  // Check Phase 0 gate
  const { count: closedCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .not("outcome", "is", null);
  const phase0Unlocked = (closedCount ?? 0) >= PHASE0_MIN_TRADES;

  // Auto-guard: if last 3 runs had win_rate < 35%, pause mutations
  const { data: recentRuns } = await supabase
    .from("learner_runs")
    .select("win_rate")
    .order("run_started_at", { ascending: false })
    .limit(3);
  const avgWinRate = recentRuns && recentRuns.length > 0
    ? recentRuns.reduce((a: number, r: any) => a + Number(r.win_rate ?? 0.5), 0) / recentRuns.length
    : 0.5;
  const mutationsAllowed = phase0Unlocked && avgWinRate >= 0.35;

  // Tool definitions
  const tools = [
    {
      type: "function",
      function: {
        name: "query_signals_with_outcomes",
        description: "Get recent closed trades with signal scores and outcomes",
        parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "query_score_correlation",
        description: "Get correlation between analyst_score buckets and win rate",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "query_macro_context",
        description: "Get current macro regime and signals",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "read_priors",
        description: "Read current signal weights from learner_config — call this first before any analysis",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "read_learning_priors",
        description: "Read Bayesian market principles seeded by humans — use as ground truth starting context",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["fundamental", "technical", "macro", "insider", "general"], description: "Filter by category, or omit for all" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_learner_config",
        description: "Get current learner configuration and thresholds",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "read_past_learnings",
        description: "Read recent learner run summaries",
        parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "write_hypothesis",
        description: "Record a hypothesis about what is driving performance",
        parameters: {
          type: "object",
          properties: {
            hypothesis: { type: "string" },
            confidence: { type: "number" },
            evidence: { type: "string" },
          },
          required: ["hypothesis", "confidence", "evidence"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_signal_weight",
        description: "Update a scoring weight dimension. Only allowed when Phase 0 gate is open and auto-guard passes.",
        parameters: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: ["fundamental", "technical", "sentiment", "macro", "insider"] },
            new_weight: { type: "number", description: "New weight (0.0-1.0). All weights should sum to ~1.0" },
            rationale: { type: "string" },
          },
          required: ["dimension", "new_weight", "rationale"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "End the learning loop with a final summary",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            key_finding: { type: "string" },
            weights_changed: { type: "boolean" },
          },
          required: ["summary", "key_finding", "weights_changed"],
        },
      },
    },
  ];

  // Tool handlers
  const toolHandlers: Record<string, (args: any) => Promise<any>> = {
    async query_signals_with_outcomes({ limit = 30 }) {
      const { data } = await supabase
        .from("paper_trades")
        .select("symbol, outcome, realized_pnl_pct, entry_signal_score, executed_at, exit_at")
        .not("outcome", "is", null)
        .order("exit_at", { ascending: false })
        .limit(limit);
      return data ?? [];
    },
    async query_score_correlation() {
      const { data } = await supabase
        .from("paper_trades")
        .select("entry_signal_score, outcome")
        .not("outcome", "is", null)
        .limit(100);
      if (!data?.length) return { message: "Not enough data" };
      const buckets: Record<string, { wins: number; total: number }> = {};
      for (const t of data) {
        const score = Math.floor(Number(t.entry_signal_score ?? 50) / 10) * 10;
        const key = `${score}-${score + 9}`;
        if (!buckets[key]) buckets[key] = { wins: 0, total: 0 };
        buckets[key].total++;
        if (t.outcome === "win") buckets[key].wins++;
      }
      return Object.entries(buckets).map(([range, b]) => ({ range, winRate: (b.wins / b.total).toFixed(2), total: b.total }));
    },
    async query_macro_context() {
      const [{ data: regime }, { data: signals }] = await Promise.all([
        supabase.from("macro_regime").select("*").order("generated_at", { ascending: false }).limit(1).single(),
        supabase.from("macro_signals").select("indicator, value, danger_score").order("generated_at", { ascending: false }).limit(8),
      ]);
      return { regime, signals };
    },
    async read_priors() {
      const { data } = await supabase.from("learner_config").select("dimension, weight, min_confidence, last_rationale").order("dimension");
      return data ?? [];
    },
    async read_learning_priors({ category }: { category?: string }) {
      let q = supabase.from("learning_priors").select("category, principle, confidence, source").eq("enabled", true).order("confidence", { ascending: false });
      if (category) q = q.eq("category", category);
      const { data } = await q.limit(20);
      return data ?? [];
    },
    async query_learner_config() {
      const { data } = await supabase.from("learner_config").select("*");
      return { config: data, phase0Unlocked, mutationsAllowed, closedTrades: closedCount ?? 0 };
    },
    async read_past_learnings({ limit = 5 }) {
      const { data } = await supabase.from("learner_runs").select("summary, key_finding, run_started_at, weights_changed, win_rate").order("run_started_at", { ascending: false }).limit(limit);
      return data ?? [];
    },
    async write_hypothesis({ hypothesis, confidence, evidence }) {
      await supabase.from("learner_runs").upsert({
        run_id: runId,
        hypothesis,
        confidence,
        evidence,
        run_started_at: runStarted,
        updated_at: new Date().toISOString(),
      }, { onConflict: "run_id" });
      return { ok: true };
    },
    async update_signal_weight({ dimension, new_weight, rationale }) {
      if (!mutationsAllowed) {
        return { error: `Mutations blocked: phase0Unlocked=${phase0Unlocked}, avgWinRate=${avgWinRate.toFixed(2)}` };
      }
      // Clamp weight
      const w = Math.max(0.05, Math.min(0.50, new_weight));
      await supabase.from("learner_config").update({
        weight: w,
        last_updated_at: new Date().toISOString(),
        last_rationale: rationale,
      }).eq("dimension", dimension);
      return { ok: true, dimension, new_weight: w };
    },
    async finish() {
      return { ok: true };
    },
  };

  // Gather context for system prompt
  const { data: recentTrades } = await supabase
    .from("paper_trades")
    .select("symbol, outcome, realized_pnl_pct, entry_signal_score")
    .not("outcome", "is", null)
    .order("exit_at", { ascending: false })
    .limit(20);

  const winRate = recentTrades?.length
    ? recentTrades.filter((t: any) => t.outcome === "win").length / recentTrades.length
    : 0;

  const systemPrompt = `You are Kairos LearnerAgent. Analyze paper trading performance and improve signal weights.
Phase 0 gate: ${phase0Unlocked ? "UNLOCKED" : `LOCKED (need ${PHASE0_MIN_TRADES} closed trades, have ${closedCount ?? 0})`}
Auto-guard: ${mutationsAllowed ? "mutations ALLOWED" : `mutations BLOCKED (avgWinRate=${avgWinRate.toFixed(2)} < 0.35)`}
Recent win rate (last 20): ${(winRate * 100).toFixed(0)}%

RULES:
1. Call read_priors FIRST to see current weights.
2. Call read_learning_priors (no category filter) to load Bayesian market principles — these are ground truth from academic research. Use them to contextualize what you observe in the trade data.
3. Call query_signals_with_outcomes and query_score_correlation to find empirical patterns.
4. Write hypothesis using write_hypothesis BEFORE updating weights. Hypothesis must cite both empirical data AND relevant learning_priors.
5. Only call update_signal_weight when mutations are allowed AND you have strong empirical evidence. All 5 weights must sum to ~1.0.
6. Call finish when done with a clear summary and key_finding.
7. Do NOT hallucinate data. Only reason from tool outputs.
Dimension names: fundamental | technical | sentiment | macro | insider`;

  const userMessage = `Review last week's trading performance. Find patterns in what scores/conditions drove wins vs losses. Update weights if justified and allowed. Summarize findings.`;

  let agentResult: { messages: Message[]; iterations: number } = { messages: [], iterations: 0 };
  let agentError: string | null = null;
  let summary = "";
  let keyFinding = "";
  let weightsChanged = false;

  try {
    agentResult = await runAgentLoop({ systemPrompt, userMessage, tools, toolHandlers, dsKey });
    // Extract finish call data from messages
    for (const msg of agentResult.messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.name === "finish") {
            try {
              const args = JSON.parse(tc.function.arguments ?? "{}");
              summary = args.summary ?? "";
              keyFinding = args.key_finding ?? "";
              weightsChanged = !!args.weights_changed;
            } catch { /* ignore */ }
          }
        }
      }
    }
  } catch (e: any) {
    agentError = e.message;
  }

  // Persist learner run
  await supabase.from("learner_runs").upsert({
    run_id: runId,
    run_started_at: runStarted,
    run_completed_at: new Date().toISOString(),
    iterations: agentResult.iterations,
    phase_a_results: JSON.stringify(phaseAResults),
    summary,
    key_finding: keyFinding,
    weights_changed: weightsChanged,
    win_rate: parseFloat(winRate.toFixed(3)),
    phase0_unlocked: phase0Unlocked,
    mutations_allowed: mutationsAllowed,
    error: agentError,
  }, { onConflict: "run_id" });

  return new Response(JSON.stringify({
    ok: true,
    runId,
    phaseA: phaseAResults,
    phaseB: { iterations: agentResult.iterations, summary, keyFinding, weightsChanged },
    error: agentError,
  }), { headers: { "Content-Type": "application/json" } });
});
