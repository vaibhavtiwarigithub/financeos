// TQQQ paper v3: shared current-session setup and recurring monitoring.
// Legacy symbol-specific live windows remain in the evidence module; this paper
// path uses the shared calendar-aware intraday window and recorded policy version.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION, LEVERAGED_SLEEVE_MAX_NAV_FRACTION } from "@/lib/trading/leveraged-sleeve-risk";
import { doorQuoteForPlan, doorQuoteNote } from "@/lib/trading/leveraged-door-quote";
import { evaluateLeveragedResearchGate, loadLatestResearchSignal } from "@/lib/trading/leveraged-door-signal";
import { loadTradingMandate } from "@/lib/trading-mandate";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { getLeveragedIntradayQuote } from "@/lib/data/leveraged-intraday-quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { planTqqqEntry, monitorTqqq, type TqqqPolicy } from "@/lib/trading/tqqq-lifecycle";
import { paperStopFillPrice } from "@/lib/trading/exit-ladder";
import { LEVERAGED_SLEEVE_SYMBOLS } from "@/lib/trading/leveraged-sleeve-risk";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { tqqqQuoteTime } from "@/lib/trading/tqqq-evidence";
import { leveragedPaperEntryWindow as tqqqEntryWindow, loadLeveragedIntradaySetup, leveragedPaperSessionOpen, leveragedPaperExitDue, leveragedPaperTrailMode, leveragedPaperRunSummary } from "@/lib/trading/leveraged-intraday";
import { completedSessionCandles, expectedNewestSession } from "@/lib/data/completed-candles";

const MONITOR_MAX_QUOTE_AGE_MS = 2 * 60 * 1000;
// V3 checks every five minutes. The planner separately requires monitor proof
// within ten minutes; this broader legacy lookup bound cannot authorize entry.
const MONITOR_LIVENESS_MS = 26 * 60 * 60 * 1000;
const AGENT_TYPE = "tqqq_cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function lastVerifiedMonitorAt(supabase: ReturnType<typeof createServiceClient>, now: number): Promise<number | null> {
  const { data } = await supabase
    .from("agent_runs")
    .select("completed_at")
    .eq("agent_type", AGENT_TYPE)
    .eq("status", "done")
    .like("result_summary", '%"monitorVerified":true%')
    .order("completed_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!data?.completed_at) return null;
  const t = Date.parse(data.completed_at as string);
  return Number.isFinite(t) && t <= now && now - t <= MONITOR_LIVENESS_MS ? t : null;
}

async function recordRun(supabase: ReturnType<typeof createServiceClient>, status: "done" | "error", summary: string): Promise<void> {
  const nowIso = new Date().toISOString();
  // supabase-js builders are thenables without .catch(): the old `.insert(...).catch(...)` threw a
  // TypeError on every call (HTTP 500, no run row), so the liveness proof could never be written.
  try {
    const { error } = await supabase.from("agent_runs").insert({
    agent_type: AGENT_TYPE, market: "us", status, symbols: ["TQQQ"],
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary,
  } as any);
    if (error) console.error(`[tqqq] liveness row write failed: ${error.message}`);
  } catch (e) { console.error(`[tqqq] liveness row write threw: ${String(e)}`); } // bookkeeping must never break the real response
}

const NO_AV_FALLBACK = async () => [];

// Same declared v3 full-risk geometry and two-minute quote bound as SOXL.
// Operational priors, not validated alpha; shared sleeve capacity still applies.
const TQQQ_POLICY: TqqqPolicy = {
  version: "tqqq-paper-intraday-v3",
  maxQuoteAgeMs: 2 * 60 * 1000,
  maxSpreadBps: 50,
  maxMonitorAgeMs: 10 * 60 * 1000,
  atrStopMultiple: 2,
  maxStopPct: 12,
  targetAtrMultiple: 3,
  riskBudgetPct: 1,
};

const MIN_DOLLAR_VOLUME = 10_000_000;

type RunResult = { body: Record<string, unknown>; httpStatus: number; runStatus: "done" | "error"; summary: string };

function ok(body: Record<string, unknown>, httpStatus = 200): RunResult {
  return { body, httpStatus, runStatus: "done", summary: leveragedPaperRunSummary(body) };
}
function fail(body: Record<string, unknown>, httpStatus = 500): RunResult {
  return { body, httpStatus, runStatus: "error", summary: leveragedPaperRunSummary(body) };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = Date.now();
  if (!leveragedPaperSessionOpen(new Date(now))) {
    return NextResponse.json({ status: "no_entry", reason: "outside_regular_session" });
  }
  const priorMonitorVerifiedAt = await lastVerifiedMonitorAt(supabase, now);
  const result = await runTqqqCron(supabase, now, priorMonitorVerifiedAt);
  await recordRun(supabase, result.runStatus, result.summary);
  return NextResponse.json(result.body, { status: result.httpStatus });
}

