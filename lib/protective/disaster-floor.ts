export type DisasterFloorMode = "wider_disaster_floor";

export type DisasterFloorDistance =
  | { kind: "percent_beyond_stop"; pct: number }
  | { kind: "atr_multiple"; atr: number; multiple: number }
  | { kind: "fixed_offset"; offset: number };

export interface DisasterFloorInput {
  mode: DisasterFloorMode;
  analyticalStop: number;
  highWaterMark: number;
  distance: DisasterFloorDistance;
  currentFloor?: number | null;
  hardMaxLossFloor?: number | null;
}

export interface DisasterFloorResult {
  ok: boolean;
  floor: number | null;
  mode: DisasterFloorMode;
  raisedFrom: number | null;
  changed: boolean;
  belowAnalyticalStop: boolean;
  reason: string;
}

function invalid(reason: string): DisasterFloorResult {
  return { ok: false, floor: null, mode: "wider_disaster_floor", raisedFrom: null, changed: false, belowAnalyticalStop: false, reason };
}

export function isDisasterFloorMode(value: unknown): value is DisasterFloorMode {
  return value === "wider_disaster_floor";
}

function candidateFromDistance(stop: number, distance: DisasterFloorDistance): number | null {
  switch (distance.kind) {
    case "percent_beyond_stop":
      return Number.isFinite(distance.pct) && distance.pct >= 0 && distance.pct < 1 ? stop * (1 - distance.pct) : null;
    case "atr_multiple":
      return Number.isFinite(distance.atr) && distance.atr >= 0 && Number.isFinite(distance.multiple) && distance.multiple >= 0
        ? stop - distance.atr * distance.multiple
        : null;
    case "fixed_offset":
      return Number.isFinite(distance.offset) && distance.offset >= 0 ? stop - distance.offset : null;
    default:
      return null;
  }
}

export function computeDisasterFloor(input: DisasterFloorInput): DisasterFloorResult {
  if (!isDisasterFloorMode(input.mode)) return invalid("unsupported disaster-floor mode");
  if (!Number.isFinite(input.analyticalStop) || input.analyticalStop <= 0) return invalid("analyticalStop must be positive and finite");
  if (!Number.isFinite(input.highWaterMark) || input.highWaterMark <= 0) return invalid("highWaterMark must be positive and finite");

  const rawCandidate = candidateFromDistance(input.analyticalStop, input.distance);
  if (rawCandidate == null || !Number.isFinite(rawCandidate) || rawCandidate <= 0) return invalid("invalid disaster-floor distance");
  if (rawCandidate >= input.analyticalStop) return invalid("wider floor must be strictly below analyticalStop");

  const hard = input.hardMaxLossFloor;
  if (hard != null && (!Number.isFinite(hard) || hard <= 0 || hard >= input.analyticalStop)) {
    return invalid("hardMaxLossFloor must be positive, finite, and below analyticalStop");
  }
  const current = input.currentFloor;
  if (current != null && (!Number.isFinite(current) || current <= 0 || current >= input.analyticalStop)) {
    return invalid("currentFloor is invalid or no longer wider than analyticalStop; do not modify it blindly");
  }

  const candidate = hard == null ? rawCandidate : Math.max(rawCandidate, hard);
  const finalFloor = current == null ? candidate : Math.max(current, candidate);
  if (finalFloor >= input.analyticalStop) return invalid("computed floor is not wider than analyticalStop");
  const changed = current == null || finalFloor > current;
  return {
    ok: true,
    floor: finalFloor,
    mode: "wider_disaster_floor",
    raisedFrom: current != null && changed ? current : null,
    changed,
    belowAnalyticalStop: true,
    reason: current != null && !changed
      ? "wider disaster floor held at prior level (ratchet: never lowered)"
      : "wider disaster floor (outage + catastrophic-loss mitigation)",
  };
}
