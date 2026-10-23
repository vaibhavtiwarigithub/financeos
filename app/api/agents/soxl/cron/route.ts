// SOXL paper v3: shared current-session setup and recurring monitoring.
// Legacy symbol-specific live windows remain in the evidence module; this paper
// path uses the shared calendar-aware intraday window and recorded policy version.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { doorQuoteForPlan, doorQuoteNote } from "@/lib/trading/leveraged-door-quote";
import { evaluateLeveragedResearchGate, loadLatestResearchSignal } from "@/lib/trading/leveraged-door-signal";
import { loadTradingMandate } from "@/lib/trading-mandate";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { getLeveragedIntradayQuote } from "@/lib/data/leveraged-intraday-quotes";
import { computeTechnicals, detectBreakdownVeto } from "@/lib/data/technicals";
import { computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import { planSoxlEntry, monitorSoxl, type SoxlPolicy } from "@/lib/trading/soxl-lifecycle";
import { LEVERAGED_SLEEVE_SYMBOLS } from "@/lib/trading/leveraged-sleeve-risk";
import { paperStopFillPrice } from "@/lib/trading/exit-ladder";
import type { SemiconductorHolding } from "@/lib/trading/semiconductor-risk";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { soxlQuoteTime } from "@/lib/trading/soxl-evidence";
import { leveragedPaperEntryWindow as soxlEntryWindow, loadLeveragedIntradaySetup, leveragedPaperSessionOpen, leveragedPaperExitDue } from "@/lib/trading/leveraged-intraday";
import { completedSessionCandles, expectedNewestSession } from "@/lib/data/completed-candles";

const MONITOR_MAX_QUOTE_AGE_MS = 2 * 60 * 1000; // matches SOXL_POLICY.maxQuoteAgeMs below
// This cron fires twice/day (weekdays): ~11:05 ET (entry window + a mid-
// session monitor check) and ~16:15 ET, right after the equity position-
// monitor's own after-close slot, so an open SOXL position gets checked
// against the FULL day's range (dayLow/dayHigh) at least once, not just the
// partial range visible at 11:05am -- a 3x instrument that breaches its stop
// mid-afternoon must not sit unprotected until the next morning's check.
// 26h tolerates that twice-daily cadence plus real slack without silently
// accepting a genuinely stuck cron (a whole missed weekday still re-blocks).
const MONITOR_LIVENESS_MS = 26 * 60 * 60 * 1000;
const AGENT_TYPE = "soxl_cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Most recent PRIOR clean completion of this route, or null if none / stale. */
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
    agent_type: AGENT_TYPE, market: "us", status, symbols: ["SOXL"],
    trigger_source: "scheduled", started_at: nowIso, completed_at: nowIso,
    result_summary: summary.slice(0, 500),
  } as any);
    if (error) console.error(`[soxl] liveness row write failed: ${error.message}`);
  } catch (e) { console.error(`[soxl] liveness row write threw: ${String(e)}`); } // bookkeeping must never break the real response
}

const NO_AV_FALLBACK = async () => [];

// Experimental initial parameters (not learned, not claimed optimal — spec
// 1.C). SOXL is 3x semiconductor beta; these are deliberately tighter than a
// core-equity swing policy: a 30-min max quote age (vs 15 for the generic
// monitor) accepts this cron's daily cadence, a 2x ATR stop and 3x ATR target
// give a nominal 1:1.5 geometry without a manufactured floor, and 12% is half
// the 25% max used for core equity stop rejection (semiconductorCapacity
// separately enforces the 5% NAV notional ceiling via SOXL_MAX_NAV_FRACTION).
const SOXL_POLICY: SoxlPolicy = {
  version: "soxl-paper-intraday-v3",
  maxQuoteAgeMs: 2 * 60 * 1000,
  maxSpreadBps: 50,
  maxMonitorAgeMs: 10 * 60 * 1000, // monitorSoxl unused for now; kept for planSoxlEntry's shape
  atrStopMultiple: 2,
  maxStopPct: 12,
  targetAtrMultiple: 3,
  riskBudgetPct: 1,
  semiconductorCapPct: 25,
};

