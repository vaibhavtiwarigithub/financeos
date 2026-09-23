// L4 live-trading cron for crypto (BTC/ETH/SOL). Mirrors
// app/api/agents/leveraged-live/cron/route.ts's structure and safety
// discipline exactly, adapted for crypto's own broker mechanism
// (placeRobinhoodCryptoOrder, a real stop_price field confirmed via the
// capability probe 2026-09-23) and its own entry trigger (the SAME
// crypto_native_shadow_v1 agent_signals crypto paper trading already uses).
//
// SAFE BY DEFAULT, MULTIPLE INDEPENDENT WAYS: CRYPTO_LIVE_ENABLED (env,
// false unless set — its own flag, decoupled from LEVERAGED_LIVE_ENABLED
// and AUTONOMOUS_LIVE_ENABLED), strategy_config.crypto_live_auto_enabled
// (DB, false), strategy_config.crypto_live_lease_usd (DB, defaults to 0 =
// zero capacity), a live Robinhood crypto account-eligibility check every
// run. ALL of these must be true/nonzero before this route can submit a
// single real order — see lib/trading/crypto-live-kernel.ts.
//
// No live order is ever submitted without a CONFIRMED, broker-resting
// protective stop (placeRobinhoodCryptoOrder with type="stop"). A failed
// stop placement always flattens the just-opened position rather than
// leaving it naked — same non-negotiable as the leveraged sleeve.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { CRYPTO_LIVE_ENABLED } from "@/lib/autonomy";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";
import { fetchCryptoCandles } from "@/lib/data/crypto-quotes";
import { cryptoCompletedCandles, cryptoSessionDate } from "@/lib/data/crypto-session";
import { deriveCryptoResearchShadow } from "@/lib/scoring/crypto-research-shadow";
import { decideCryptoExit } from "@/lib/trading/crypto-exit-policy";
import { evaluateCryptoLiveEntry } from "@/lib/trading/crypto-live-kernel";
import { planCryptoLiveEntry } from "@/lib/trading/crypto-live-entry";
import { readRobinhoodCryptoExecutionSnapshot, placeRobinhoodCryptoOrder, cancelRobinhoodCryptoOrder, getRobinhoodCryptoOrder } from "@/lib/robinhood-mcp";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const AGENT_TYPE = "crypto_live_cron";
const FILL_POLL_ATTEMPTS = 6;
const FILL_POLL_DELAY_MS = 2000;
const MAX_QUOTE_AGE_MS = 5 * 60 * 1000; // crypto quotes move fast; tighter than equity's 30 min
const MAX_SPREAD_BPS = 80;

const POLICY = {
  riskBudgetPct: 1,
  atrStopMultiple: 2,
  minStopPct: 5,
  maxStopPct: 20,
  rewardRiskMultiple: 1.67,
  expectedRoundTripCostPct: 0.5,
  minNetRewardRisk: 1,
};

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function recordRun(supabase: ReturnType<typeof createServiceClient>, status: "done" | "error", summary: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabase.from("agent_runs").insert({
    agent_type: AGENT_TYPE, market: "crypto", status, symbols: [...CRYPTO_SYMBOLS],
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary.slice(0, 500),
  } as any).catch(() => undefined);
}

/** Same broker_orders logging requirement as the leveraged sleeve (see
 * app/api/agents/leveraged-live/cron/route.ts's own comment) — Manual Trade
 * Guardian diffs live holdings against this table. Crypto isn't currently
 * covered by Guardian's own holdings read (equity-only), but logging here
 * keeps the ledger consistent and ready for when it is. */
