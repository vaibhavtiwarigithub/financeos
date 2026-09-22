// SOXL paper cron: entry when flat, monitor+exit when held.
// Owner-approved 2026-09-22: automatic PAPER trading for SOXL, 5% NAV
// ceiling. Live execution is untouched: this route never reads broker_orders
// and calls no broker adapter. lib/trading/symbol-policy.ts's generic
// leveraged/inverse block still applies to every other path (research
// candidate selection, the mandate-driven paper-trade route, the live
// execution gateway) — this cron is SOXL's own, deliberately separate door,
// not a hole punched in the shared gate.
//
// Monitoring reuses the SAME price + session dayLow/dayHigh convention as
// app/api/agents/position-monitor/route.ts (never bid/ask — production
// quotes essentially never carry them; see lib/data/quotes.ts's Massive
// 403-entitlement note). lib/trading/soxl-lifecycle.ts's SoxlMonitorQuote
// was fixed to match that contract instead of requiring bid/ask (which this
// route originally, incorrectly, synthesized from price alone — that would
// have silently skipped every intraday stop/target touch). Exits reuse the
// existing execute_paper_exit RPC unchanged (already position-role-generic).
//
// Deliberately deferred, not silent: thesisInvalidated is always passed as
// false. There's no built "is the SOXL thesis still valid" signal distinct
// from the entry trend check, and the spec's own instruction is that STALE
// thesis evidence must never authorize an exit — so rather than reuse the
// entry trend check (computed fresh each run, not a persisted "thesis") as a
// proxy, this route relies on the mechanical stop/target/trail ladder alone
// until a real thesis-freshness signal exists.
//
// lastExitAt (2026-09-22): now reads the real last-closed-lot timestamp
// instead of a hardcoded null. Currently a no-op in practice — this cron
// always uses now() as signalAt, so a fresh check always postdates any past
// exit — but it stops being inert the moment a real signal-generation
// timestamp (distinct from "checked at") is introduced.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { getQuote } from "@/lib/data/quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { planSoxlEntry, monitorSoxl, type SoxlPolicy } from "@/lib/trading/soxl-lifecycle";
import { paperStopFillPrice } from "@/lib/trading/exit-ladder";
import type { SemiconductorHolding } from "@/lib/trading/semiconductor-risk";
import { reportIssue, resolveIssue } from "@/lib/system-health";

const MONITOR_MAX_QUOTE_AGE_MS = 30 * 60 * 1000; // matches SOXL_POLICY.maxQuoteAgeMs below

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_AV_FALLBACK = async () => [];

// Experimental initial parameters (not learned, not claimed optimal — spec
// 1.C). SOXL is 3x semiconductor beta; these are deliberately tighter than a
// core-equity swing policy: a 30-min max quote age (vs 15 for the generic
// monitor) accepts this cron's daily cadence, a 2x ATR stop and 3x ATR target
// give a nominal 1:1.5 geometry without a manufactured floor, and 12% is half
// the 25% max used for core equity stop rejection (semiconductorCapacity
// separately enforces the 5% NAV notional ceiling via SOXL_MAX_NAV_FRACTION).
const SOXL_POLICY: SoxlPolicy = {
  version: "soxl-paper-entry-v1",
  maxQuoteAgeMs: 30 * 60 * 1000,
  maxSpreadBps: 50,
  maxMonitorAgeMs: 24 * 60 * 60 * 1000, // monitorSoxl unused for now; kept for planSoxlEntry's shape
  atrStopMultiple: 2,
  maxStopPct: 12,
  targetAtrMultiple: 3,
  riskBudgetPct: 1,
  semiconductorCapPct: 25,
};

// Curated set mirrors lib/trading/semiconductor-risk.ts's DIRECT list — a
// known, incomplete static universe (see that module's own top comment).
// Anything outside it is passed as semiconductor:false, which is correct for
// every symbol in the current US book today but will silently under-count a
// name the list hasn't caught up to. Flagged, not solved, here.
const KNOWN_SEMICONDUCTOR = new Set(["SOXL", "SOXX", "SMH", "ARM", "NVDA", "AMD", "AVGO", "MU", "INTC", "QCOM", "TSM", "MRVL", "AMAT", "LRCX", "KLAC", "ASML", "ADI", "TXN", "MCHP", "ON", "MPWR"]);

