// Conviction-scaled position sizing (Phase 2 deliverable, built early since it's
// pure/standalone). Never risks full-Kelly (ruin risk) — capped at half-Kelly by
// default, and callers without a calibrated model should keep using the legacy
// flat position_size_pct (this module doesn't change PaperTrader by itself).

// Kelly fraction for a binary bet: f* = (p*b - (1-p)) / b
// p = win probability, b = payoff ratio (avg win / avg loss, e.g. 2.0 = win twice what you risk).
export function kellyFraction(pWin: number, payoffRatio: number): number {
  if (payoffRatio <= 0 || !Number.isFinite(payoffRatio)) return 0;
  if (pWin < 0 || pWin > 1 || !Number.isFinite(pWin)) return 0;
  const f = (pWin * payoffRatio - (1 - pWin)) / payoffRatio;
  return Number.isFinite(f) ? f : 0;
}

export interface SizingOptions {
  halfKellyCap?: number; // default 0.10 (10% of pool) — hard ceiling regardless of Kelly output
  floorPct?: number;      // default 0.02 (2%) — minimum size when a bet is taken at all
}

// Position size as a fraction of pool cash (e.g. 0.10 = 10%), clamped to
// [floorPct, halfKellyCap]. Negative/zero Kelly (no edge) clamps to the floor —
// callers should gate entry separately (this only sizes bets already entered).
export function positionSizePct(pWin: number, payoffRatio: number, opts?: SizingOptions): number {
  const cap = opts?.halfKellyCap ?? 0.10;
  const floor = opts?.floorPct ?? 0.02;
  const full = kellyFraction(pWin, payoffRatio);
  const half = full * 0.5; // never full-Kelly — ruin risk
  return Math.max(floor, Math.min(cap, half));
}
