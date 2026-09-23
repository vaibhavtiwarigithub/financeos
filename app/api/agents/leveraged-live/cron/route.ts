// L4 live-trading cron for the leveraged sleeve (SOXL/TQQQ/SQQQ/SOXS).
// One shared route for all four symbols — each goes through the identical
// gate-then-fill-then-stop-then-reconcile sequence, so a per-symbol route
// (the paper doors' own pattern) would just be four copies of this loop.
//
// SAFE BY DEFAULT, MULTIPLE INDEPENDENT WAYS: AUTONOMOUS_LIVE_ENABLED (env,
// false unless set), strategy_config.live_auto_enabled (DB, false),
// strategy_config.protective_orders_enabled (DB, false),
// PROTECTIVE_PLACEMENT_WORKER_AVAILABLE (source constant, false),
// strategy_config.leveraged_sleeve_live_lease_usd (DB, defaults to 0 = zero
// capacity). ALL of these must be true/nonzero before this route can submit
// a single real order — see lib/trading/leveraged-live-kernel.ts.
//
// No live order is ever submitted without a CONFIRMED, broker-resting
// protective stop (lib/protective/placement-worker.ts's placeProtectiveStop,
// already built for equities — see features/hybrid-stop/FEATURE_ARCHITECTURE.md).
// A failed stop placement always flattens the just-opened position rather
// than leaving it naked — see features/leveraged-etf-and-intraday-execution/
// FEATURE_ARCHITECTURE.md's L4 section, part 3.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";
import { PROTECTIVE_PLACEMENT_WORKER_AVAILABLE } from "@/lib/protective/coverage";
import { placeProtectiveStop, cancelProtectiveStop } from "@/lib/protective/placement-worker";
import { managedLivePositionId } from "@/lib/protective/coverage";
import { robinhoodAdapter } from "@/lib/brokers/adapters/robinhood";
import { fetchUsCandles } from "@/lib/data/candles";
import { getQuote } from "@/lib/data/quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { completedSessionCandles, expectedNewestSession } from "@/lib/data/completed-candles";
import { decideExitLadder } from "@/lib/trading/exit-ladder";
import { paperStopFillPrice } from "@/lib/trading/exit-ladder";
import { evaluateLeveragedLiveEntry } from "@/lib/trading/leveraged-live-kernel";
import { planLeveragedLiveEntry, type LeveragedLiveEntryPolicy } from "@/lib/trading/leveraged-live-entry";
import { soxlEntryWindow, soxlQuoteTime } from "@/lib/trading/soxl-evidence";
import { tqqqEntryWindow, tqqqQuoteTime } from "@/lib/trading/tqqq-evidence";
import { sqqqEntryWindow, sqqqQuoteTime } from "@/lib/trading/sqqq-evidence";
import { soxsEntryWindow, soxsQuoteTime } from "@/lib/trading/soxs-evidence";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const AGENT_TYPE = "leveraged_live_cron";
const MONITOR_LIVENESS_MS = 26 * 60 * 60 * 1000;
const MONITOR_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
const MIN_DOLLAR_VOLUME = 10_000_000;
const NO_AV_FALLBACK = async () => [];
const FILL_POLL_ATTEMPTS = 6;
const FILL_POLL_DELAY_MS = 2000;

const LIVE_POLICY: LeveragedLiveEntryPolicy = {
  version: "leveraged-live-entry-v1",
  maxQuoteAgeMs: 30 * 60 * 1000,
  maxSpreadBps: 50,
  maxMonitorAgeMs: 24 * 60 * 60 * 1000,
  atrStopMultiple: 2,
  maxStopPct: 12,
  targetAtrMultiple: 3,
};

