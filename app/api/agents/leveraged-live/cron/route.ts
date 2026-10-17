// L4 live-trading cron for the leveraged sleeve (SOXL/TQQQ/SQQQ/SOXS).
// One shared route for all four symbols — each goes through the identical
// gate-then-fill-then-stop-then-reconcile sequence, so a per-symbol route
// (the paper doors' own pattern) would just be four copies of this loop.
//
// SAFE BY DEFAULT, MULTIPLE INDEPENDENT WAYS: LEVERAGED_LIVE_ENABLED (env,
// false unless set — deliberately its OWN flag, separate from core-equity's
// AUTONOMOUS_LIVE_ENABLED, see lib/autonomy.ts), strategy_config.
// leveraged_live_auto_enabled (DB, false — also its own flag, separate from
// live_auto_enabled), strategy_config.protective_orders_enabled (DB, false),
// PROTECTIVE_PLACEMENT_WORKER_AVAILABLE (source constant, false),
// strategy_config.leveraged_sleeve_live_lease_usd (DB, defaults to 0 = zero
// capacity). ALL of these must be true/nonzero before this route can submit
// a single real order — see lib/trading/leveraged-live-kernel.ts. Controlled
// from Settings → Leveraged Sleeve — Live Trading (app/api/settings/
// leveraged-live/route.ts, components/dashboard/LeveragedLiveSettings.tsx).
//
// IMPORTANT: keep the code-level placement flag false. The worker now requires
// exact resting-stop and final-cancel readback, and this monitor requires
// confirmed fills, but those contracts have not been proved against a real
// resting broker stop/fill. A cron exit is not continuous intraday or overnight
// protection. Do not enable until broker lifecycle is contract-tested end to end.
import { NextRequest, NextResponse } from "next/server";
import { bestEffort } from "@/lib/supabase/best-effort";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { LEVERAGED_LIVE_ENABLED } from "@/lib/autonomy";
import { PROTECTIVE_PLACEMENT_WORKER_AVAILABLE } from "@/lib/protective/coverage";
import { placeProtectiveStop, cancelProtectiveStop } from "@/lib/protective/placement-worker";
import { managedLivePositionId } from "@/lib/protective/coverage";
import { robinhoodAdapter } from "@/lib/brokers/adapters/robinhood";
import { fetchUsCandles } from "@/lib/data/candles";
import { getLeveragedExecutableQuote } from "@/lib/data/leveraged-intraday-quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { completedSessionCandles, expectedNewestSession } from "@/lib/data/completed-candles";
import { decideExitLadder } from "@/lib/trading/exit-ladder";
import { evaluateLeveragedLiveEntry } from "@/lib/trading/leveraged-live-kernel";
import { planLeveragedLiveEntry, type LeveragedLiveEntryPolicy } from "@/lib/trading/leveraged-live-entry";
import { soxlEntryWindow, soxlQuoteTime } from "@/lib/trading/soxl-evidence";
import { tqqqEntryWindow, tqqqQuoteTime } from "@/lib/trading/tqqq-evidence";
import { sqqqEntryWindow, sqqqQuoteTime } from "@/lib/trading/sqqq-evidence";
import { soxsEntryWindow, soxsQuoteTime } from "@/lib/trading/soxs-evidence";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { queryRobinhoodOrder, robinhoodHeldQty } from "@/lib/robinhood-mcp";
import { confirmedRobinhoodStopExit, verifyRobinhoodRestingStop } from "@/lib/protective/robinhood-readback";

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

/** Record every leveraged-live fill in broker_orders. REQUIRED for
 * correctness, not just audit: Manual Trade Guardian
 * (app/api/agents/manual-fill-detect/cron/route.ts) diffs live Robinhood
 * holdings in this SAME account (605420660) against broker_orders to tell
 * an agentic fill from a manual one. Without this row, every leveraged-live
 * BUY would be misclassified as a manual trade and trigger a false
 * "manual buy detected" alert plus a redundant suggested stop (this cron
 * already places a real broker-native one). learning_scope='risk_policy_only'
 * (not 'full') so these fills are visible to risk/guardian tooling but
 * never feed core-equity LearnerAgent promotion — matches the L4 proposal's
 * non-goal that leveraged-sleeve outcomes must not touch core-equity learning. */