async function recordBrokerOrder(
  supabase: ReturnType<typeof createServiceClient>,
  input: { symbol: string; side: "buy" | "sell"; brokerAccountId: string; brokerOrderId: string; qty: number; avgFillPrice: number | null },
) {
  await supabase.from("broker_orders").insert({
    market: "crypto", broker: "robinhood", broker_env: "live", broker_account_id: input.brokerAccountId,
    symbol: input.symbol, side: input.side, qty: input.qty, order_type: "market",
    status: "filled", broker_order_id: input.brokerOrderId, submitted_at: new Date().toISOString(),
    filled_qty: input.qty, avg_fill_price: input.avgFillPrice, approved_by_user: false,
    learning_scope: "risk_policy_only",
  } as any).catch(() => undefined);
}

async function flattenAndAlert(symbol: string, qty: number, reason: string, brokerAccountId: string, supabase: ReturnType<typeof createServiceClient>) {
  const sell = await placeRobinhoodCryptoOrder({ account: brokerAccountId, symbol, side: "sell", quantity: qty, type: "market" });
  if (sell.ok) {
    await recordBrokerOrder(supabase, { symbol, side: "sell", brokerAccountId, brokerOrderId: sell.brokerOrderId, qty, avgFillPrice: null });
  }
  await reportIssue({
    issueKey: `crypto-live-naked-entry:${symbol}`, severity: "critical", category: "risk",
    title: `LIVE ${symbol} crypto entry flattened — protective stop could not be confirmed`,
    detail: `reason=${reason}; flatten sell ${sell.ok ? `submitted, brokerOrderId=${sell.brokerOrderId}` : `FAILED: ${sell.error}`}`,
  }, supabase);
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const results: Record<string, unknown> = {};
  let anyError = false;
  for (const symbol of [...CRYPTO_SYMBOLS]) {
    try {
      results[symbol] = await runSymbol(supabase, symbol);
    } catch (e) {
      anyError = true;
      results[symbol] = { status: "error", reason: String(e instanceof Error ? e.message : e) };
    }
  }
  await recordRun(supabase, anyError ? "error" : "done", JSON.stringify(results));
  return NextResponse.json({ status: "ran", results });
}

