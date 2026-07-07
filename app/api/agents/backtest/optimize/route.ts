import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llm-router";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";

interface BacktestParams {
  date_from?: string;
  date_to?: string;
  score_threshold?: number;
  target_pct?: number;
  stop_loss_pct?: number;
  max_hold_days?: number;
  strategy_version_id?: string;
  market?: "us" | "india";
}

interface BacktestMetrics {
  total_trades: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  expectancy: number;
  avg_hold_days: number;
  benchmark_return_pct: number | null;
  alpha_pct: number | null;
  gate_pass: boolean;
  gate_reasons: Record<string, { pass: boolean; value: number | null; threshold: number | null }>;
}

async function runBacktest(params: BacktestParams, baseUrl: string): Promise<{ metrics: BacktestMetrics; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/agents/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok || data.error) return { metrics: null as any, error: data.error ?? "Backtest failed" };
    return { metrics: data.metrics };
  } catch (e: any) {
    return { metrics: null as any, error: e.message };
  }
}

function describeMetrics(m: BacktestMetrics, params: BacktestParams): string {
  const failures = Object.entries(m.gate_reasons)
    .filter(([, g]) => !g.pass)
    .map(([k, g]) => `${k}: got ${typeof g.value === "number" ? (g.value < 1 && k !== "min_expectancy" ? (g.value * 100).toFixed(1) + "%" : g.value.toFixed(2)) : "n/a"}, need ${g.threshold}`)
    .join("; ");

  return `Backtest params: score_threshold=${params.score_threshold}, target=${params.target_pct}%, stop=${params.stop_loss_pct}%, max_hold=${params.max_hold_days}d
Metrics: trades=${m.total_trades}, win_rate=${(m.win_rate * 100).toFixed(1)}%, sharpe=${m.sharpe_ratio.toFixed(2)}, drawdown=${m.max_drawdown_pct.toFixed(1)}%, expectancy=${m.expectancy.toFixed(2)}%, avg_return=${m.avg_return_pct.toFixed(2)}%
Gate: ${m.gate_pass ? "PASS" : `FAIL — ${failures}`}`;
}

