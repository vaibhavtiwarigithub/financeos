// Hybrid protective stops — DISASTER-FLOOR CALCULATOR (shadow scaffold).
//
// PURE function, deterministic, NO LLM, NO broker calls, NOT wired to placement.
//
// Q1 (approve broker-hosted TOUCH execution at all?) is NOT answered, so the
// DEFAULT mode is `wider_disaster_floor` — the SAFEST reading: the broker holds a
// wider, static floor for app/scheduler OUTAGE + catastrophic-loss mitigation,
// NOT a touch-at-the-analytical-stop execution rule. `touch_at_analytical_stop`
// exists as a pure branch but must be explicitly requested and is gated behind
// owner approval of touch semantics elsewhere; it is never the default.
//
// The distance is a CONFIG INPUT and is NEVER hardcoded here. The recommended
// mandate-specific ATR rule with a hard maximum-loss bound (spec Open Decision 2)
// is supported via `hardMaxLossFloor`, but the module ships with no default
// distance value of its own.
//
// INVARIANTS (each is falsifiable by a test):
//   - In `wider_disaster_floor` the floor sits BELOW the analytical stop.
//   - The floor may only move UP and may never increase risk: a falling
//     high-water mark (hence a non-rising analytical stop) can NEVER lower it.
//   - `max(currentFloor, candidate)` — an existing broker floor is never lowered.

export type DisasterFloorMode = "wider_disaster_floor" | "touch_at_analytical_stop";

// Distance is supplied by config, never hardcoded. Three shapes; a mandate-ATR
// rule uses `atr_multiple`.
export type DisasterFloorDistance =
  | { kind: "percent_beyond_stop"; pct: number } // floor = stop * (1 - pct); pct in [0,1)
  | { kind: "atr_multiple"; atr: number; multiple: number } // floor = stop - atr*multiple
  | { kind: "fixed_offset"; offset: number }; // floor = stop - offset

export interface DisasterFloorInput {
  mode: DisasterFloorMode;
  /** Kairos-owned analytical (close-based) stop price. Kairos stays authoritative. */
  analyticalStop: number;
  /** Highest observed price — used only to prove monotonicity; a FALL cannot lower the floor. */
  highWaterMark: number;
  /** Distance BELOW the analytical stop for the wider floor. Config-supplied. */
  distance: DisasterFloorDistance;
  /** Existing broker floor, if any — the result is never below this. */
  currentFloor?: number | null;
  /**
   * Optional hard maximum-loss bound: the floor is never placed below this
   * price (e.g. entryPrice * (1 - maxLossPct)). Config-supplied; no default.
   */
  hardMaxLossFloor?: number | null;
}

export interface DisasterFloorResult {
  ok: boolean;
  /** The computed protective floor price (trigger). null when inputs are invalid. */
  floor: number | null;
  mode: DisasterFloorMode;
  /** Prior floor if the result ratcheted up from it, else null. */
  raisedFrom: number | null;
  /** Did the floor move up vs currentFloor? */
  changed: boolean;
  /** wider mode invariant check: is the floor strictly below the analytical stop? */
  belowAnalyticalStop: boolean;
  reason: string;
}

function invalid(mode: DisasterFloorMode, reason: string): DisasterFloorResult {
  return { ok: false, floor: null, mode, raisedFrom: null, changed: false, belowAnalyticalStop: false, reason };
}

function candidateFromDistance(stop: number, d: DisasterFloorDistance): number | null {
  switch (d.kind) {
    case "percent_beyond_stop":
      if (!Number.isFinite(d.pct) || d.pct < 0 || d.pct >= 1) return null;
      return stop * (1 - d.pct);
    case "atr_multiple":
      if (!Number.isFinite(d.atr) || d.atr < 0 || !Number.isFinite(d.multiple) || d.multiple < 0) return null;
      return stop - d.atr * d.multiple;
    case "fixed_offset":
      if (!Number.isFinite(d.offset) || d.offset < 0) return null;
      return stop - d.offset;
    default:
      return null;
  }
}

export function computeDisasterFloor(input: DisasterFloorInput): DisasterFloorResult {
  const { mode, analyticalStop, distance } = input;
  if (!Number.isFinite(analyticalStop) || analyticalStop <= 0) {
    return invalid(mode, "analyticalStop must be a positive finite number");
  }

  // The raw candidate floor for this evaluation.
  let candidate: number | null;
  if (mode === "touch_at_analytical_stop") {
    // Non-default. Touch semantics are NOT approved (Q1); this branch is inert
    // until an owner approves it. The floor equals the analytical stop.
    candidate = analyticalStop;
  } else {
    // Default: wider floor sitting BELOW the analytical stop by the config distance.
    candidate = candidateFromDistance(analyticalStop, distance);
    if (candidate == null) return invalid(mode, "invalid or non-finite distance for wider_disaster_floor");
    if (candidate >= analyticalStop) {
      return invalid(mode, "wider floor must be strictly below the analytical stop — distance too small");
    }
    if (candidate <= 0) return invalid(mode, "computed floor is non-positive");
  }

  // Hard maximum-loss bound: never place the floor below the owner's max-loss
  // price. Raising the floor to the bound REDUCES risk, so it is always allowed.
  if (input.hardMaxLossFloor != null && Number.isFinite(input.hardMaxLossFloor) && input.hardMaxLossFloor > 0) {
    candidate = Math.max(candidate, input.hardMaxLossFloor);
  }

  // Monotonic ratchet: never lower an existing floor. A falling high-water mark
  // (→ a non-rising analytical stop → a non-rising candidate) therefore can never
  // lower the result, because max() clamps it to the prior floor.
  const current = input.currentFloor != null && Number.isFinite(input.currentFloor) ? input.currentFloor : null;
  const finalFloor = current != null ? Math.max(current, candidate) : candidate;
  const changed = current == null ? true : finalFloor > current;

  return {
    ok: true,
    floor: finalFloor,
    mode,
    raisedFrom: current != null && changed ? current : null,
    changed,
    belowAnalyticalStop: finalFloor < analyticalStop,
    reason:
      mode === "touch_at_analytical_stop"
        ? "touch-at-analytical-stop (NON-DEFAULT, requires owner approval of touch semantics)"
        : current != null && !changed
          ? "wider disaster floor held at prior level (ratchet: never lowered)"
          : "wider disaster floor (outage + catastrophic-loss mitigation)",
  };
}