async function runSymbol(supabase: ReturnType<typeof createServiceClient>, symbol: string): Promise<Record<string, unknown>> {
  const now = Date.now();
  const { data: existing, error: existingErr } = await supabase
    .from("crypto_live_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, price_target, highest_price, broker_account_id, stop_broker_order_id, stop_status")
    .eq("symbol", symbol).is("closed_at", null).maybeSingle();
  if (existingErr) return { status: "error", reason: `existing_position_query_failed: ${existingErr.message}` };

  let avKey: string | null = null;
  try {
    const { data: vaultRow } = await supabase.from("api_key_vault").select("key_value").eq("key_name", "ALPHA_VANTAGE_API_KEY").maybeSingle();
    avKey = (vaultRow as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? null;
  } catch { avKey = process.env.ALPHA_VANTAGE_API_KEY ?? null; }

  // ── MONITOR branch ────────────────────────────────────────────────────
  if (existing) {
    // Reconcile the resting broker stop before anything else — if it's no
    // longer active (filled, cancelled externally, or was never confirmed),
    // this position is unprotected and must be flattened, not left waiting
    // for the next daily check.
    if (existing.stop_broker_order_id && existing.stop_status === "active") {
      const state = await getRobinhoodCryptoOrder(existing.stop_broker_order_id);
      if (state.ok && state.status === "filled") {
        // The broker stop itself closed the position — record it and stop.
        await supabase.from("crypto_live_positions").update({
          closed_at: new Date().toISOString(), close_reason: "broker_stop_filled",
          realized_pnl: ((state.avgFillPrice ?? Number(existing.stop_loss)) - Number(existing.avg_cost)) * Number(existing.qty),
        }).eq("id", existing.id);
        return { status: "exited", action: "broker_stop_filled" };
      }
      if (state.ok && !["queued", "open", "unconfirmed", "confirmed"].includes(state.status)) {
        await flattenAndAlert(symbol, Number(existing.qty), `stop_no_longer_active:${state.status}`, existing.broker_account_id, supabase);
        await supabase.from("crypto_live_positions").update({
          closed_at: new Date().toISOString(), close_reason: `stop_lost:${state.status}`,
        }).eq("id", existing.id);
        return { status: "flattened_stop_lost", brokerStatus: state.status };
      }
    } else if (existing.stop_status !== "active") {
      await flattenAndAlert(symbol, Number(existing.qty), `stop_status_${existing.stop_status}`, existing.broker_account_id, supabase);
      await supabase.from("crypto_live_positions").update({
        closed_at: new Date().toISOString(), close_reason: `stop_status_${existing.stop_status}`,
      }).eq("id", existing.id);
      return { status: "flattened_stop_never_active" };
    }

    // Target check via the same daily-candle evidence crypto paper trading
    // uses. The broker stop protects the downside continuously; this cron
    // only needs to catch a target touch (no broker-side target order).
    if (!avKey) return { status: "monitor_skipped", reason: "no_av_key" };
    const { candles } = await fetchCryptoCandles(symbol, avKey);
    const completed = cryptoCompletedCandles(candles);
    const candle = completed.at(-1);
    if (!candle || candle.date !== cryptoSessionDate() || !(candle.close > 0)) {
      return { status: "monitor_skipped", reason: "stale_or_missing_candle" };
    }
    const exitReason = decideCryptoExit({
      closePrice: candle.close, lowPrice: candle.low, highPrice: candle.high,
      stopLoss: null, // the broker-side stop is the real protection; don't double-exit on app-side stop math
      priceTarget: Number(existing.price_target),
    });
    if (exitReason === "target") {
      const cancel = await cancelRobinhoodCryptoOrder(existing.stop_broker_order_id!, existing.broker_account_id);
      if (!cancel.ok) {
        await reportIssue({ issueKey: `crypto-live-cancel-failed:${symbol}`, severity: "critical", category: "risk",
          title: `LIVE ${symbol} crypto stop cancel failed before target exit`, detail: cancel.error ?? "unknown" }, supabase);
        return { status: "error", reason: `stop_cancel_failed: ${cancel.error}` };
      }
      const sell = await placeRobinhoodCryptoOrder({ account: existing.broker_account_id, symbol, side: "sell", quantity: Number(existing.qty), type: "market" });
      if (!sell.ok) {
        await reportIssue({ issueKey: `crypto-live-exit-failed:${symbol}`, severity: "critical", category: "risk",
          title: `LIVE ${symbol} crypto target-exit order FAILED`, detail: sell.error }, supabase);
        return { status: "error", reason: `exit_submit_failed: ${sell.error}` };
      }
      await recordBrokerOrder(supabase, { symbol, side: "sell", brokerAccountId: existing.broker_account_id, brokerOrderId: sell.brokerOrderId, qty: Number(existing.qty), avgFillPrice: candle.close });
      await supabase.from("crypto_live_positions").update({
        closed_at: new Date().toISOString(), close_reason: "target",
        realized_pnl: (candle.close - Number(existing.avg_cost)) * Number(existing.qty),
      }).eq("id", existing.id);
      return { status: "exited", action: "target", brokerOrderId: sell.brokerOrderId };
    }
    await supabase.from("crypto_live_positions").update({
      current_price: candle.close, highest_price: Math.max(Number(existing.highest_price), candle.high), updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return { status: "held", price: candle.close };
  }

  // ── ENTRY branch ──────────────────────────────────────────────────────
  const { data: sc, error: scErr } = await supabase.from("strategy_config")
    .select("crypto_live_auto_enabled, app_paused, security_locked, crypto_live_lease_usd, active_account_us")
    .limit(1).maybeSingle();
  if (scErr || !sc) return { status: "error", reason: `strategy_config_query_failed: ${scErr?.message ?? "not_found"}` };

  const { data: overrideRow } = await supabase.from("crypto_live_overrides").select("min_paper_trades_override").eq("symbol", symbol).maybeSingle();
  const { count: closedPaperCount, error: paperCountErr } = await supabase
    .from("paper_trades").select("*", { count: "exact", head: true })
    .eq("symbol", symbol).eq("market", "crypto").not("closed_at", "is", null);
  if (paperCountErr) return { status: "error", reason: `paper_trade_count_failed: ${paperCountErr.message}` };
  const { count: criticalAlertCount, error: alertErr } = await supabase
    .from("agent_alerts").select("*", { count: "exact", head: true }).eq("resolved", false).eq("severity", "critical");
  if (alertErr) return { status: "error", reason: `alert_count_failed: ${alertErr.message}` };

  const snapshot = await readRobinhoodCryptoExecutionSnapshot([symbol]);
  const pair = snapshot.pairs.get(symbol);

  const gate = evaluateCryptoLiveEntry({
    deploymentFlagEnabled: CRYPTO_LIVE_ENABLED,
    liveAutoEnabled: (sc as any).crypto_live_auto_enabled === true,
    appPaused: (sc as any).app_paused === true,
    securityLocked: (sc as any).security_locked === true,
    leaseUsd: Number((sc as any).crypto_live_lease_usd ?? 0),
    closedPaperTradeCount: closedPaperCount ?? 0,
    minPaperTradesOverride: (overrideRow as any)?.min_paper_trades_override === true,
    openUnresolvedCriticalAlertCount: criticalAlertCount ?? 0,
    robinhoodCryptoAccountEligible: snapshot.accountEligible && (pair?.tradeable === true),
  });
  if (!gate.go) return { status: "no_entry", reason: gate.reason, gate: gate.gate };

  const brokerAccountId = (sc as any).active_account_us as string | null;
  if (!brokerAccountId) return { status: "no_entry", reason: "no_active_us_account" };

  // Same entry trigger crypto paper trading uses — the crypto-native shadow
  // score, not equity fundamentals/IC (see lib/scoring/crypto-score.ts).
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: signal, error: sigErr } = await supabase
    .from("agent_signals").select("id, analyst_score, rationale, created_at")
    .eq("market", "us").eq("symbol", symbol).eq("direction", "long").eq("status", "pending")
    .eq("session_validated", true).eq("score_source", "crypto_native_shadow_v1")
    .gte("analyst_score", 60).gte("created_at", since)
    .order("analyst_score", { ascending: false }).limit(1).maybeSingle();
  if (sigErr) return { status: "error", reason: `signal_query_failed: ${sigErr.message}` };
  if (!signal) return { status: "no_entry", reason: "no_qualifying_signal" };

  if (!avKey) return { status: "no_entry", reason: "no_av_key" };
  const { candles } = await fetchCryptoCandles(symbol, avKey);
  const completed = cryptoCompletedCandles(candles);
  const shadow = deriveCryptoResearchShadow(completed);
  if (!shadow || shadow.sessionDate !== cryptoSessionDate()) return { status: "no_entry", reason: "stale_or_insufficient_candle_evidence" };

  const quote = snapshot.quotes.get(symbol);
  if (!quote) return { status: "no_entry", reason: "no_executable_quote" };

  const { data: allOpenLive, error: liveErr } = await supabase
    .from("crypto_live_positions").select("symbol, qty, current_price").is("closed_at", null);
  if (liveErr) return { status: "error", reason: `live_positions_query_failed: ${liveErr.message}` };
  const existingLivePositions = (allOpenLive ?? []).map((p: any) => ({ symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? p.qty ?? 0) }));

  const plan = planCryptoLiveEntry({
    now, quote: { bid: quote.bid, ask: quote.ask, observedAt: Date.parse(quote.observedAt) },
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS, maxSpreadBps: MAX_SPREAD_BPS,
    atrPct: shadow.atrPct, structuralStopPct: shadow.structuralStopPct,
    ...POLICY,
    leaseUsd: Number((sc as any).crypto_live_lease_usd ?? 0), existingLivePositions,
  });
  if (!plan.ok) return { status: "no_entry", reason: plan.reason };

  const qty = plan.maxNotional / plan.entry;
  if (!(qty > 0)) return { status: "no_entry", reason: "zero_capacity" };

  // ── Submit BUY ──────────────────────────────────────────────────────
  const buy = await placeRobinhoodCryptoOrder({ account: brokerAccountId, symbol, side: "buy", quantity: qty, type: "market" });
  if (!buy.ok) {
    await reportIssue({ issueKey: `crypto-live-entry-failed:${symbol}`, severity: "warn", category: "execution",
      title: `LIVE ${symbol} crypto entry order failed`, detail: buy.error }, supabase);
    return { status: "error", reason: `buy_failed: ${buy.error}` };
  }

  // ── Poll for confirmed fill ─────────────────────────────────────────
  let filled = false, filledQty = 0, avgFillPrice = plan.entry;
  for (let i = 0; i < FILL_POLL_ATTEMPTS && !filled; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await getRobinhoodCryptoOrder(buy.brokerOrderId);
    if (state.ok && state.status === "filled" && state.filledQty && state.avgFillPrice) {
      filled = true; filledQty = state.filledQty; avgFillPrice = state.avgFillPrice;
    }
  }
  if (!filled) {
    await reportIssue({ issueKey: `crypto-live-fill-unconfirmed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} crypto BUY fill could not be confirmed`, detail: `brokerOrderId=${buy.brokerOrderId} — MANUAL RECONCILIATION REQUIRED` }, supabase);
    return { status: "error", reason: "fill_unconfirmed_manual_reconcile_required", brokerOrderId: buy.brokerOrderId };
  }
  await recordBrokerOrder(supabase, { symbol, side: "buy", brokerAccountId, brokerOrderId: buy.brokerOrderId, qty: filledQty, avgFillPrice });

  // ── Place broker-native protective stop — REQUIRED, fail-closed flatten ──
  const stop = await placeRobinhoodCryptoOrder({ account: brokerAccountId, symbol, side: "sell", quantity: filledQty, type: "stop", stopPrice: plan.stop });
  if (!stop.ok) {
    await flattenAndAlert(symbol, filledQty, stop.error, brokerAccountId, supabase);
    return { status: "flattened_no_protective_stop", reason: stop.error, entryBrokerOrderId: buy.brokerOrderId };
  }

  const { error: insertErr } = await supabase.from("crypto_live_positions").insert({
    symbol, market: "crypto", broker: "robinhood", broker_account_id: brokerAccountId,
    qty: filledQty, avg_cost: avgFillPrice, current_price: avgFillPrice,
    stop_loss: plan.stop, initial_stop_loss: plan.stop, price_target: plan.target, highest_price: avgFillPrice,
    entry_broker_order_id: buy.brokerOrderId, stop_broker_order_id: stop.brokerOrderId, stop_status: "active",
    policy_version: "crypto-live-entry-v1",
    rationale: `LIVE ${symbol} entry: crypto_native_shadow_v1 signal score=${signal.analyst_score}, ATR ${shadow.atrPct}%, structural stop ${shadow.structuralStopPct}%`,
  });
  if (insertErr) {
    await reportIssue({ issueKey: `crypto-live-bookkeeping-failed:${symbol}`, severity: "critical", category: "risk",
      title: `LIVE ${symbol} crypto position filled and stopped but crypto_live_positions insert FAILED`,
      detail: `brokerOrderId=${buy.brokerOrderId}, stopOrderId=${stop.brokerOrderId}: ${insertErr.message} — MANUAL RECONCILIATION REQUIRED` }, supabase);
    return { status: "error", reason: `bookkeeping_insert_failed: ${insertErr.message}`, entryBrokerOrderId: buy.brokerOrderId };
  }
  await resolveIssue(`crypto-live-entry-failed:${symbol}`, supabase);
  return { status: "entered", qty: filledQty, entry: avgFillPrice, stop: plan.stop, target: plan.target, brokerOrderId: buy.brokerOrderId, stopOrderId: stop.brokerOrderId };
}