async function recordBrokerOrder(
  supabase: ReturnType<typeof createServiceClient>,
  input: { symbol: string; side: "buy" | "sell"; brokerAccountId: string; brokerOrderId: string; qty: number; avgFillPrice: number | null },
) {
  // best-effort: a logging failure must not undo a real fill (and `.catch` on a supabase builder would throw AFTER the fill)
  await bestEffort(supabase.from("broker_orders").insert({
    market: "us", broker: "robinhood", broker_env: "live", broker_account_id: input.brokerAccountId,
    symbol: input.symbol, side: input.side, qty: input.qty, order_type: "market",
    status: "filled", broker_order_id: input.brokerOrderId, submitted_at: new Date().toISOString(),
    filled_qty: input.qty, avg_fill_price: input.avgFillPrice, approved_by_user: false,
    learning_scope: "risk_policy_only",
  } as any), "leveraged-live broker_orders ledger");
}

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
  await bestEffort(supabase.from("agent_runs").insert({
    agent_type: AGENT_TYPE, market: "us", status, symbols: SYMBOLS.map(s => s.symbol),
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary.slice(0, 500),
  } as any), "leveraged-live agent_runs");
}

/** Flatten a just-opened position when the protective stop could not be
 * confirmed. Treated as a failed entry, not a "retry the stop later" — see
 * FEATURE_ARCHITECTURE.md L4 part 3, step 3. */