// Curated set mirrors lib/trading/semiconductor-risk.ts's DIRECT list, kept
// as the first (fastest, always-true) check. Full-book classification below
// (symbol_profiles.sector) is the real source now -- this set only short-
// circuits it and covers the handful of tickers whose symbol_profiles row
// might be missing or stale.
const KNOWN_SEMICONDUCTOR = new Set(["SOXL", "SOXX", "SMH", "ARM", "NVDA", "AMD", "AVGO", "MU", "INTC", "QCOM", "TSM", "MRVL", "AMAT", "LRCX", "KLAC", "ASML", "ADI", "TXN", "MCHP", "ON", "MPWR"]);

// Liquidity/vol floors, also experimental (spec 1.A: "timestamped ...
// volatility, liquidity" evidence). SOXL trades tens of millions of shares/day
// normally; $10M is a low bar meant to catch a genuinely broken feed, not to
// be a meaningful discriminator.
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
  if (!leveragedPaperSessionOpen(new Date(now))) {
    return NextResponse.json({ status: "no_entry", reason: "outside_regular_session" });
  }
  const priorMonitorVerifiedAt = await lastVerifiedMonitorAt(supabase, now);
  const result = await runSoxlCron(supabase, now, priorMonitorVerifiedAt);
  await recordRun(supabase, result.runStatus, result.summary);
  return NextResponse.json(result.body, { status: result.httpStatus });
}

// pg_cron reaches agents through kairos_call_agent, which always sends POST (its `method` argument
// is ignored), so the doors answered 405 and never ran. Same handler, same cron-secret gate.
export const POST = GET;

