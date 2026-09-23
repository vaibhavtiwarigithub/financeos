// SQQQ paper cron: entry when flat, monitor+exit when held. Mirrors
// app/api/agents/tqqq/cron/route.ts's structure exactly. Owner-approved
// 2026-09-23 (reverses this feature's earlier shadow-only-forever line for
// SQQQ/SOXS). Buying shares of SQQQ is an ordinary long position in an
// inverse-tracking instrument, not a short sale.
//
// Entry window is 11:40-11:54 ET, continuing the 15-minute offset pattern
// from SOXL (11:00) and TQQQ (11:20).
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { getQuote } from "@/lib/data/quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { planSqqqEntry, monitorSqqq, type SqqqPolicy } from "@/lib/trading/sqqq-lifecycle";
import { paperStopFillPrice } from "@/lib/trading/exit-ladder";
import { LEVERAGED_SLEEVE_SYMBOLS } from "@/lib/trading/leveraged-sleeve-risk";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { sqqqEntryWindow, sqqqQuoteTime } from "@/lib/trading/sqqq-evidence";
import { completedSessionCandles, expectedNewestSession } from "@/lib/data/completed-candles";

const MONITOR_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
const MONITOR_LIVENESS_MS = 26 * 60 * 60 * 1000;
const AGENT_TYPE = "sqqq_cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function lastVerifiedMonitorAt(supabase: ReturnType<typeof createServiceClient>, now: number): Promise<number | null> {
  const { data } = await supabase
    .from("agent_runs")
    .select("completed_at")
    .eq("agent_type", AGENT_TYPE)
    .eq("status", "done")
    .order("completed_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!data?.completed_at) return null;
  const t = Date.parse(data.completed_at as string);
  return Number.isFinite(t) && t <= now && now - t <= MONITOR_LIVENESS_MS ? t : null;
}

async function recordRun(supabase: ReturnType<typeof createServiceClient>, status: "done" | "error", summary: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabase.from("agent_runs").insert({
    agent_type: AGENT_TYPE, market: "us", status, symbols: ["SQQQ"],
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary.slice(0, 500),
  } as any).catch(() => undefined);
}

const NO_AV_FALLBACK = async () => [];

const SQQQ_POLICY: SqqqPolicy = {
  version: "sqqq-paper-entry-v1",
  maxQuoteAgeMs: 30 * 60 * 1000,
  maxSpreadBps: 50,
  maxMonitorAgeMs: 24 * 60 * 60 * 1000,
  atrStopMultiple: 2,
  maxStopPct: 12,
  targetAtrMultiple: 3,
  riskBudgetPct: 1,
};

const MIN_DOLLAR_VOLUME = 10_000_000;

type RunResult = { body: Record<string, unknown>; httpStatus: number; runStatus: "done" | "error"; summary: string };

function ok(body: Record<string, unknown>, httpStatus = 200): RunResult {
  return { body, httpStatus, runStatus: "done", summary: JSON.stringify(body).slice(0, 500) };
}
function fail(body: Record<string, unknown>, httpStatus = 500): RunResult {
  return { body, httpStatus, runStatus: "error", summary: JSON.stringify(body).slice(0, 500) };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = Date.now();
  const priorMonitorVerifiedAt = await lastVerifiedMonitorAt(supabase, now);
  const result = await runSqqqCron(supabase, now, priorMonitorVerifiedAt);
  await recordRun(supabase, result.runStatus, result.summary);
  return NextResponse.json(result.body, { status: result.httpStatus });
}