const SYMBOLS: Array<{
  symbol: "SOXL" | "TQQQ" | "SQQQ" | "SOXS";
  entryWindow: (now: Date) => boolean;
  quoteTime: (quote: any, now: number) => number;
}> = [
  { symbol: "SOXL", entryWindow: soxlEntryWindow, quoteTime: soxlQuoteTime },
  { symbol: "TQQQ", entryWindow: tqqqEntryWindow, quoteTime: tqqqQuoteTime },
  { symbol: "SQQQ", entryWindow: sqqqEntryWindow, quoteTime: sqqqQuoteTime },
  { symbol: "SOXS", entryWindow: soxsEntryWindow, quoteTime: soxsQuoteTime },
];

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function lastVerifiedMonitorAt(supabase: ReturnType<typeof createServiceClient>, now: number): Promise<number | null> {
  const { data } = await supabase.from("agent_runs")
    .select("completed_at").eq("agent_type", AGENT_TYPE).eq("status", "done")
    .order("completed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.completed_at) return null;
  const t = Date.parse(data.completed_at as string);
  return Number.isFinite(t) && t <= now && now - t <= MONITOR_LIVENESS_MS ? t : null;
}

async function recordRun(supabase: ReturnType<typeof createServiceClient>, status: "done" | "error", summary: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabase.from("agent_runs").insert({
    agent_type: AGENT_TYPE, market: "us", status, symbols: SYMBOLS.map(s => s.symbol),
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary.slice(0, 500),
  } as any).catch(() => undefined);
}

/** Flatten a just-opened position when the protective stop could not be
 * confirmed. Treated as a failed entry, not a "retry the stop later" — see
 * FEATURE_ARCHITECTURE.md L4 part 3, step 3. */
async function flattenAndAlert(symbol: string, qty: number, reason: string, supabase: ReturnType<typeof createServiceClient>) {
  const sell = await robinhoodAdapter().submitOrder({ symbol, side: "sell", qty, type: "market", env: "live" });
  await reportIssue({
    issueKey: `leveraged-live-naked-entry:${symbol}`, severity: "critical", category: "risk",
    title: `LIVE ${symbol} entry flattened — protective stop could not be confirmed`,
    detail: `reason=${reason}; flatten sell ${sell.ok ? `submitted, brokerOrderId=${sell.brokerOrderId}` : `FAILED: ${sell.error}`}`,
  }, supabase);
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = Date.now();
  const priorMonitorVerifiedAt = await lastVerifiedMonitorAt(supabase, now);
  const results: Record<string, unknown> = {};
  let anyError = false;
  for (const cfg of SYMBOLS) {
    try {
      results[cfg.symbol] = await runSymbol(supabase, cfg, now, priorMonitorVerifiedAt);
    } catch (e) {
      anyError = true;
      results[cfg.symbol] = { status: "error", reason: String(e instanceof Error ? e.message : e) };
    }
  }
  await recordRun(supabase, anyError ? "error" : "done", JSON.stringify(results));
  return NextResponse.json({ status: "ran", results });
}

async function runSymbol(
  supabase: ReturnType<typeof createServiceClient>,
  cfg: { symbol: "SOXL" | "TQQQ" | "SQQQ" | "SOXS"; entryWindow: (now: Date) => boolean; quoteTime: (quote: any, now: number) => number },
  now: number,
  priorMonitorVerifiedAt: number | null,
): Promise<Record<string, unknown>> {
  const { symbol } = cfg;

  const { data: existing, error: existingErr } = await supabase
    .from("leveraged_live_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, initial_stop_loss, highest_price, price_target, protective_order_id, broker_account_id")
    .eq("symbol", symbol).is("closed_at", null).maybeSingle();
  if (existingErr) return { status: "error", reason: `existing_position_query_failed: ${existingErr.message}` };

  // ── MONITOR branch ────────────────────────────────────────────────────
  if (existing) {
    const monitorQuote = await getQuote(symbol, supabase);
    if (monitorQuote.source === "unavailable" || monitorQuote.stale) {
      return { status: "monitor_failed", reason: "quote_unavailable_or_stale" };
    }
    const observedAt = cfg.quoteTime(monitorQuote, now);
    if (!Number.isFinite(observedAt) || now - observedAt > MONITOR_MAX_QUOTE_AGE_MS) {
      return { status: "monitor_failed", reason: "quote_too_old" };
    }
    const stopCheckPrice = monitorQuote.dayLow != null && monitorQuote.dayLow > 0
      ? Math.min(monitorQuote.price, monitorQuote.dayLow) : undefined;
    const targetCheckPrice = monitorQuote.dayHigh != null && monitorQuote.dayHigh > 0 ? monitorQuote.dayHigh : undefined;
    const decision = decideExitLadder({
      market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
      price: monitorQuote.price, stopCheckPrice, targetCheckPrice,
      priceTarget: existing.price_target == null ? null : Number(existing.price_target),
      initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
      currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
      highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
      partialTaken: false,
    });

    if (decision.action === "none" || decision.action === "runner_hold") {
      await supabase.from("leveraged_live_positions").update({
        current_price: monitorQuote.price, highest_price: decision.highestPrice,
        stop_loss: parseFloat(decision.trailingStop.toFixed(2)), updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      return { status: "held", action: decision.action, trailingStop: decision.trailingStop };
    }

    // stop_full / target_full / partial_target: cancel the resting broker
    // stop FIRST (avoid a double-sell race), then submit the real exit.
    const positionId = managedLivePositionId({ market: "us", broker: "robinhood", brokerAccountId: existing.broker_account_id, symbol, qty: Number(existing.qty) });
    const cancel = await cancelProtectiveStop({
      supabase, positionId, market: "us", brokerAccountId: existing.broker_account_id,
    });
    if (!cancel.ok) {
      await reportIssue({
        issueKey: `leveraged-live-cancel-failed:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} protective-stop cancel failed before exit`, detail: cancel.reason,
      }, supabase);
      return { status: "error", reason: `protective_cancel_failed: ${cancel.reason}` };
    }
    const isStop = decision.action === "stop_full";
    const fillPrice = isStop ? paperStopFillPrice(monitorQuote.price, decision.trailingStop) : monitorQuote.price;
    const exitQty = decision.action === "partial_target" ? decision.exitQty! : Number(existing.qty);
    const sell = await robinhoodAdapter().submitOrder({ symbol, side: "sell", qty: exitQty, type: "market", env: "live" });
    if (!sell.ok) {
      await reportIssue({
        issueKey: `leveraged-live-exit-failed:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} exit order FAILED`, detail: `action=${decision.action}, qty=${exitQty}: ${sell.error}`,
      }, supabase);
      return { status: "error", reason: `exit_submit_failed: ${sell.error}` };
    }
    if (decision.action === "partial_target") {
      await supabase.from("leveraged_live_positions").update({
        qty: Number(existing.qty) - exitQty, stop_loss: decision.runnerStop, updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      await supabase.from("leveraged_live_positions").update({
        closed_at: new Date().toISOString(), close_reason: decision.action,
        realized_pnl: (fillPrice - Number(existing.avg_cost)) * exitQty,
      }).eq("id", existing.id);
    }
    return { status: "exited", action: decision.action, qty: exitQty, brokerOrderId: sell.brokerOrderId, fillPrice, estimated: true };
  }

  // ── ENTRY branch ──────────────────────────────────────────────────────
  if (!cfg.entryWindow(new Date(now))) return { status: "no_entry", reason: "outside_entry_window" };

  const { data: sc, error: scErr } = await supabase.from("strategy_config")
    .select("live_auto_enabled, live_auto_enabled_until, app_paused, security_locked, trading_enabled_us, protective_orders_enabled, leveraged_sleeve_live_lease_usd, active_account_us")
    .limit(1).maybeSingle();
  if (scErr || !sc) return { status: "error", reason: `strategy_config_query_failed: ${scErr?.message ?? "not_found"}` };

  const { data: overrideRow } = await supabase.from("leveraged_live_overrides").select("min_paper_trades_override").eq("symbol", symbol).maybeSingle();
  const { count: closedPaperCount, error: paperCountErr } = await supabase
    .from("paper_trades").select("*", { count: "exact", head: true })
    .eq("symbol", symbol).eq("market", "us").not("closed_at", "is", null);
  if (paperCountErr) return { status: "error", reason: `paper_trade_count_failed: ${paperCountErr.message}` };
  const { count: criticalAlertCount, error: alertErr } = await supabase
    .from("agent_alerts").select("*", { count: "exact", head: true }).eq("resolved", false).eq("severity", "critical");
  if (alertErr) return { status: "error", reason: `alert_count_failed: ${alertErr.message}` };

  const gate = evaluateLeveragedLiveEntry({
    deploymentFlagEnabled: AUTONOMOUS_LIVE_ENABLED,
    liveAutoEnabled: (sc as any).live_auto_enabled === true,
    liveAutoEnabledUntil: (sc as any).live_auto_enabled_until ?? null,
    appPaused: (sc as any).app_paused === true,
    securityLocked: (sc as any).security_locked === true,
    tradingEnabledUs: (sc as any).trading_enabled_us !== false,
    protectiveOrdersEnabled: (sc as any).protective_orders_enabled === true,
    protectivePlacementWorkerAvailable: PROTECTIVE_PLACEMENT_WORKER_AVAILABLE,
    leaseUsd: Number((sc as any).leveraged_sleeve_live_lease_usd ?? 0),
    closedPaperTradeCount: closedPaperCount ?? 0,
    minPaperTradesOverride: (overrideRow as any)?.min_paper_trades_override === true,
    openUnresolvedCriticalAlertCount: criticalAlertCount ?? 0,
    now,
  });
  if (!gate.go) return { status: "no_entry", reason: gate.reason, gate: gate.gate };

  const brokerAccountId = (sc as any).active_account_us as string | null;
  if (!brokerAccountId) return { status: "no_entry", reason: "no_active_us_account" };

  const [candleResult, quote] = await Promise.all([
    fetchUsCandles(symbol, NO_AV_FALLBACK).catch(() => ({ candles: [], source: "unavailable" as const })),
    getQuote(symbol, supabase),
  ]);
  const candles = { ...candleResult, candles: completedSessionCandles(candleResult.candles, "us", new Date(now)) };
  const expectedSession = expectedNewestSession("us", new Date(now));
  const signalSession = candles.candles.at(-1)?.date;
  if (signalSession !== expectedSession) return { status: "no_entry", reason: "stale_candle_evidence" };
  if (candles.candles.length < 60) return { status: "no_entry", reason: "insufficient_candle_history" };
  if (quote.source === "unavailable" || quote.stale || !(quote.price > 0)) return { status: "no_entry", reason: "quote_unavailable_or_stale" };

  const technicals = computeTechnicals(candles.candles);
  const veto = detectBreakdownVeto(technicals);
  const trendQualified = !veto.vetoed
    && technicals.priceVsEma20 === "above" && technicals.priceVsEma50 === "above" && technicals.trend20d === "up";
  const features = computeLeveragedShadowFeatures(candles.candles);
  if (features.dollarVolume == null || features.dollarVolume < MIN_DOLLAR_VOLUME) {
    return { status: "no_entry", reason: "liquidity_floor_not_met" };
  }
  const atr = technicals.atr14 ?? 0;
  const swingLow = Math.min(...candles.candles.slice(-10).map(c => c.low));

  const { data: lastExit, error: lastExitErr } = await supabase
    .from("leveraged_live_positions").select("closed_at")
    .eq("symbol", symbol).not("closed_at", "is", null)
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();
  if (lastExitErr) return { status: "error", reason: `last_exit_query_failed: ${lastExitErr.message}` };
  const lastExitAt = lastExit?.closed_at ? new Date(lastExit.closed_at as string).getTime() : null;

  const { data: allOpenLive, error: liveErr } = await supabase
    .from("leveraged_live_positions").select("symbol, qty, current_price").is("closed_at", null);
  if (liveErr) return { status: "error", reason: `live_positions_query_failed: ${liveErr.message}` };
  const existingLivePositions = (allOpenLive ?? []).map((p: any) => ({ symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? p.qty ?? 0) }));

  const plan = planLeveragedLiveEntry({
    policy: LIVE_POLICY, now,
    quote: { bid: quote.bid ?? NaN, ask: quote.ask ?? NaN, observedAt: cfg.quoteTime(quote, now) },
    signalAt: Date.parse(`${signalSession}T00:00:00Z`), lastExitAt, signalSession, expectedSignalSession: expectedSession,
    entryWindowOpen: cfg.entryWindow(new Date(now)), monitorVerifiedAt: priorMonitorVerifiedAt ?? NaN,
    trendQualified, atr, structuralStop: swingLow,
    leaseUsd: Number((sc as any).leveraged_sleeve_live_lease_usd ?? 0), existingLivePositions,
  });
  if (!plan.ok) return { status: "no_entry", reason: plan.reason };

  const qty = Math.floor(plan.maxNotional / plan.entry); // RH equity live: whole shares only
  if (!(qty > 0)) return { status: "no_entry", reason: "zero_capacity_after_rounding" };

  // ── Submit BUY ──────────────────────────────────────────────────────
  const buy = await robinhoodAdapter().submitOrder({ symbol, side: "buy", qty, type: "market", env: "live" });
  if (!buy.ok || !buy.brokerOrderId) {
    await reportIssue({ issueKey: `leveraged-live-entry-failed:${symbol}`, severity: "warn", category: "execution",
      title: `LIVE ${symbol} entry order failed`, detail: buy.error ?? "no broker order id" }, supabase);
    return { status: "error", reason: `buy_failed: ${buy.error}` };
  }

  // ── Poll for confirmed fill ─────────────────────────────────────────
  let filled = false, filledQty = 0, avgFillPrice = plan.entry;
  for (let i = 0; i < FILL_POLL_ATTEMPTS && !filled; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await robinhoodAdapter().getOrder(buy.brokerOrderId, "live");
    if (state.ok && state.status === "filled" && state.filledQty && state.avgFillPrice) {
      filled = true; filledQty = state.filledQty; avgFillPrice = state.avgFillPrice;
    }
  }
  if (!filled) {
    await reportIssue({ issueKey: `leveraged-live-fill-unconfirmed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} BUY fill could not be confirmed`, detail: `brokerOrderId=${buy.brokerOrderId} — MANUAL RECONCILIATION REQUIRED` }, supabase);
    return { status: "error", reason: "fill_unconfirmed_manual_reconcile_required", brokerOrderId: buy.brokerOrderId };
  }

  // ── Place broker-native protective stop — REQUIRED, fail-closed flatten ──
  const stop = await placeProtectiveStop({
    supabase, symbol, market: "us", broker: "robinhood", brokerAccountId,
    qty: filledQty, entryPrice: avgFillPrice, proposalId: null, proposalBrokerOrderId: buy.brokerOrderId,
  });
  if (!stop.ok) {
    await flattenAndAlert(symbol, filledQty, stop.reason, supabase);
    return { status: "flattened_no_protective_stop", reason: stop.reason, entryBrokerOrderId: buy.brokerOrderId };
  }

  const { error: insertErr } = await supabase.from("leveraged_live_positions").insert({
    symbol, market: "us", broker: "robinhood", broker_account_id: brokerAccountId,
    qty: filledQty, avg_cost: avgFillPrice, current_price: avgFillPrice,
    stop_loss: plan.stop, initial_stop_loss: plan.stop, price_target: plan.target, highest_price: avgFillPrice,
    entry_broker_order_id: buy.brokerOrderId, protective_order_id: stop.protectiveOrderId,
    policy_version: plan.version,
    rationale: `LIVE ${symbol} entry: trend-qualified, ATR ${atr.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}`,
  });
  if (insertErr) {
    // The fill and stop are both real at this point — a bookkeeping failure
    // must not be silently swallowed even though the position is protected.
    await reportIssue({ issueKey: `leveraged-live-bookkeeping-failed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} position filled and stopped but leveraged_live_positions insert FAILED`,
      detail: `brokerOrderId=${buy.brokerOrderId}, protectiveOrderId=${stop.protectiveOrderId}: ${insertErr.message} — MANUAL RECONCILIATION REQUIRED` }, supabase);
    return { status: "error", reason: `bookkeeping_insert_failed: ${insertErr.message}`, entryBrokerOrderId: buy.brokerOrderId };
  }
  await resolveIssue(`leveraged-live-entry-failed:${symbol}`, supabase);
  return { status: "entered", qty: filledQty, entry: avgFillPrice, stop: plan.stop, target: plan.target, brokerOrderId: buy.brokerOrderId, protectiveOrderId: stop.protectiveOrderId };
}