async function runSoxlCron(supabase: ReturnType<typeof createServiceClient>, now: number, priorMonitorVerifiedAt: number | null): Promise<RunResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("paper_positions")
    .select("id, qty, avg_cost, current_price, stop_loss, initial_stop_loss, highest_price, price_target, entry_policy_version, opened_at")
    .eq("symbol", "SOXL").eq("market", "us").eq("position_role", "soxl_paper").maybeSingle();
  if (existingErr) return fail({ status: "error", reason: `existing_position_query_failed: ${existingErr.message}` });
  if (existing) {
    const monitorQuote = await getLeveragedIntradayQuote("SOXL");
    // Venue events can arrive during I/O. Validate against decision time, not request start.
    now = Date.now();
    const decision = monitorSoxl({
      now,
      maxQuoteAgeMs: MONITOR_MAX_QUOTE_AGE_MS,
      quote: {
        price: monitorQuote.source === "unavailable" ? NaN : monitorQuote.price,
        dayLow: null, dayHigh: null,
        observedAt: soxlQuoteTime(monitorQuote, now),
      },
      position: {
        market: "us", qty: Number(existing.qty), avgEntry: Number(existing.avg_cost),
        priceTarget: existing.price_target == null ? null : Number(existing.price_target),
        initialStopLoss: existing.initial_stop_loss == null ? null : Number(existing.initial_stop_loss),
        currentStop: existing.stop_loss == null ? null : Number(existing.stop_loss),
        highestPrice: existing.highest_price == null ? null : Number(existing.highest_price),
        partialTaken: existing.price_target == null, // paper clears price_target after a partial (see exit-ladder.ts) — a remaining runner cannot re-fire it
      },
      thesisInvalidated: false, // see route header comment
    });

    if (decision.action === "data_unavailable" || decision.action === "invalid_position") {
      await reportIssue({
        issueKey: "soxl-monitor-failed", severity: "warn", category: "risk",
        title: `SOXL paper position could not be monitored (${decision.action})`,
        detail: `positionId=${existing.id}, quoteSource=${monitorQuote.source}, stale=${monitorQuote.stale}`,
      }, supabase);
      // A stale/failed monitor is not pipeline liveness -- record it as a
      // failed run so entry stays blocked rather than crediting this cycle.
      return fail({ status: "monitor_failed", reason: decision.action, positionId: existing.id }, 200);
    }
    await resolveIssue("soxl-monitor-failed", supabase);

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

    // stop_full / target_full / partial_target / thesis_full: reuses the
    // existing, already position-role-generic execute_paper_exit RPC.
    const isStop = decision.action === "stop_full";
    const fillPrice = isStop ? paperStopFillPrice(monitorQuote.price, decision.trailingStop) : monitorQuote.price;
    const exitReason = isStop ? "soxl_stop_hit"
      : sessionExit ? "soxl_intraday_session_end"
      : decision.action === "partial_target" ? "soxl_partial_target"
      : decision.action === "thesis_full" ? "soxl_thesis_invalidated"
      : "soxl_target_hit";
    const { data: exitResult, error: exitErr } = await supabase.rpc("execute_paper_exit", {
      p_position_id: existing.id, p_exit_price: fillPrice, p_exit_reason: exitReason,
      p_exit_qty: !sessionExit && decision.action === "partial_target" ? decision.exitQty : null,
      p_partial_stop_loss: !sessionExit && decision.action === "partial_target" ? decision.runnerStop : null,
    });
    if (exitErr) {
      await reportIssue({ issueKey: "soxl-exit-failed", severity: "critical", category: "risk", title: "SOXL paper exit RPC failed", detail: `positionId=${existing.id}: ${exitErr.message}` }, supabase);
      return fail({ status: "error", reason: `exit_rpc_failed: ${exitErr.message}` });
    }
    const exit = exitResult as any;
    if (!exit?.ok) return fail({ status: "error", reason: `exit_denied: ${exit?.error ?? "unknown"}` });
    return ok({ monitorVerified: true, status: "exited", action: sessionExit ? "session_end_full" : decision.action, positionId: existing.id, fillPrice, closedQty: exit.closed_qty, remainingQty: exit.remaining_qty, realizedPnl: exit.realized_pnl });
  }

  if (!soxlEntryWindow(new Date(now))) {
    const probe = await getLeveragedIntradayQuote("SOXL");
    now = Date.now();
    if (!Number.isFinite(soxlQuoteTime(probe, now)) || now - soxlQuoteTime(probe, now) > MONITOR_MAX_QUOTE_AGE_MS) return fail({ status: "monitor_failed", reason: "quote_unavailable_or_stale" }, 200);
    return ok({ status: "no_entry", reason: "outside_entry_window", monitorVerified: true });
  }
  const [candleResult, quote] = await Promise.all([
    fetchUsCandles("SOXL", NO_AV_FALLBACK).catch(() => ({ candles: [], source: "unavailable" as const })),
    getLeveragedIntradayQuote("SOXL"),
  ]);
  now = Date.now();
  if (!soxlEntryWindow(new Date(now))) return ok({ status: "no_entry", reason: "outside_entry_window" });
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

  const intraday = await loadLeveragedIntradaySetup("SOXL");
  if (intraday.state === "unavailable") {
    await reportIssue({ issueKey: "leveraged-intraday-data:soxl", severity: "warn", category: "data",
      title: "SOXL current-session setup unavailable", detail: intraday.reason }, supabase);
    return fail({ status: "no_entry", reason: intraday.reason, policy: intraday.policy }, 200);
  }
  await resolveIssue("leveraged-intraday-data:soxl", supabase);
  if (intraday.state !== "ready") return ok({ status: "no_entry", monitorVerified: Number.isFinite(soxlQuoteTime(quote, Date.now())) && Date.now() - soxlQuoteTime(quote, Date.now()) <= MONITOR_MAX_QUOTE_AGE_MS, reason: intraday.reason, setup: intraday.evidence });
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
    return ok({ status: "no_entry", monitorVerified: Number.isFinite(soxlQuoteTime(quote, Date.now())) && Date.now() - soxlQuoteTime(quote, Date.now()) <= MONITOR_MAX_QUOTE_AGE_MS, reason: "intraday_setup_reversed" });
  const atr = technicals.atr14;
  // Structural stop: swing low over the last 10 sessions. An explicit,
  // deliberately simple initial choice — not fit to anything, not claimed
  // optimal (spec 1.C).
  const swingLow = intraday.structuralStop;

  // A read failure cannot be mistaken for "never exited". The completed
  // candle session must postdate the last closed lot before re-entry.
  const { data: lastExit, error: lastExitError } = await supabase
    .from("paper_trades")
    .select("closed_at")
    .eq("symbol", "SOXL").eq("market", "us").eq("position_role", "soxl_paper")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();
  if (lastExitError) return fail({ status: "error", reason: "last_exit_query_failed" });
  const lastExitAt = lastExit?.closed_at ? new Date(lastExit.closed_at as string).getTime() : null;

  const { data: portfolio, error: portfolioErr } = await supabase
    .from("paper_portfolio").select("nav, cash_balance, updated_at").eq("market", "us").maybeSingle();
  if (portfolioErr || !portfolio) return fail({ status: "error", reason: `portfolio_query_failed: ${portfolioErr?.message ?? "not_found"}` });
  const { data: positions, error: positionsErr } = await supabase
    .from("paper_positions").select("symbol, qty, current_price").eq("market", "us");
  if (positionsErr) return fail({ status: "error", reason: `positions_query_failed: ${positionsErr.message}` });
  // Real per-symbol classification (2026-09-23), not just the curated
  // semiconductor list: symbol_profiles.sector already covers the whole
  // book (the same table app/api/agents/edge-ic/route.ts trusts). Verified
  // against production -- it correctly has sector='Semiconductors' for SKHY,
  // a real semiconductor holding KNOWN_SEMICONDUCTOR's static list was
  // missing entirely. A symbol with a real, non-'N/A' sector that ISN'T
  // Semiconductors is confidently false (known non-semiconductor exposure);
  // only a symbol with no row here AND not in KNOWN_SEMICONDUCTOR stays
  // null and correctly fails closed in semiconductorCapacity.
  const bookSymbols = [...new Set((positions ?? []).map((p: any) => String(p.symbol).toUpperCase()))];
  const { data: sectorRows } = await supabase
    .from("symbol_profiles").select("symbol, sector").eq("market", "us").in("symbol", bookSymbols);
  const sectorBySymbol = new Map((sectorRows ?? []).map((r: any) => [String(r.symbol).toUpperCase(), String(r.sector ?? "")]));
  const holdings: SemiconductorHolding[] = (positions ?? []).map((p: any) => {
    const sym = String(p.symbol).toUpperCase();
    const sector = sectorBySymbol.get(sym);
    const semiconductor = KNOWN_SEMICONDUCTOR.has(sym) || sector === "Semiconductors" ? true
      : sector != null && sector !== "" && sector !== "N/A" ? false
      : null;
    return { symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? 0), semiconductor };
  });

  // Routed design: research must currently endorse this symbol (see lib/trading/leveraged-door-signal.ts).
  const [{ signal: researchSignal, error: researchSignalError }, mandate] = await Promise.all([
    loadLatestResearchSignal(supabase, "SOXL"),
    loadTradingMandate(supabase, "us"),
  ]);
  if (researchSignalError) return fail({ status: "error", reason: `research_signal_query_failed: ${researchSignalError}` });
  // Recheck quote, signal, liveness and entry window after all evidence reads.
  now = Date.now();
  const researchGate = evaluateLeveragedResearchGate(researchSignal, { threshold: mandate.score_threshold, now, intradayQualified: intraday.state === "ready" });
  if (!researchGate.ok) return ok({ status: "no_entry", reason: `research_gate:${researchGate.reason}`, monitorVerified: Number.isFinite(soxlQuoteTime(quote, now)) && now - soxlQuoteTime(quote, now) <= MONITOR_MAX_QUOTE_AGE_MS });
  // Real bid/ask when the provider has one; otherwise a modeled conservative spread (paper only).
  const doorQuote = doorQuoteForPlan({ bid: quote.bid, ask: quote.ask, price: quote.price }, soxlQuoteTime(quote, now));

  const plan = planSoxlEntry({
    policy: SOXL_POLICY,
    now,
    quote: doorQuote,
    // Daily evidence cannot become a new post-exit setup merely by being fetched again.
    signalAt: intraday.signalAt,
    lastExitAt,
    signalSession,
    expectedSignalSession: expectedSession,
    entryWindowOpen: soxlEntryWindow(new Date(now)),
    // Real liveness proof (2026-09-22): the most recent PRIOR clean
    // completion of this route, from agent_runs, or NaN if none exists or
    // it's gone stale (see lastVerifiedMonitorAt / MONITOR_LIVENESS_MS at
    // the top of this file). NaN correctly fails planSoxlEntry's freshness
    // check and blocks entry -- this is not asserted, it's read back from a
    // durable prior run.
    monitorVerifiedAt: priorMonitorVerifiedAt ?? NaN,
    trendQualified,
    atr: atr ?? 0,
    structuralStop: swingLow,
    nav: Number(portfolio.nav ?? 0),
    cash: Number(portfolio.cash_balance ?? 0),
    holdings,
    leveragedSleevePositions: (positions ?? [])
      .filter((p: any) => LEVERAGED_SLEEVE_SYMBOLS.has(String(p.symbol).toUpperCase()))
      .map((p: any) => ({ symbol: String(p.symbol), marketValue: Number(p.qty ?? 0) * Number(p.current_price ?? 0) })),
  });

  if (!plan.ok) {
    await resolveIssue("soxl-entry-cron-failed", supabase);
    return ok({ status: "no_entry", reason: plan.reason, monitorVerified: Number.isFinite(soxlQuoteTime(quote, now)) && now - soxlQuoteTime(quote, now) <= MONITOR_MAX_QUOTE_AGE_MS });
  }

  const qty = plan.maxNotional / plan.entry;
  if (!(qty > 0)) return ok({ status: "no_entry", reason: "zero_capacity" });

  const { data: rpcResult, error: rpcErr } = await supabase.rpc("execute_soxl_paper_fill", {
    p_market: "us", p_currency: "USD", p_symbol: "SOXL",
    p_qty: qty, p_fill_price: plan.entry, p_total_cost: qty * plan.entry,
    p_price_source: quote.source, p_price_retrieved_at: quote.observedAt ?? quote.retrievedAt,
    p_bid: quote.bid, p_ask: quote.ask, p_spread: quote.bid && quote.ask ? quote.ask - quote.bid : null,
    p_stop_loss: plan.stop, p_price_target: plan.target,
    p_policy_version: plan.version,
    p_rationale: `SOXL paper entry: trend-qualified breakout, ATR ${atr?.toFixed(2)}, swing-low stop ${swingLow.toFixed(2)}, dollar volume ${features.dollarVolume?.toFixed(0)} [research signal ${researchGate.signalId} score ${researchGate.score}] [setup ${JSON.stringify(intraday.evidence)}]${doorQuoteNote(doorQuote, quote.source)}`,
  });
  if (rpcErr) {
    await reportIssue({ issueKey: "soxl-entry-cron-failed", severity: "warn", category: "execution", title: "SOXL paper entry RPC failed", detail: rpcErr.message }, supabase);
    return fail({ status: "error", reason: `rpc_failed: ${rpcErr.message}` });
  }
  const result = rpcResult as any;
  if (!result?.ok) {
    return ok({ status: "no_entry", reason: result?.error ?? "rpc_denied" });
  }
  await resolveIssue("soxl-entry-cron-failed", supabase);
  return ok({ status: "entered", qty, entry: plan.entry, stop: plan.stop, target: plan.target, tradeId: result.trade_id });
}