async function runSqqqCron(supabase: ReturnType<typeof createServiceClient>, now: number, priorMonitorVerifiedAt: number | null): Promise<RunResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("paper_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, initial_stop_loss, highest_price, price_target")
    .eq("symbol", "SQQQ").eq("market", "us").eq("position_role", "sqqq_paper").maybeSingle();
  if (existingErr) return fail({ status: "error", reason: `existing_position_query_failed: ${existingErr.message}` });
  if (existing) {
    const monitorQuote = await getQuote("SQQQ", supabase);
    const decision = monitorSqqq({
      now,
      maxQuoteAgeMs: MONITOR_MAX_QUOTE_AGE_MS,
      quote: {
        price: monitorQuote.source === "unavailable" ? NaN : monitorQuote.price,
        dayLow: monitorQuote.dayLow ?? null, dayHigh: monitorQuote.dayHigh ?? null,
        observedAt: sqqqQuoteTime(monitorQuote, now),
      },
      position: {
        market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
        priceTarget: existing.price_target == null ? null : Number(existing.price_target),
        initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
        currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
        highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
        partialTaken: false,
      },
      thesisInvalidated: false,
    });

    if (decision.action === "data_unavailable" || decision.action === "invalid_position") {
      await reportIssue({
        issueKey: "sqqq-monitor-failed", severity: "warn", category: "risk",
        title: `SQQQ paper position could not be monitored (${decision.action})`,
        detail: `positionId=${existing.id}, quoteSource=${monitorQuote.source}, stale=${monitorQuote.stale}`,
      }, supabase);
      return fail({ status: "monitor_failed", reason: decision.action, positionId: existing.id }, 200);
    }
    await resolveIssue("sqqq-monitor-failed", supabase);

    if (decision.action === "none" || decision.action === "runner_hold") {
      const { error: updateError } = await supabase.from("paper_positions").update({
        current_price: monitorQuote.price,
        highest_price: decision.highestPrice,
        stop_loss: parseFloat(decision.trailingStop.toFixed(2)),
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      if (updateError) return fail({ status: "error", reason: "monitor_state_write_failed" });
      return ok({ status: "held", action: decision.action, positionId: existing.id, trailingStop: decision.trailingStop });
    }

    const isStop = decision.action === "stop_full";
    const fillPrice = isStop ? paperStopFillPrice(monitorQuote.price, decision.trailingStop) : monitorQuote.price;
    const exitReason = isStop ? "sqqq_stop_hit"
      : decision.action === "partial_target" ? "sqqq_partial_target"
      : decision.action === "thesis_full" ? "sqqq_thesis_invalidated"
      : "sqqq_target_hit";
    const { data: exitResult, error: exitErr } = await supabase.rpc("execute_paper_exit", {
      p_position_id: existing.id, p_exit_price: fillPrice, p_exit_reason: exitReason,
      p_exit_qty: decision.action === "partial_target" ? decision.exitQty : null,
      p_partial_stop_loss: decision.action === "partial_target" ? decision.runnerStop : null,
    });
    if (exitErr) {
      await reportIssue({ issueKey: "sqqq-exit-failed", severity: "critical", category: "risk", title: "SQQQ paper exit RPC failed", detail: `positionId=${existing.id}: ${exitErr.message}` }, supabase);
      return fail({ status: "error", reason: `exit_rpc_failed: ${exitErr.message}` });
    }
    const exit = exitResult as any;
    if (!exit?.ok) return fail({ status: "error", reason: `exit_denied: ${exit?.error ?? "unknown"}` });
    return ok({ status: "exited", action: decision.action, positionId: existing.id, fillPrice, closedQty: exit.closed_qty, remainingQty: exit.remaining_qty, realizedPnl: exit.realized_pnl });
  }

  if (!sqqqEntryWindow(new Date(now))) return ok({ status: "no_entry", reason: "outside_entry_window" });
  const [candleResult, quote] = await Promise.all([
    fetchUsCandles("SQQQ", NO_AV_FALLBACK).catch(() => ({ candles: [], source: "unavailable" as const })),
    getQuote("SQQQ", supabase),
  ]);
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

  const technicals = computeTechnicals(candles.candles);
  const veto = detectBreakdownVeto(technicals);
  const trendQualified = !veto.vetoed
    && technicals.priceVsEma20 === "above" && technicals.priceVsEma50 === "above" && technicals.trend20d === "up";
  const features = computeLeveragedShadowFeatures(candles.candles);
  if (features.dollarVolume == null || features.dollarVolume < MIN_DOLLAR_VOLUME) {
    return ok({ status: "no_entry", reason: "liquidity_floor_not_met", dollarVolume: features.dollarVolume });
  }
  const atr = technicals.atr14;
  const swingLow = Math.min(...candles.candles.slice(-10).map(c => c.low));

  const { data: lastExit, error: lastExitError } = await supabase
    .from("paper_trades")
    .select("closed_at")
    .eq("symbol", "SQQQ").eq("market", "us").eq("position_role", "sqqq_paper")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();
  if (lastExitError) return fail({ status: "error", reason: "last_exit_query_failed" });
  const lastExitAt = lastExit?.closed_at ? new Date(lastExit.closed_at as string).getTime() : null;

  const { data: portfolio, error: portfolioErr } = await supabase
    .from("paper_portfolio").select("nav, cash_balance, updated_at").eq("market", "us").maybeSingle();
  if (portfolioErr || !portfolio) return fail({ status: "error", reason: `portfolio_query_failed: ${portfolioErr?.message ?? "not_found"}` });
  const { data: sleevePositions, error: sleeveErr } = await supabase
    .from("paper_positions").select("symbol, qty, current_price").eq("market", "us")
    .in("symbol", [...LEVERAGED_SLEEVE_SYMBOLS]);
  if (sleeveErr) return fail({ status: "error", reason: `sleeve_positions_query_failed: ${sleeveErr.message}` });
  const leveragedSleevePositions = (sleevePositions ?? []).map((p: any) => ({
    symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? 0),
  }));

  const plan = planSqqqEntry({
    policy: SQQQ_POLICY,
    now,
    quote: { bid: quote.bid ?? NaN, ask: quote.ask ?? NaN, observedAt: sqqqQuoteTime(quote, now) },
    signalAt: Date.parse(`${signalSession}T00:00:00Z`),
    lastExitAt,
    signalSession,
    expectedSignalSession: expectedSession,
    entryWindowOpen: sqqqEntryWindow(new Date(now)),
    monitorVerifiedAt: priorMonitorVerifiedAt ?? NaN,
    trendQualified,
    atr: atr ?? 0,
    structuralStop: swingLow,
    nav: Number(portfolio.nav ?? 0),
    cash: Number(portfolio.cash_balance ?? 0),
    leveragedSleevePositions,
  });

  if (!plan.ok) {
    await resolveIssue("sqqq-entry-cron-failed", supabase);
    return ok({ status: "no_entry", reason: plan.reason });
  }

  const qty = plan.maxNotional / plan.entry;
  if (!(qty > 0)) return ok({ status: "no_entry", reason: "zero_capacity" });

  const { data: rpcResult, error: rpcErr } = await supabase.rpc("execute_sqqq_paper_fill", {
    p_market: "us", p_currency: "USD", p_symbol: "SQQQ",
    p_qty: qty, p_fill_price: plan.entry, p_total_cost: qty * plan.entry,
    p_price_source: quote.source, p_price_retrieved_at: quote.retrievedAt,
    p_bid: quote.bid, p_ask: quote.ask, p_spread: quote.bid && quote.ask ? quote.ask - quote.bid : null,
    p_stop_loss: plan.stop, p_price_target: plan.target,
    p_policy_version: plan.version,
    p_rationale: `SQQQ paper entry: trend-qualified breakout, ATR ${atr?.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}, dollar volume ${features.dollarVolume?.toFixed(0)}`,
  });
  if (rpcErr) {
    await reportIssue({ issueKey: "sqqq-entry-cron-failed", severity: "warn", category: "execution", title: "SQQQ paper entry RPC failed", detail: rpcErr.message }, supabase);
    return fail({ status: "error", reason: `rpc_failed: ${rpcErr.message}` });
  }
  const result = rpcResult as any;
  if (!result?.ok) {
    return ok({ status: "no_entry", reason: result?.error ?? "rpc_denied" });
  }
  await resolveIssue("sqqq-entry-cron-failed", supabase);
  return ok({ status: "entered", qty, entry: plan.entry, stop: plan.stop, target: plan.target, tradeId: result.trade_id });
}
