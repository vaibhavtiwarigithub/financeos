import { decideExitLadder, type ExitLadderInput } from "./exit-ladder";
import { semiconductorCapacity, type SemiconductorHolding } from "./semiconductor-risk";

/** Explicit paper experiment contract; thresholds are policy, not learned alpha.
 * A caller must persist the plan atomically with the fill and use the same
 * version for monitoring. This pure module does not submit orders.
 */
export interface SoxlPolicy {
  version: string;
  maxQuoteAgeMs: number;
  maxSpreadBps: number;
  maxMonitorAgeMs: number;
  atrStopMultiple: number;
  maxStopPct: number;
  targetAtrMultiple: number;
  riskBudgetPct: number;
  semiconductorCapPct: number;
}
export interface SoxlQuote { bid: number; ask: number; observedAt: number }

/**
 * Monitor-side quote contract — deliberately NOT SoxlQuote (bid/ask).
 * Production quotes essentially never carry real bid/ask (see the collector
 * route's comment); every other position monitor in this codebase
 * (app/api/agents/position-monitor/route.ts) evaluates stop/target touches
 * from `price` + session dayLow/dayHigh, never bid/ask, and this mirrors that
 * exactly rather than inventing a second contract. `price` is required, low/
 * high are optional (fall back to `price`, i.e. no intraday-touch detection
 * when a session range isn't available — never fabricated).
 */
export interface SoxlMonitorQuote { price: number; dayLow: number | null; dayHigh: number | null; observedAt: number }

function fresh(time: number, now: number, maxAge: number): boolean {
  return Number.isFinite(time) && Number.isFinite(now) && time <= now && now - time <= maxAge;
}

export function planSoxlEntry(input: {
  policy: SoxlPolicy;
  now: number;
  quote: SoxlQuote;
  signalAt: number;
  lastExitAt: number | null;
  signalSession: string;
  expectedSignalSession: string;
  entryWindowOpen: boolean;
  monitorVerifiedAt: number;
  trendQualified: boolean;
  atr: number;
  structuralStop: number;
  nav: number;
  cash: number;
  holdings: SemiconductorHolding[];
}): { ok: false; reason: string } | { ok: true; version: string; entry: number; stop: number; target: number; maxNotional: number; signalAt: number } {
  const p = input.policy;
  if (!p.version || ![p.maxQuoteAgeMs, p.maxSpreadBps, p.maxMonitorAgeMs, p.atrStopMultiple,
    p.maxStopPct, p.targetAtrMultiple, p.riskBudgetPct, p.semiconductorCapPct].every(v => Number.isFinite(v) && v > 0))
    return { ok: false, reason: "invalid_policy" };
  if (!input.entryWindowOpen) return { ok: false, reason: "outside_entry_window" };
  if (!fresh(input.monitorVerifiedAt, input.now, p.maxMonitorAgeMs)) return { ok: false, reason: "monitor_unhealthy" };
  if (!input.signalSession || input.signalSession !== input.expectedSignalSession
    || !Number.isFinite(input.signalAt) || input.signalAt > input.now)
    return { ok: false, reason: "invalid_signal_session" };
  if (input.lastExitAt != null && (!Number.isFinite(input.lastExitAt) || input.signalAt <= input.lastExitAt))
    return { ok: false, reason: "fresh_signal_required_after_exit" };
  if (!input.trendQualified) return { ok: false, reason: "trend_not_qualified" };
  const q = input.quote;
  if (![q.bid, q.ask].every(v => Number.isFinite(v) && v > 0) || q.ask < q.bid
    || !fresh(q.observedAt, input.now, p.maxQuoteAgeMs)) return { ok: false, reason: "invalid_quote" };
  if ((q.ask - q.bid) / q.bid * 10000 > p.maxSpreadBps) return { ok: false, reason: "spread_exceeded" };
  if (!Number.isFinite(input.atr) || input.atr <= 0 || !Number.isFinite(input.structuralStop)
    || input.structuralStop <= 0 || input.structuralStop >= q.ask) return { ok: false, reason: "invalid_geometry" };
  // Include both volatility and setup invalidation; reject excessive risk
  // rather than tightening the stop merely to force admission.
  const stop = Math.min(input.structuralStop, q.ask - input.atr * p.atrStopMultiple);
  const stopPct = (q.ask - stop) / q.ask * 100;
  if (stop <= 0 || stopPct > p.maxStopPct) return { ok: false, reason: "stop_risk_exceeded" };
  const target = q.ask + input.atr * p.targetAtrMultiple;
  if (!Number.isFinite(target)) return { ok: false, reason: "invalid_geometry" };
  const capacity = semiconductorCapacity({ nav: input.nav, cash: input.cash,
    stopDistancePct: stopPct, riskBudgetPct: p.riskBudgetPct, exposureCapPct: p.semiconductorCapPct, holdings: input.holdings });
  if (!capacity.ok) return capacity;
  if (capacity.maxNotional <= 0) return { ok: false, reason: "no_capacity" };
  return { ok: true, version: p.version, entry: q.ask, stop, target, maxNotional: capacity.maxNotional, signalAt: input.signalAt };
}

export function monitorSoxl(input: {
  now: number; quote: SoxlMonitorQuote; maxQuoteAgeMs: number;
  position: Omit<ExitLadderInput, "price" | "targetCheckPrice" | "stopCheckPrice">;
  thesisInvalidated: boolean;
}) {
  const q = input.quote;
  if (!(input.maxQuoteAgeMs > 0) || !Number.isFinite(input.maxQuoteAgeMs)
    || !fresh(q.observedAt, input.now, input.maxQuoteAgeMs)
    || !Number.isFinite(q.price) || q.price <= 0)
    return { action: "data_unavailable" as const, blockNewEntries: true };
  const position = input.position;
  if (![position.qty, position.avgEntry, position.initialStopLoss, position.currentStop, position.highestPrice]
    .every(v => typeof v === "number" && Number.isFinite(v) && v > 0))
    return { action: "invalid_position" as const, blockNewEntries: true };
  // Mirrors position-monitor/route.ts exactly: an intraday low through the
  // stop counts even if price recovered, so stopCheckPrice is the min of the
  // current price and the session low, not the low alone (a session-low quote
  // glitch below zero context shouldn't manufacture a touch the close itself
  // didn't reach either).
  const stopCheckPrice = q.dayLow != null && Number.isFinite(q.dayLow) && q.dayLow > 0
    ? Math.min(q.price, q.dayLow) : undefined;
  const targetCheckPrice = q.dayHigh != null && Number.isFinite(q.dayHigh) && q.dayHigh > 0 ? q.dayHigh : undefined;
  const ladder = decideExitLadder({ ...position, price: q.price, stopCheckPrice, targetCheckPrice });
  if (ladder.action === "stop_full") return ladder;
  if (input.thesisInvalidated) return { ...ladder, action: "thesis_full" as const, exitQty: position.qty, reason: "fresh_thesis_invalidated" };
  return ladder;
}
