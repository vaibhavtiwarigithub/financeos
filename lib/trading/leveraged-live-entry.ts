import { leveragedSleeveLiveHeadroom, type LeveragedLivePosition } from "./leveraged-sleeve-risk-live";

/** Symbol-agnostic live entry planner for the leveraged sleeve
 * (SOXL/TQQQ/SQQQ/SOXS). Mirrors the shape of soxl/tqqq/sqqq/soxs-
 * lifecycle.ts's plan*Entry functions exactly (same quote-freshness,
 * monitor-liveness, signal-session, and geometry checks) but is written
 * ONCE, symbol-parametrized, rather than four near-identical copies —
 * because the live path deliberately does NOT reuse SOXL's paper-side
 * semiconductor-sector concentration cap (semiconductorCapacity requires
 * classifying the WHOLE live book, which is disproportionate machinery for
 * a lease starting in the tens-to-low-hundreds of dollars). All four
 * symbols size against the same leveragedSleeveLiveHeadroom() instead. This
 * is a deliberate simplification, not an oversight — flagged here and in
 * the L4 proposal doc, revisit if the live lease ever grows large enough
 * for sector concentration to matter again.
 */
export interface LeveragedLiveEntryPolicy {
  version: string;
  maxQuoteAgeMs: number;
  maxSpreadBps: number;
  maxMonitorAgeMs: number;
  atrStopMultiple: number;
  maxStopPct: number;
  targetAtrMultiple: number;
}
export interface LeveragedLiveQuote { bid: number; ask: number; observedAt: number }

function fresh(time: number, now: number, maxAge: number): boolean {
  return Number.isFinite(time) && Number.isFinite(now) && time <= now && now - time <= maxAge;
}

export function planLeveragedLiveEntry(input: {
  policy: LeveragedLiveEntryPolicy;
  now: number;
  quote: LeveragedLiveQuote;
  signalAt: number;
  lastExitAt: number | null;
  signalSession: string;
  expectedSignalSession: string;
  entryWindowOpen: boolean;
  monitorVerifiedAt: number;
  trendQualified: boolean;
  atr: number;
  structuralStop: number;
  leaseUsd: number;
  existingLivePositions: LeveragedLivePosition[];
}): { ok: false; reason: string } | { ok: true; version: string; entry: number; stop: number; target: number; maxNotional: number; signalAt: number } {
  const p = input.policy;
  if (!p.version || ![p.maxQuoteAgeMs, p.maxSpreadBps, p.maxMonitorAgeMs, p.atrStopMultiple,
    p.maxStopPct, p.targetAtrMultiple].every(v => Number.isFinite(v) && v > 0))
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
  const stop = Math.min(input.structuralStop, q.ask - input.atr * p.atrStopMultiple);
  const stopPct = (q.ask - stop) / q.ask * 100;
  if (stop <= 0 || stopPct > p.maxStopPct) return { ok: false, reason: "stop_risk_exceeded" };
  const target = q.ask + input.atr * p.targetAtrMultiple;
  if (!Number.isFinite(target)) return { ok: false, reason: "invalid_geometry" };

  const headroom = leveragedSleeveLiveHeadroom({ leaseUsd: input.leaseUsd, positions: input.existingLivePositions });
  if (!headroom.ok) return headroom;
  if (headroom.headroom <= 0) return { ok: false, reason: "no_sleeve_capacity" };
  const maxNotional = headroom.headroom;
  if (maxNotional <= 0) return { ok: false, reason: "no_capacity" };
  return { ok: true, version: p.version, entry: q.ask, stop, target, maxNotional, signalAt: input.signalAt };
}
