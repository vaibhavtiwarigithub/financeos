import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { callLLM, REASONING_MIN_TOKENS } from "@/lib/llm-router";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";
import {
  INDIA_NO_MACRO_READ_REASON,
  buildMacroReadPrompt,
  isMacroReadSupported,
  selectMacroRegime,
  type MarketScope,
} from "@/lib/macro-read";

export const dynamic = "force-dynamic";
// 150s, not 60. A REASONING model must finish thinking before it emits a single
// token of answer, and REASONING_MIN_TOKENS gives it room to. Measured
// 2026-09-02: with the budget floored this route exceeded 60s and Vercel killed
// it — FUNCTION_INVOCATION_TIMEOUT, with no llm_call_log row written at all,
// which looks like "never ran" rather than "ran out of wall clock".
//
// The budget floor was necessary and not sufficient: a model given enough tokens
// to answer also needs enough seconds to be waited for. Cron-driven, so latency
// costs nothing here. 150 matches the research cron's ceiling.
export const maxDuration = 150;

// NARRATIVE ONLY. `macro_interpretations` is written here and read back by this
// route's own GET alone (rendered in MacroReadCard on Markets). Nothing in any
// scoring, sizing, gate, order or exit path reads it — verified 2026-07-17 by
// grepping every consumer of the table. The deterministic rule stands: this
// route must never widen its reach onto a money path.
//
// The macro read is US-ONLY BY CONSTRUCTION — see lib/macro-read.ts for the
// full kill-not-fake reasoning for India.

function marketOf(req: NextRequest): MarketScope {
  return new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
}

// GET — return today's cached macro-to-holdings interpretation (owner-only).
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const market = marketOf(req);

  // India: refuse before touching the table. macro_interpretations still holds
  // legacy India rows (ids 2, 4, 6) written by the pre-fix cron — id=6 contains
  // US Fed-funds reasoning applied to a 13-position India book. Serving them
  // would render exactly the contamination this fix removes, so the India read
  // is reported as structurally unsupported and those rows stay unreachable.
  if (!isMacroReadSupported(market)) {
    return NextResponse.json({
      interpretation: null,
      stale: false,
      supported: false,
      reason: INDIA_NO_MACRO_READ_REASON,
    });
  }

  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc
    .from("macro_interpretations")
    .select("content, model, created_at, date")
    .eq("market", market)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({
    interpretation: data ?? null,
    stale: !data || (data as any).date !== today,
    supported: true,
  });
}

// POST — (re)generate the interpretation. Cron-gated OR owner-gated. Runs a
// cheap model over deterministic inputs (latest macro regime + prints + the
// current book + macro priors). Advisory text only — never changes any
// trading behavior. Cached once/day per market so it costs at most one cheap
// LLM call per macro refresh.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const market = marketOf(req);

  // India: refuse BEFORE the LLM call and BEFORE any write. The
  // `kairos-macro-read-india` cron (jobid 47, `30 4 * * 1-5`) is still active in
  // prod and will keep firing until the owner drops it — this gate is what makes
  // that harmless: zero LLM spend, zero rows. FLAGGED for removal, not removed
  // here (dropping a cron row is a prod DB mutation).
  if (!isMacroReadSupported(market)) {
    return NextResponse.json({
      ok: false,
      skipped: "unsupported-market",
      market,
      reason: INDIA_NO_MACRO_READ_REASON,
    });
  }

  const svc = createServiceClient();
  if (!(await isAgentEnabled(svc, "macro-read"))) {
    return NextResponse.json({ ok: false, error: "macro-read is disabled in Settings -> Agents -> LLM Config" }, { status: 200 });
  }
  const today = new Date().toISOString().slice(0, 10);

  // Skip if already generated today (idempotent; avoids repeat spend).
  const { data: existing } = await svc.from("macro_interpretations").select("id").eq("market", market).eq("date", today).maybeSingle();
  if (existing && !new URL(req.url).searchParams.get("force")) {
    return NextResponse.json({ ok: true, skipped: "already generated today" });
  }

  // Deterministic inputs.
  //
  // Fetch the 3 newest rows and let selectMacroRegime() apply the unknown /
  // age / indicator-floor guards, rather than trusting the single newest row.
  // Ordered by `week_of` (the verdict's actual as-of date) to match
  // lib/data/scores.ts — the previous `created_at` ordering could rank a
  // late-written row for an older week above a fresher verdict.
  const { data: regimeRows } = await svc
    .from("macro_regime")
    .select("week_of, danger_score, regime, summary, raw_indicators")
    .order("week_of", { ascending: false })
    .limit(3);

  const now = new Date();
  const { chosen, rejected } = selectMacroRegime(regimeRows as any[], now);

  // NOTE: no early return when `chosen` is null. The read is still generated —
  // it just honestly says the macro backdrop is unknown. The old
  // `if (!regime) return "no macro regime data yet"` produced a blank card and
  // no row; an explicit "we don't know" is more useful and more honest.
  const { data: positions } = await svc.from("paper_positions").select("symbol, sector, qty").eq("market", market).limit(40);
  const { data: macroPriors } = await svc.from("learning_priors").select("principle, confidence").eq("category", "macro").eq("enabled", true).order("confidence", { ascending: false }).limit(12);

  const book = (positions ?? []).map((p: any) => `${p.symbol}${p.sector ? ` (${p.sector})` : ""}`).join(", ") || "no open positions";
  const priorsText = (macroPriors ?? []).map((p: any) => `- ${p.principle} [confidence ${Math.round(p.confidence * 100)}%]`).join("\n");

  const prompt = buildMacroReadPrompt({ market: "us", chosen, book, priorsText });

  let content = "";
  let model = "deepseek-v4-pro";
  try {
    model = await getConfiguredModel(svc, "macro-read", "deepseek-v4-pro");
    const res = await callLLM({
      task: "summarize",
      prompt,
      model,
      // 600 was too small and silently killed this agent for 4 days. prod
      // agent_config sets macro-read to `deepseek-reasoner`, which streams a
      // long chain-of-thought into `reasoning_content` BEFORE emitting the
      // answer into `content`. Once macro_regime gained a real 7-indicator row
      // (2026-07-13 12:30 UTC), the prompt got meaty enough that the reasoning
      // alone consumed the whole 600-token budget: every run from 2026-07-13
      // 13:30 onward failed with `finish_reason=length, reasoning_len≈2500` and
      // empty content, so llm-router threw, the catch below returned a 200
      // `ok:false`, and NOTHING was written while the cron reported success.
      // Keep the shared floor as a safety net, not this route's normal behavior.
      maxTokens: REASONING_MIN_TOKENS,
      agentLabel: "macro-read",
    });
    content = res.text?.trim() ?? "";
  } catch (e) {
    return NextResponse.json({ ok: false, error: `LLM unavailable: ${String(e)}` }, { status: 200 });
  }
  if (!content) return NextResponse.json({ ok: false, error: "empty interpretation" }, { status: 200 });

  await svc.from("macro_interpretations").upsert({ date: today, market, content, model }, { onConflict: "date,market" });
  return NextResponse.json({
    ok: true,
    content,
    model,
    macro_available: !!chosen,
    ...(chosen ? { regime_as_of: chosen.week_of } : { rejected_rows: rejected }),
  });
}