// Liquidity/vol floors, also experimental (spec 1.A: "timestamped ...
// volatility, liquidity" evidence). SOXL trades tens of millions of shares/day
// normally; $10M is a low bar meant to catch a genuinely broken feed, not to
// be a meaningful discriminator.
const MIN_DOLLAR_VOLUME = 10_000_000;

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = Date.now();

  const { data: existing, error: existingErr } = await supabase
    .from("paper_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, initial_stop_loss, highest_price, price_target")
    .eq("symbol", "SOXL").eq("market", "us").eq("position_role", "soxl_paper").maybeSingle();
  if (existingErr) return NextResponse.json({ status: "error", reason: `existing_position_query_failed: ${existingErr.message}` }, { status: 500 });
  if (existing) {
    const monitorQuote = await getQuote("SOXL", supabase);
    const decision = monitorSoxl({
      now,
      maxQuoteAgeMs: MONITOR_MAX_QUOTE_AGE_MS,
      quote: {
        price: monitorQuote.source === "unavailable" ? NaN : monitorQuote.price,
        dayLow: monitorQuote.dayLow ?? null, dayHigh: monitorQuote.dayHigh ?? null,
        observedAt: new Date(monitorQuote.retrievedAt).getTime(),
      },
      position: {
        market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
        priceTarget: existing.price_target == null ? null : Number(existing.price_target),
        initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
        currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
        highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
        partialTaken: false, // paper clears price_target after a partial (see exit-ladder.ts) — a remaining runner cannot re-fire it
      },
      thesisInvalidated: false, // see route header comment
    });

    if (decision.action === "data_unavailable" || decision.action === "invalid_position") {
      await reportIssue({
        issueKey: "soxl-monitor-failed", severity: "warn", category: "risk",
        title: `SOXL paper position could not be monitored (${decision.action})`,
        detail: `positionId=${existing.id}, quoteSource=${monitorQuote.source}, stale=${monitorQuote.stale}`,
      }, supabase);
      return NextResponse.json({ status: "monitor_failed", reason: decision.action, positionId: existing.id });
    }
    await resolveIssue("soxl-monitor-failed", supabase);

    if (decision.action === "none" || decision.action === "runner_hold") {
      await supabase.from("paper_positions").update({
        current_price: monitorQuote.price,
        highest_price: decision.highestPrice,
        stop_loss: parseFloat(decision.trailingStop.toFixed(2)),
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      return NextResponse.json({ status: "held", action: decision.action, positionId: existing.id, trailingStop: decision.trailingStop });
    }

    // stop_full / target_full / partial_target / thesis_full: reuses the
    // existing, already position-role-generic execute_paper_exit RPC.
    const isStop = decision.action === "stop_full";
    const fillPrice = isStop ? paperStopFillPrice(monitorQuote.price, decision.trailingStop) : monitorQuote.price;
    const exitReason = isStop ? "soxl_stop_hit"
      : decision.action === "partial_target" ? "soxl_partial_target"
      : decision.action === "thesis_full" ? "soxl_thesis_invalidated"
      : "soxl_target_hit";
    const { data: exitResult, error: exitErr } = await supabase.rpc("execute_paper_exit", {
      p_position_id: existing.id, p_exit_price: fillPrice, p_exit_reason: exitReason,
      p_exit_qty: decision.action === "partial_target" ? decision.exitQty : null,
      p_partial_stop_loss: decision.action === "partial_target" ? decision.runnerStop : null,
    });
    if (exitErr) {
      await reportIssue({ issueKey: "soxl-exit-failed", severity: "critical", category: "risk", title: "SOXL paper exit RPC failed", detail: `positionId=${existing.id}: ${exitErr.message}` }, supabase);
      return NextResponse.json({ status: "error", reason: `exit_rpc_failed: ${exitErr.message}` }, { status: 500 });
    }
    const exit = exitResult as any;
    if (!exit?.ok) return NextResponse.json({ status: "error", reason: `exit_denied: ${exit?.error ?? "unknown"}` }, { status: 500 });
    return NextResponse.json({ status: "exited", action: decision.action, positionId: existing.id, fillPrice, closedQty: exit.closed_qty, remainingQty: exit.remaining_qty, realizedPnl: exit.realized_pnl });
  }

  const [candles, quote] = await Promise.all([
    fetchUsCandles("SOXL", NO_AV_FALLBACK).catch(() => ({ candles: [], source: "unavailable" as const })),
    getQuote("SOXL", supabase),
  ]);
  if (candles.candles.length < 60) {
    return NextResponse.json({ status: "no_entry", reason: "insufficient_candle_history", dataPoints: candles.candles.length });
  }
  if (quote.source === "unavailable" || quote.stale || !(quote.price > 0)) {
    return NextResponse.json({ status: "no_entry", reason: "quote_unavailable_or_stale", source: quote.source });
  }

  const technicals = computeTechnicals(candles.candles);
  const veto = detectBreakdownVeto(technicals);
  const trendQualified = !veto.vetoed
    && technicals.priceVsEma20 === "above" && technicals.priceVsEma50 === "above" && technicals.trend20d === "up";
  const features = computeLeveragedShadowFeatures(candles.candles);
  if (features.dollarVolume == null || features.dollarVolume < MIN_DOLLAR_VOLUME) {
    return NextResponse.json({ status: "no_entry", reason: "liquidity_floor_not_met", dollarVolume: features.dollarVolume });
  }
  const atr = technicals.atr14;
  const lastClose = candles.candles[candles.candles.length - 1]?.close ?? 0;
  // Structural stop: swing low over the last 10 sessions. An explicit,
  // deliberately simple initial choice — not fit to anything, not claimed
  // optimal (spec 1.C).
  const swingLow = Math.min(...candles.candles.slice(-10).map(c => c.low));

  // Real last-exit tracking (was hardcoded null): the most recent closed
  // soxl_paper lot's exit timestamp. planSoxlEntry rejects a signal whose
  // signalAt <= lastExitAt, so this only matters if a future caller passes a
  // genuine signal-generation timestamp distinct from "now" — this cron
  // currently always uses now() as signalAt, so the check is a no-op today,
  // but wiring the real value means it starts protecting the moment that
  // changes instead of silently staying inert.
  const { data: lastExit } = await supabase
    .from("paper_trades")
    .select("closed_at")
    .eq("symbol", "SOXL").eq("market", "us").eq("position_role", "soxl_paper")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();
  const lastExitAt = lastExit?.closed_at ? new Date(lastExit.closed_at as string).getTime() : null;

  const { data: portfolio, error: portfolioErr } = await supabase
    .from("paper_portfolio").select("nav, cash_balance, updated_at").eq("market", "us").maybeSingle();
  if (portfolioErr || !portfolio) return NextResponse.json({ status: "error", reason: `portfolio_query_failed: ${portfolioErr?.message ?? "not_found"}` }, { status: 500 });
  const { data: positions, error: positionsErr } = await supabase
    .from("paper_positions").select("symbol, qty, current_price").eq("market", "us");
  if (positionsErr) return NextResponse.json({ status: "error", reason: `positions_query_failed: ${positionsErr.message}` }, { status: 500 });
  const holdings: SemiconductorHolding[] = (positions ?? []).map((p: any) => ({
    symbol: String(p.symbol),
    marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? 0),
    semiconductor: KNOWN_SEMICONDUCTOR.has(String(p.symbol).toUpperCase()),
  }));

  const plan = planSoxlEntry({
    policy: SOXL_POLICY,
    now,
    quote: { bid: quote.bid ?? quote.price, ask: quote.ask ?? quote.price, observedAt: new Date(quote.retrievedAt).getTime() },
    signalAt: now,
    lastExitAt,
    signalSession: new Date(now).toISOString().slice(0, 10),
    expectedSignalSession: new Date(now).toISOString().slice(0, 10),
    entryWindowOpen: true,
    monitorVerifiedAt: now,
    trendQualified,
    atr: atr ?? 0,
    structuralStop: swingLow,
    nav: Number(portfolio.nav ?? 0),
    cash: Number(portfolio.cash_balance ?? 0),
    holdings,
  });

  if (!plan.ok) {
    await resolveIssue("soxl-entry-cron-failed", supabase);
    return NextResponse.json({ status: "no_entry", reason: plan.reason });
  }

  const qty = plan.maxNotional / plan.entry;
  if (!(qty > 0)) return NextResponse.json({ status: "no_entry", reason: "zero_capacity" });

  const { data: rpcResult, error: rpcErr } = await supabase.rpc("execute_soxl_paper_fill", {
    p_market: "us", p_currency: "USD", p_symbol: "SOXL",
    p_qty: qty, p_fill_price: plan.entry, p_total_cost: qty * plan.entry,
    p_price_source: quote.source, p_price_retrieved_at: quote.retrievedAt,
    p_bid: quote.bid, p_ask: quote.ask, p_spread: quote.bid && quote.ask ? quote.ask - quote.bid : null,
    p_stop_loss: plan.stop, p_price_target: plan.target,
    p_policy_version: plan.version,
    p_rationale: `SOXL paper entry: trend-qualified breakout, ATR ${atr?.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}, dollar volume ${features.dollarVolume?.toFixed(0)}`,
  });
  if (rpcErr) {
    await reportIssue({ issueKey: "soxl-entry-cron-failed", severity: "warn", category: "execution", title: "SOXL paper entry RPC failed", detail: rpcErr.message }, supabase);
    return NextResponse.json({ status: "error", reason: `rpc_failed: ${rpcErr.message}` }, { status: 500 });
  }
  const result = rpcResult as any;
  if (!result?.ok) {
    return NextResponse.json({ status: "no_entry", reason: result?.error ?? "rpc_denied" });
  }
  await resolveIssue("soxl-entry-cron-failed", supabase);
  return NextResponse.json({ status: "entered", qty, entry: plan.entry, stop: plan.stop, target: plan.target, tradeId: result.trade_id });
}