async function flattenAndAlert(symbol: string, qty: number, reason: string, brokerAccountId: string, supabase: ReturnType<typeof createServiceClient>) {
  const sell = await robinhoodAdapter().submitOrder({ symbol, side: "sell", qty, type: "market", env: "live" });
  let confirmedFill = false;
  let ledgerClosed = false;
  if (sell.ok && sell.brokerOrderId) {
    for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
      await sleep(FILL_POLL_DELAY_MS);
      const state = await robinhoodAdapter().getOrder(sell.brokerOrderId, "live");
      if (state.ok && state.status === "filled" && state.filledQty === qty && state.avgFillPrice && state.avgFillPrice > 0) {
        confirmedFill = true;
        await recordBrokerOrder(supabase, { symbol, side: "sell", brokerAccountId, brokerOrderId: sell.brokerOrderId, qty, avgFillPrice: state.avgFillPrice });
        const { data: held, error: heldErr } = await supabase.from("leveraged_live_positions")
          .select("id, avg_cost").eq("symbol", symbol).is("closed_at", null).maybeSingle();
        if (heldErr || !held) {
          break;
        }
        const { error } = await supabase.from("leveraged_live_positions").update({
          closed_at: new Date().toISOString(), close_reason: "protective_placement_failed",
          realized_pnl: (state.avgFillPrice - Number(held.avg_cost)) * qty,
        }).eq("id", held.id);
        ledgerClosed = !error;
        break;
      }
    }
  }
  await reportIssue({
    issueKey: `leveraged-live-naked-entry:${symbol}`, severity: "critical", category: "risk",
    title: `LIVE ${symbol} protective stop failed — ${confirmedFill ? (ledgerClosed ? "flatten confirmed" : "broker fill confirmed, ledger unresolved") : "flatten NOT confirmed"}`,
    detail: `reason=${reason}; flatten sell ${sell.ok ? `brokerOrderId=${sell.brokerOrderId}, confirmed=${confirmedFill}, ledgerClosed=${ledgerClosed}` : `FAILED: ${sell.error}`}`,
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
    if (!existing.protective_order_id) {
      await reportIssue({ issueKey: `leveraged-live-protection-missing:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} position has no confirmed protective stop`,
        detail: `entry/position ledger requires manual broker reconciliation before any automated exit` }, supabase);
      return { status: "monitor_failed", reason: "protective_stop_unconfirmed" };
    }
    const { data: protection, error: protectionErr } = await supabase.from("protective_orders")
      .select("status, broker_order_id, protected_qty, trigger_price")
      .eq("id", existing.protective_order_id).maybeSingle();
    if (protectionErr || !protection || protection.status !== "active" || !protection.broker_order_id) {
      return { status: "monitor_failed", reason: "protective_stop_not_active_or_unreadable" };
    }
    if (Number(protection.protected_qty) !== Number(existing.qty)) {
      return { status: "monitor_failed", reason: "protective_qty_does_not_match_holding" };
    }
    const resting = await queryRobinhoodOrder(protection.broker_order_id, existing.broker_account_id);
    if (resting.ok && resting.status === "filled") {
      const held = await robinhoodHeldQty(symbol, existing.broker_account_id);
      const fillPrice = confirmedRobinhoodStopExit({ status: resting.status, filledQty: resting.filledQty,
        avgFillPrice: resting.avgFillPrice, heldReadOk: held.ok, heldQty: held.qty, expectedQty: Number(existing.qty) });
      if (fillPrice == null) {
        await reportIssue({ issueKey: `leveraged-live-stop-fill-unresolved:${symbol}`, severity: "critical", category: "risk",
          title: `LIVE ${symbol} broker stop fill requires reconciliation`,
          detail: `stopOrderId=${protection.broker_order_id}; broker held=${held.qty ?? "unreadable"}; filled=${resting.filledQty ?? "unreadable"}; no duplicate sell submitted`,
        }, supabase);
        return { status: "monitor_failed", reason: "protective_stop_fill_unresolved" };
      }
      const { error: closeErr } = await supabase.from("leveraged_live_positions").update({
        closed_at: new Date().toISOString(), close_reason: "protective_disaster_floor",
        realized_pnl: (fillPrice - Number(existing.avg_cost)) * Number(existing.qty),
      }).eq("id", existing.id).is("closed_at", null);
      if (closeErr) return { status: "monitor_failed", reason: `protective_fill_ledger_failed: ${closeErr.message}` };
      await supabase.from("protective_orders").update({ status: "filled", last_reconciled_at: new Date().toISOString() })
        .eq("id", existing.protective_order_id);
      await recordBrokerOrder(supabase, { symbol, side: "sell", brokerAccountId: existing.broker_account_id,
        brokerOrderId: protection.broker_order_id, qty: Number(existing.qty), avgFillPrice: fillPrice });
      return { status: "exited", action: "protective_disaster_floor", qty: Number(existing.qty),
        brokerOrderId: protection.broker_order_id, fillPrice };
    }
    if (!resting.ok || resting.status !== "submitted" || !verifyRobinhoodRestingStop(resting.raw, {
      symbol, account: existing.broker_account_id, qty: Number(existing.qty), stopPrice: Number(protection.trigger_price),
    })) {
      await reportIssue({ issueKey: `leveraged-live-protection-unverified:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} broker stop is not proven resting`,
        detail: `brokerOrderId=${protection.broker_order_id}; status=${resting.status ?? resting.error ?? "unreadable"}; manual reconciliation required`,
      }, supabase);
      return { status: "monitor_failed", reason: "broker_protection_unverified" };
    }
    const monitorQuote = await getLeveragedExecutableQuote(symbol);
    if (!monitorQuote || monitorQuote.stale || monitorQuote.bid == null) {
      return { status: "monitor_failed", reason: "broker_bid_ask_unavailable_or_stale" };
    }
    const observedAt = cfg.quoteTime(monitorQuote, now);
    if (!Number.isFinite(observedAt) || now - observedAt > MONITOR_MAX_QUOTE_AGE_MS) {
      return { status: "monitor_failed", reason: "quote_too_old" };
    }
    // A long liquidation can sell at the current bid, not an unrelated last
    // trade. The broker-resident stop (once proven) must cover between polls.
    const executableSellPrice = monitorQuote.bid;
    const stopCheckPrice = executableSellPrice;
    const targetCheckPrice = executableSellPrice;
    const decision = decideExitLadder({
      market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
      price: executableSellPrice, stopCheckPrice, targetCheckPrice,
      priceTarget: existing.price_target == null ? null : Number(existing.price_target),
      initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
      currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
      highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
      partialTaken: false,
    });

    if (decision.action === "none" || decision.action === "runner_hold") {
      await supabase.from("leveraged_live_positions").update({
        current_price: executableSellPrice, highest_price: decision.highestPrice,
        stop_loss: parseFloat(decision.trailingStop.toFixed(2)), updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      return { status: "held", action: decision.action, trailingStop: decision.trailingStop };
    }

    // The MCP surface has no proved atomic stop-size replace. Selling half
    // would leave a full-size resting stop against the runner or a naked runner.
    if (decision.action === "partial_target") {
      return { status: "held", action: "partial_target_deferred", reason: "atomic_protective_resize_unavailable" };
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
    const exitQty = Number(existing.qty);
    const sell = await robinhoodAdapter().submitOrder({ symbol, side: "sell", qty: exitQty, type: "market", env: "live" });
    if (!sell.ok) {
      await reportIssue({
        issueKey: `leveraged-live-exit-failed:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} exit order FAILED`, detail: `action=${decision.action}, qty=${exitQty}: ${sell.error}`,
      }, supabase);
      return { status: "error", reason: `exit_submit_failed: ${sell.error}` };
    }
    let confirmedPrice: number | null = null;
    for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
      await sleep(FILL_POLL_DELAY_MS);
      const state = await robinhoodAdapter().getOrder(sell.brokerOrderId!, "live");
      if (state.ok && state.status === "filled" && state.filledQty === exitQty && state.avgFillPrice && state.avgFillPrice > 0) {
        confirmedPrice = state.avgFillPrice;
        break;
      }
      if (state.ok && ["canceled", "rejected", "expired", "partially_filled"].includes(state.status ?? "")) break;
    }
    if (confirmedPrice == null) {
      await reportIssue({ issueKey: `leveraged-live-exit-unconfirmed:${symbol}`, severity: "critical", category: "risk",
        title: `LIVE ${symbol} exit is not confirmed after stop cancellation`,
        detail: `brokerOrderId=${sell.brokerOrderId}; manual broker order/holding reconciliation required; no filled trade recorded`,
      }, supabase);
      return { status: "exit_needs_reconcile", brokerOrderId: sell.brokerOrderId };
    }
    await recordBrokerOrder(supabase, { symbol, side: "sell", brokerAccountId: existing.broker_account_id, brokerOrderId: sell.brokerOrderId!, qty: exitQty, avgFillPrice: confirmedPrice });
    const { error: closeErr } = await supabase.from("leveraged_live_positions").update({
      closed_at: new Date().toISOString(), close_reason: decision.action,
      realized_pnl: (confirmedPrice - Number(existing.avg_cost)) * exitQty,
    }).eq("id", existing.id);
    if (closeErr) return { status: "exit_needs_reconcile", reason: `filled_but_ledger_update_failed: ${closeErr.message}` };
    return { status: "exited", action: decision.action, qty: exitQty, brokerOrderId: sell.brokerOrderId, fillPrice: confirmedPrice };
  }

  // ── ENTRY branch ──────────────────────────────────────────────────────
  if (!cfg.entryWindow(new Date(now))) return { status: "no_entry", reason: "outside_entry_window" };

  const { data: sc, error: scErr } = await supabase.from("strategy_config")
    .select("leveraged_live_auto_enabled, app_paused, security_locked, trading_enabled_us, protective_orders_enabled, leveraged_sleeve_live_lease_usd, active_account_us")
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
    deploymentFlagEnabled: LEVERAGED_LIVE_ENABLED,
    liveAutoEnabled: (sc as any).leveraged_live_auto_enabled === true,
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
    getLeveragedExecutableQuote(symbol),
  ]);
  const candles = { ...candleResult, candles: completedSessionCandles(candleResult.candles, "us", new Date(now)) };
  const expectedSession = expectedNewestSession("us", new Date(now));
  const signalSession = candles.candles.at(-1)?.date;
  if (signalSession !== expectedSession) return { status: "no_entry", reason: "stale_candle_evidence" };
  if (candles.candles.length < 60) return { status: "no_entry", reason: "insufficient_candle_history" };
  if (!quote || quote.stale || quote.source !== "robinhood_mcp" || !(quote.price > 0)) return { status: "no_entry", reason: "broker_bid_ask_unavailable_or_stale" };

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
  await recordBrokerOrder(supabase, { symbol, side: "buy", brokerAccountId, brokerOrderId: buy.brokerOrderId, qty: filledQty, avgFillPrice });

  // Record the confirmed holding before touching its stop. If placement or
  // readback is ambiguous, the next run must see the open position rather than
  // attempting a duplicate BUY.
  const { data: opened, error: openedErr } = await supabase.from("leveraged_live_positions").insert({
    symbol, market: "us", broker: "robinhood", broker_account_id: brokerAccountId,
    qty: filledQty, avg_cost: avgFillPrice, current_price: avgFillPrice,
    stop_loss: plan.stop, initial_stop_loss: plan.stop, price_target: plan.target, highest_price: avgFillPrice,
    entry_broker_order_id: buy.brokerOrderId, protective_order_id: null,
    policy_version: plan.version,
    rationale: `LIVE ${symbol} entry: trend-qualified, ATR ${atr.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}`,
  }).select("id").single();
  if (openedErr) {
    await reportIssue({ issueKey: `leveraged-live-bookkeeping-failed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} BUY filled but position ledger insert failed`,
      detail: `brokerOrderId=${buy.brokerOrderId}; ${openedErr.message}; manual reconciliation required`,
    }, supabase);
  }

  // ── Place broker-native protective stop — REQUIRED ──
  const stop = await placeProtectiveStop({
    supabase, symbol, market: "us", broker: "robinhood", brokerAccountId,
    qty: filledQty, entryPrice: avgFillPrice, stopPrice: plan.stop,
    proposalId: null, proposalBrokerOrderId: buy.brokerOrderId,
  });
  if (!stop.ok && stop.needsReconcile) {
    await reportIssue({ issueKey: `leveraged-live-protective-unresolved:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} protective order needs broker reconciliation`,
      detail: `entryBrokerOrderId=${buy.brokerOrderId}; ${stop.reason}; no flatten submitted because a stop may already be resting`,
    }, supabase);
    return { status: "protective_needs_reconcile", reason: stop.reason, entryBrokerOrderId: buy.brokerOrderId };
  }
  if (!stop.ok) {
    await flattenAndAlert(symbol, filledQty, stop.reason, brokerAccountId, supabase);
    return { status: "flatten_attempted_no_protective_stop", reason: stop.reason, entryBrokerOrderId: buy.brokerOrderId };
  }
  if (openedErr || !opened?.id) {
    await reportIssue({ issueKey: `leveraged-live-bookkeeping-failed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} position filled and stopped but ledger is missing`,
      detail: `brokerOrderId=${buy.brokerOrderId}, protectiveOrderId=${stop.protectiveOrderId}: manual reconciliation required` }, supabase);
    return { status: "error", reason: "position_ledger_missing_manual_reconcile_required", entryBrokerOrderId: buy.brokerOrderId };
  }
  const { error: linkedErr } = await supabase.from("leveraged_live_positions")
    .update({ protective_order_id: stop.protectiveOrderId, updated_at: new Date().toISOString() })
    .eq("id", opened.id);
  if (linkedErr) return { status: "error", reason: `protective_ledger_link_failed: ${linkedErr.message}` };
  await resolveIssue(`leveraged-live-entry-failed:${symbol}`, supabase);
  return { status: "entered", qty: filledQty, entry: avgFillPrice, stop: plan.stop, target: plan.target, brokerOrderId: buy.brokerOrderId, protectiveOrderId: stop.protectiveOrderId };
}