// pg_cron reaches agents through kairos_call_agent, which always sends POST (its `method` argument
// is ignored), so the doors answered 405 and never ran. Same handler, same cron-secret gate.
export const POST = GET;

async function runTqqqCron(supabase: ReturnType<typeof createServiceClient>, now: number, priorMonitorVerifiedAt: number | null): Promise<RunResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("paper_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, initial_stop_loss, highest_price, price_target, entry_policy_version, opened_at")
    .eq("symbol", "TQQQ").eq("market", "us").eq("position_role", "tqqq_paper").maybeSingle();
  if (existingErr) return fail({ status: "error", reason: `existing_position_query_failed: ${existingErr.message}` });
  if (existing) {
    const monitorQuote = await getLeveragedIntradayQuote("TQQQ");
    // Venue events can arrive during I/O. Validate against decision time, not request start.
    now = Date.now();
    const decision = monitorTqqq({
      now,
      maxQuoteAgeMs: MONITOR_MAX_QUOTE_AGE_MS,
      quote: {
        price: monitorQuote.source === "unavailable" ? NaN : monitorQuote.price,
        dayLow: null, dayHigh: null,
        observedAt: tqqqQuoteTime(monitorQuote, now),
      },
      position: {
        market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
        trailMode: leveragedPaperTrailMode(existing.entry_policy_version),
        priceTarget: existing.price_target == null ? null : Number(existing.price_target),
        initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
        currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
        highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
        partialTaken: existing.price_target == null,
      },
      thesisInvalidated: false,
    });

    if (decision.action === "data_unavailable" || decision.action === "invalid_position") {
      await reportIssue({
        issueKey: "tqqq-monitor-failed", severity: "warn", category: "risk",
        title: `TQQQ paper position could not be monitored (${decision.action})`,
        detail: `positionId=${existing.id}, quoteSource=${monitorQuote.source}, stale=${monitorQuote.stale}`,
      }, supabase);
      return fail({ status: "monitor_failed", reason: decision.action, positionId: existing.id }, 200);
    }
    await resolveIssue("tqqq-monitor-failed", supabase);

    const sessionExit = leveragedPaperExitDue(new Date(now), existing.entry_policy_version, existing.opened_at);
    if (!sessionExit && (decision.action === "none" || decision.action === "runner_hold")) {
      const { error: updateError } = await supabase.from("paper_positions").update({
        current_price: monitorQuote.price,
        highest_price: decision.highestPrice,
        stop_loss: parseFloat(decision.trailingStop.toFixed(2)),
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      if (updateError) return fail({ status: "error", reason: "monitor_state_write_failed" });
      return ok({ monitorVerified: true, status: "held", action: decision.action, positionId: existing.id, trailingStop: decision.trailingStop });
    }

    const isStop = decision.action === "stop_full";
    const fillPrice = isStop ? paperStopFillPrice(monitorQuote.price, decision.trailingStop) : monitorQuote.price;
    const exitReason = isStop ? "tqqq_stop_hit"
      : sessionExit ? "tqqq_intraday_session_end"
      : decision.action === "partial_target" ? "tqqq_partial_target"
      : decision.action === "thesis_full" ? "tqqq_thesis_invalidated"
      : "tqqq_target_hit";
    const { data: exitResult, error: exitErr } = await supabase.rpc("execute_paper_exit", {
      p_position_id: existing.id, p_exit_price: fillPrice, p_exit_reason: exitReason,
      p_exit_qty: !sessionExit && decision.action === "partial_target" ? decision.exitQty : null,
      p_partial_stop_loss: !sessionExit && decision.action === "partial_target" ? decision.runnerStop : null,
    });
    if (exitErr) {
      await reportIssue({ issueKey: "tqqq-exit-failed", severity: "critical", category: "risk", title: "TQQQ paper exit RPC failed", detail: `positionId=${existing.id}: ${exitErr.message}` }, supabase);
      return fail({ status: "error", reason: `exit_rpc_failed: ${exitErr.message}` });
    }
    const exit = exitResult as any;
    if (!exit?.ok) return fail({ status: "error", reason: `exit_denied: ${exit?.error ?? "unknown"}` });
    return ok({ monitorVerified: true, status: "exited", action: sessionExit ? "session_end_full" : decision.action, positionId: existing.id, fillPrice, closedQty: exit.closed_qty, remainingQty: exit.remaining_qty, realizedPnl: exit.realized_pnl });
  }

  if (!tqqqEntryWindow(new Date(now))) {
    const probe = await getLeveragedIntradayQuote("TQQQ");
    now = Date.now();
    if (!Number.isFinite(tqqqQuoteTime(probe, now)) || now - tqqqQuoteTime(probe, now) > MONITOR_MAX_QUOTE_AGE_MS) return fail({ status: "monitor_failed", reason: "quote_unavailable_or_stale" }, 200);
    return ok({ status: "no_entry", reason: "outside_entry_window", monitorVerified: true });
  }
  const [candleResult, quote] = await Promise.all([
    fetchUsCandles("TQQQ", NO_AV_FALLBACK).catch(() => ({ candles: [], source: "unavailable" as const })),
    getLeveragedIntradayQuote("TQQQ"),
  ]);
  now = Date.now();
  if (!tqqqEntryWindow(new Date(now))) return ok({ status: "no_entry", reason: "outside_entry_window" });
  const candles = { ...candleResult, candles: completedSessionCandles(candleResult.candles, "us", new Date(now)) };
  const expectedSession = expectedNewestSession("us", new Date(now));
  const signalSession = candles.candles.at(-1)?.date;
  if (signalSession !== expectedSession) return ok({ status: "no_entry", reason: "stale_candle_evidence" });
  if (candles.candles.length < 60) {
    return ok({ status: "no_entry", reason: "insufficient_candle_history", dataPoints: candles.candles.length });
  }
  if (quote.source === "unavailable" || quote.stale || !(quote.price > 0)) {
    return ok({ status: "no_entry", reason: "quote_unavailable_or_stale", source: quote.source });
  }

  const intraday = await loadLeveragedIntradaySetup("TQQQ");
  if (intraday.state === "unavailable") {
    await reportIssue({ issueKey: "leveraged-intraday-data:tqqq", severity: "warn", category: "data",
      title: "TQQQ current-session setup unavailable", detail: intraday.reason }, supabase);
    return fail({ status: "no_entry", reason: intraday.reason, policy: intraday.policy }, 200);
  }
  await resolveIssue("leveraged-intraday-data:tqqq", supabase);
  if (intraday.state !== "ready") return ok({ status: "no_entry", monitorVerified: Number.isFinite(tqqqQuoteTime(quote, Date.now())) && Date.now() - tqqqQuoteTime(quote, Date.now()) <= MONITOR_MAX_QUOTE_AGE_MS, reason: intraday.reason, setup: intraday.evidence });
  intraday.evidence.previous_completed_session = signalSession;
  intraday.evidence.previous_completed_close = candles.candles.at(-1)!.close;
  intraday.evidence.opening_gap_pct = (Number(intraday.evidence.session_open) / candles.candles.at(-1)!.close - 1) * 100;
  const technicals = { atr14: intraday.atr };
  const trendQualified = true;
  const features = computeLeveragedShadowFeatures(candles.candles);
  if (features.dollarVolume == null || features.dollarVolume < MIN_DOLLAR_VOLUME) {
    return ok({ status: "no_entry", reason: "liquidity_floor_not_met", dollarVolume: features.dollarVolume });
  }
  if (quote.price <= Math.max(Number(intraday.evidence.openingHigh), Number(intraday.evidence.etf_vwap)))
    return ok({ status: "no_entry", monitorVerified: Number.isFinite(tqqqQuoteTime(quote, Date.now())) && Date.now() - tqqqQuoteTime(quote, Date.now()) <= MONITOR_MAX_QUOTE_AGE_MS, reason: "intraday_setup_reversed" });
  const atr = technicals.atr14;
  const swingLow = intraday.structuralStop;

  const { data: lastExit, error: lastExitError } = await supabase
    .from("paper_trades")
    .select("closed_at")
    .eq("symbol", "TQQQ").eq("market", "us").eq("position_role", "tqqq_paper")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();
  if (lastExitError) return fail({ status: "error", reason: "last_exit_query_failed" });
  const lastExitAt = lastExit?.closed_at ? new Date(lastExit.closed_at as string).getTime() : null;

  const { data: portfolio, error: portfolioErr } = await supabase
    .from("paper_portfolio").select("nav, cash_balance, updated_at").eq("market", "us").maybeSingle();
  if (portfolioErr || !portfolio) return fail({ status: "error", reason: `portfolio_query_failed: ${portfolioErr?.message ?? "not_found"}` });
  // Only the open SOXL/TQQQ paper positions matter for the shared sleeve cap
  // (leveraged-sleeve-risk.ts) — unlike SOXL's own semiconductorCapacity,
  // this does not need a full-book sector classification.
  const { data: sleevePositions, error: sleeveErr } = await supabase
    .from("paper_positions").select("symbol, qty, current_price").eq("market", "us")
    .in("symbol", [...LEVERAGED_SLEEVE_SYMBOLS]);
  if (sleeveErr) return fail({ status: "error", reason: `sleeve_positions_query_failed: ${sleeveErr.message}` });
  const leveragedSleevePositions = (sleevePositions ?? []).map((p: any) => ({
    symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? 0),
  }));

  // Routed design: research must currently endorse this symbol (see lib/trading/leveraged-door-signal.ts).
  const [{ signal: researchSignal, error: researchSignalError }, mandate] = await Promise.all([
    loadLatestResearchSignal(supabase, "TQQQ"),
    loadTradingMandate(supabase, "us"),
  ]);
  if (researchSignalError) return fail({ status: "error", reason: `research_signal_query_failed: ${researchSignalError}` });
  // Recheck quote, signal, liveness and entry window after all evidence reads.
  now = Date.now();
  const researchGate = evaluateLeveragedResearchGate(researchSignal, { threshold: mandate.score_threshold, now, intradayQualified: intraday.state === "ready" });
  if (!researchGate.ok) return ok({ status: "no_entry", reason: `research_gate:${researchGate.reason}`, monitorVerified: Number.isFinite(tqqqQuoteTime(quote, now)) && now - tqqqQuoteTime(quote, now) <= MONITOR_MAX_QUOTE_AGE_MS });
  // Real bid/ask when the provider has one; otherwise a modeled conservative spread (paper only).
  const doorQuote = doorQuoteForPlan({ bid: quote.bid, ask: quote.ask, price: quote.price }, tqqqQuoteTime(quote, now));

  const plan = planTqqqEntry({
    policy: TQQQ_POLICY,
    now,
    quote: doorQuote,
    signalAt: intraday.signalAt,
    lastExitAt,
    signalSession,
    expectedSignalSession: expectedSession,
    entryWindowOpen: tqqqEntryWindow(new Date(now)),
    monitorVerifiedAt: priorMonitorVerifiedAt ?? NaN,
    trendQualified,
    atr: atr ?? 0,
    structuralStop: swingLow,
    nav: Number(portfolio.nav ?? 0),
    cash: Number(portfolio.cash_balance ?? 0),
    leveragedSleevePositions,
  });

  if (!plan.ok) {
    await resolveIssue("tqqq-entry-cron-failed", supabase);
    return ok({ status: "no_entry", reason: plan.reason,
      setup: intraday.evidence, policy: intraday.policy,
      research: { signal_id: researchGate.signalId, score: researchGate.score, role: "daily_context_not_intraday_trigger" },
      funding: { ...plan.sizing, cash: Number(portfolio.cash_balance), nav: Number(portfolio.nav),
        account_snapshot_at: portfolio.updated_at, minimum_fraction: LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION, sleeve_max_fraction: LEVERAGED_SLEEVE_MAX_NAV_FRACTION },
      quote: { price: quote.price, source: quote.source, observed_at: quote.observedAt ?? quote.retrievedAt },
      monitorVerified: Number.isFinite(tqqqQuoteTime(quote, now)) && now - tqqqQuoteTime(quote, now) <= MONITOR_MAX_QUOTE_AGE_MS });
  }

  const qty = plan.maxNotional / plan.entry;
  if (!(qty > 0)) return ok({ status: "no_entry", reason: "zero_capacity" });

  const { data: rpcResult, error: rpcErr } = await supabase.rpc("execute_tqqq_paper_fill", {
    p_market: "us", p_currency: "USD", p_symbol: "TQQQ",
    p_qty: qty, p_fill_price: plan.entry, p_total_cost: qty * plan.entry,
    p_price_source: quote.source, p_price_retrieved_at: quote.observedAt ?? quote.retrievedAt,
    p_bid: quote.bid, p_ask: quote.ask, p_spread: quote.bid && quote.ask ? quote.ask - quote.bid : null,
    p_stop_loss: plan.stop, p_price_target: plan.target,
    p_policy_version: plan.version,
    p_rationale: `TQQQ paper entry: trend-qualified breakout, ATR ${atr?.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}, dollar volume ${features.dollarVolume?.toFixed(0)} [research signal ${researchGate.signalId} score ${researchGate.score}] [setup ${JSON.stringify(intraday.evidence)}]${doorQuoteNote(doorQuote, quote.source)}`,
  });
  if (rpcErr) {
    await reportIssue({ issueKey: "tqqq-entry-cron-failed", severity: "warn", category: "execution", title: "TQQQ paper entry RPC failed", detail: rpcErr.message }, supabase);
    return fail({ status: "error", reason: `rpc_failed: ${rpcErr.message}` });
  }
  const result = rpcResult as any;
  if (!result?.ok) {
    return ok({ status: "no_entry", reason: result?.error ?? "rpc_denied" });
  }
  await resolveIssue("tqqq-entry-cron-failed", supabase);
  return ok({ status: "entered", qty, entry: plan.entry, stop: plan.stop, target: plan.target, tradeId: result.trade_id });
}