export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const initialParams: BacktestParams = {
      date_from:         body.date_from,
      date_to:           body.date_to,
      score_threshold:   body.score_threshold   ?? 60,
      target_pct:        body.target_pct        ?? 20,
      stop_loss_pct:     body.stop_loss_pct     ?? 7,
      max_hold_days:     body.max_hold_days      ?? 15,
      strategy_version_id: body.strategy_version_id,
      // Thread market through so India optimize replays ₹ signals. The internal
      // fetch to /api/agents/backtest can't forward the cookie, so pass it in body.
      market:            body.market === "india" ? "india" : "us",
    };

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    // Run initial backtest
    const { metrics: initial, error: initialError } = await runBacktest(initialParams, baseUrl);
    if (initialError || !initial) {
      return NextResponse.json({ error: initialError ?? "Initial backtest failed" }, { status: 500 });
    }

    // If already passing, return early with a note
    if (initial.gate_pass) {
      return NextResponse.json({
        status: "already_passing",
        message: "Backtest already passes all gate checks. No optimization needed.",
        initial: { params: initialParams, metrics: initial },
        suggestions: [],
      });
    }

    // Ask LLM for 3 param variations
    const diagnosisPrompt = `You are a quant analyst diagnosing a failed backtest and suggesting parameter improvements.

${describeMetrics(initial, initialParams)}

The backtest simulates: entry on signal date at close price, exit when target% or stop_loss% hit, or after max_hold_days.
score_threshold = minimum analyst_score (0-100) for a signal to be included.

Analyze WHY each gate failed and suggest exactly 3 different parameter sets to try. Each should address the specific failure.

Rules:
- score_threshold: integer 45–85
- target_pct: 5–50
- stop_loss_pct: 3–15
- max_hold_days: 3–30
- Suggest DIFFERENT approaches for each variation (e.g. one filters harder, one exits faster, one holds longer)
- Explain WHY each change addresses the specific gate failure
- Be concrete: cite which metric failed and how the param change addresses it

Return ONLY valid JSON array with exactly 3 items:
[
  {
    "label": "Tighter Score Filter",
    "rationale": "1-2 sentence explanation citing the specific metric failure",
    "params": {"score_threshold": 70, "target_pct": 20, "stop_loss_pct": 7, "max_hold_days": 15}
  },
  {
    "label": "Faster Exit",
    "rationale": "...",
    "params": {"score_threshold": 60, "target_pct": 12, "stop_loss_pct": 5, "max_hold_days": 8}
  },
  {
    "label": "Wider Target",
    "rationale": "...",
    "params": {"score_threshold": 65, "target_pct": 30, "stop_loss_pct": 10, "max_hold_days": 20}
  }
]`;

    // Model is configurable from Settings -> Agents -> LLM Config
    // (agent_config, agent_name="backtest-optimize") — was hardcoded to real
    // Claude Haiku with no fallback (would fail instantly, no ANTHROPIC_API_KEY);
    // defaults to deepseek-reasoner now.
    const optimizeSvc = createServiceClient();
    if (!(await isAgentEnabled(optimizeSvc, "backtest-optimize"))) {
      throw new Error("backtest-optimize is disabled in Settings -> Agents -> LLM Config");
    }
    const llmResult = await callLLM({
      task: "optimize",
      model: await getConfiguredModel(optimizeSvc, "backtest-optimize"),
      prompt: diagnosisPrompt,
      symbol: "BACKTEST",
      agentLabel: "optimizer",
      maxTokens: 800,
    });

    let suggestions: Array<{ label: string; rationale: string; params: BacktestParams }> = [];
    try {
      const match = llmResult.text.match(/\[[\s\S]*\]/);
      if (match) suggestions = JSON.parse(match[0]);
    } catch {
      // LLM parse failed — use heuristic fallbacks
      const p = initialParams;
      suggestions = [
        {
          label: "Tighter Score Filter",
          rationale: "Raising score threshold reduces trade count but improves signal quality — fixes low win rate by filtering weak signals.",
          params: { ...p, score_threshold: Math.min(80, (p.score_threshold ?? 60) + 10) },
        },
        {
          label: "Faster Exit",
          rationale: "Tighter target and stop reduces exposure time — improves Sharpe by cutting drawdown and holding losers shorter.",
          params: { ...p, target_pct: Math.max(8, (p.target_pct ?? 20) - 8), stop_loss_pct: Math.max(4, (p.stop_loss_pct ?? 7) - 2), max_hold_days: Math.max(5, (p.max_hold_days ?? 15) - 5) },
        },
        {
          label: "Longer Hold",
          rationale: "Extending hold time allows winners to run further — improves expectancy if trades are trending not mean-reverting.",
          params: { ...p, target_pct: (p.target_pct ?? 20) + 10, max_hold_days: Math.min(30, (p.max_hold_days ?? 15) + 10) },
        },
      ];
    }

    // Run each suggested variation in parallel
    const variationResults = await Promise.all(
      suggestions.map(async (s) => {
        const params: BacktestParams = {
          date_from:       initialParams.date_from,
          date_to:         initialParams.date_to,
          strategy_version_id: initialParams.strategy_version_id,
          market:          initialParams.market,
          ...s.params,
        };
        const { metrics, error } = await runBacktest(params, baseUrl);
        return {
          label: s.label,
          rationale: s.rationale,
          params,
          metrics: metrics ?? null,
          error: error ?? null,
          improvement: metrics
            ? {
                sharpe_delta: parseFloat((metrics.sharpe_ratio - initial.sharpe_ratio).toFixed(2)),
                win_rate_delta: parseFloat(((metrics.win_rate - initial.win_rate) * 100).toFixed(1)),
                expectancy_delta: parseFloat((metrics.expectancy - initial.expectancy).toFixed(2)),
                drawdown_delta: parseFloat((initial.max_drawdown_pct - metrics.max_drawdown_pct).toFixed(1)),
                gate_pass: metrics.gate_pass,
              }
            : null,
        };
      })
    );

    // Pick best variation by: gate pass first, then Sharpe
    const passing = variationResults.filter(r => r.metrics?.gate_pass);
    const best = passing.length > 0
      ? passing.sort((a, b) => (b.metrics?.sharpe_ratio ?? 0) - (a.metrics?.sharpe_ratio ?? 0))[0]
      : variationResults.sort((a, b) => (b.metrics?.sharpe_ratio ?? 0) - (a.metrics?.sharpe_ratio ?? 0))[0];

    return NextResponse.json({
      status: "optimized",
      eligible_for_promotion: false,
      warning: "Optimizer results are informational only — all variations use in-sample data. Not valid for strategy eligibility decisions.",
      initial: { params: initialParams, metrics: initial },
      suggestions: variationResults,
      best_suggestion: best ?? null,
      llm_tokens: { in: llmResult.tokensIn, out: llmResult.tokensOut },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
