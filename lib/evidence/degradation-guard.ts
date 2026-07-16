// Runtime evidence-degradation guard — PURE CORE (router-cutover §6).
//
// Activation parity cannot prevent a later outage. This guard runs on EVERY
// research run (legacy path included — it does not depend on the Router being
// enabled) and answers one question per symbol:
//
//   Did a REQUIRED evidence field degrade such that this symbol's eligibility
//   for a NEW long now depends on renormalizing around the degradation?
//
// If yes → abstain from the NEW long. Never the reverse.
//
// HARD SAFETY PROPERTIES (proven by tests, not by convention):
//   - STRICTLY SUBTRACTIVE. `applyDegradationGuard` can only turn "long" into
//     "neutral". It can never create a long, upgrade a score, or widen a size.
//   - EXITS ARE UNTOUCHABLE. A "short" (deterministic exit on a held position)
//     and every mandatory-exit path pass through unchanged. An evidence outage
//     must never suppress a stop — that would be the guard causing the harm it
//     exists to prevent. Held positions continue through PositionMonitor's
//     normal risk/exit logic regardless of what this returns.
//   - DEFAULTS TO ABSTAIN, never to a more permissive score. An unknown/absent
//     baseline is not treated as "all clear" for a required field that is
//     currently unusable.
//   - DETERMINISTIC. No LLM, no clock-dependent branching beyond the ages the
//     caller supplies, no DB. Same inputs → same decision, replayable.
//
// This file is pure: no DB, no network, no side effects. The runtime wrapper
// (degradation-runtime.ts) loads baselines, persists masks, and emits ONE
// aggregated health event per run.

import type { EvidenceQuality, Market } from "@/lib/evidence/contracts";
import type { ScorerFieldContract, SymbolShape } from "@/lib/evidence/intent-classification";
import { contractsFor } from "@/lib/evidence/intent-classification";

// ── modes ────────────────────────────────────────────────────────────────────

// measure_only: the guard evaluates and records exactly what it WOULD abstain,
//   but does not change any direction. This is the default — the guard is
//   observed before it bites.
// enforce: abstentions actually apply (still strictly subtractive).
// off: no evaluation at all.
export type GuardMode = "off" | "measure_only" | "enforce";

export const DEFAULT_GUARD_MODE: GuardMode = "measure_only";

export function parseGuardMode(raw: string | undefined | null): GuardMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "enforce") return "enforce";
  if (v === "off") return "off";
  // Anything unrecognized (typo, empty, garbage) falls back to measure_only.
  // Fail-safe direction: an unreadable config must never silently ENFORCE, and
  // must never silently disable the recording either.
  return DEFAULT_GUARD_MODE;
}

// ── masks ────────────────────────────────────────────────────────────────────

export type FieldAvailability = "available" | "missing" | "not_applicable";

/** One field's observed state for one symbol at one run. The unit of comparison. */
export interface FieldState {
  availability: FieldAvailability;
  quality: EvidenceQuality;
  /** Age of the underlying observation in seconds, or null when unknown. */
  ageSeconds: number | null;
  /** Whether the minimum field contract (minFields / minCount) is satisfied. */
  contractOk: boolean;
}

export type FieldMask = Record<string, FieldState>;

/** What the caller observed for one field this run, before contract evaluation. */
export interface FieldObservation {
  fieldId: string;
  availability: FieldAvailability;
  quality: EvidenceQuality;
  ageSeconds: number | null;
  contractOk: boolean;
  /**
   * True when the scorer EXCLUDED this dimension and renormalized the remaining
   * weights around its absence. This is what "eligibility depends on
   * renormalizing around that degradation" means concretely (§6.3).
   */
  renormalizedAround: boolean;
}

// ── reason codes (bounded) ───────────────────────────────────────────────────

export type DegradationCode =
  | "required_field_unusable"        // applicable + required + fails contract NOW
  | "available_to_missing"           // baseline had it, now gone
  | "fresh_to_stale_beyond_ceiling"  // aged past the field's maxAgeSeconds
  | "valid_to_conflict"              // providers now disagree
  | "valid_to_quarantined"           // observation quarantined
  | "contract_broken"                // present but minimum field contract now fails
  | "quality_degraded"               // any other acceptable→unacceptable quality move
  | "no_baseline_required_field";    // never had an accepted baseline; field unusable

/** Non-degrading transitions we still record (never cause abstain). */
export type NeutralCode =
  | "unchanged"
  | "improved"
  | "missing_to_available"
  | "still_missing_not_required"
  | "not_applicable";

export type TransitionCode = DegradationCode | NeutralCode;

const DEGRADATION_CODES: ReadonlySet<TransitionCode> = new Set<DegradationCode>([
  "required_field_unusable",
  "available_to_missing",
  "fresh_to_stale_beyond_ceiling",
  "valid_to_conflict",
  "valid_to_quarantined",
  "contract_broken",
  "quality_degraded",
  "no_baseline_required_field",
]);

export function isDegradation(code: TransitionCode): boolean {
  return DEGRADATION_CODES.has(code);
}

export interface FieldTransition {
  fieldId: string;
  code: TransitionCode;
  from: FieldState | null;
  to: FieldState;
  required: boolean;
  /** True when this transition, on its own, is enough to abstain a new long. */
  blocking: boolean;
  detail: string;
}

// ── usability ────────────────────────────────────────────────────────────────

/**
 * Is this field usable as evidence RIGHT NOW under its own contract?
 * Missing, contract-broken, conflicting, quarantined, and past-ceiling states
 * are all UNUSABLE — and each keeps its own distinct reason. None of them is
 * ever coerced to zero/neutral (invariant §2.4).
 */
export function isUsable(state: FieldState, contract: ScorerFieldContract): boolean {
  if (state.availability !== "available") return false;
  if (!state.contractOk) return false;
  if (!contract.acceptableQuality.includes(state.quality)) return false;
  // Age is only disqualifying when we actually know it. An unknown age is not
  // evidence of staleness — but it is also not proof of freshness, which is why
  // an unknown-age field never satisfies a `fresh`-only contract.
  if (state.ageSeconds !== null && state.ageSeconds > contract.maxAgeSeconds) return false;
  return true;
}

function reasonUnusable(state: FieldState, contract: ScorerFieldContract): DegradationCode {
  if (state.availability === "missing") return "available_to_missing";
  if (state.quality === "conflict") return "valid_to_conflict";
  if (state.quality === "quarantined") return "valid_to_quarantined";
  if (state.ageSeconds !== null && state.ageSeconds > contract.maxAgeSeconds) {
    return "fresh_to_stale_beyond_ceiling";
  }
  if (!state.contractOk) return "contract_broken";
  return "quality_degraded";
}

function stateOf(obs: FieldObservation): FieldState {
  return {
    availability: obs.availability,
    quality: obs.quality,
    ageSeconds: obs.ageSeconds,
    contractOk: obs.contractOk,
  };
}

// ── evaluation ───────────────────────────────────────────────────────────────

export interface GuardInput {
  market: Market;
  symbol: string;
  shape: SymbolShape;
  /** Held positions keep full exit capability — see `applyDegradationGuard`. */
  isHeld: boolean;
  observations: readonly FieldObservation[];
  /** Last ACCEPTED market-local baseline mask for this symbol, or null. */
  baseline: FieldMask | null;
  /** IDs recorded on the decision for replay. */
  policyVersionId: string;
  evidenceRunId: string;
}

export type GuardAction = "allow" | "abstain_new_long";

export interface GuardDecision {
  market: Market;
  symbol: string;
  action: GuardAction;
  transitions: FieldTransition[];
  /** Codes that caused the abstain, deduped + sorted (stable for tests/logs). */
  blockingCodes: DegradationCode[];
  baselineMask: FieldMask | null;
  currentMask: FieldMask;
  /** Safe to promote `currentMask` to the accepted baseline. */
  baselineAcceptable: boolean;
  policyVersionId: string;
  evidenceRunId: string;
}

/**
 * Deterministic per-symbol evaluation (§6.1–§6.3).
 *
 * A required field triggers abstain when it is unusable now AND the scorer
 * renormalized around it — i.e. the symbol's score/eligibility was computed by
 * redistributing weight away from evidence we no longer have. A required field
 * that is unusable but NOT renormalized around did not shape this decision, so
 * it does not abstain (that would be punishment without causation).
 *
 * Structurally not-applicable fields (ETF fundamentals, ADR insider) can never
 * degrade — absence there is expected, and the availability mask already
 * handles it. That is checked against the CONTRACT's applicableShapes, not the
 * caller's say-so.
 */
export function evaluateDegradation(input: GuardInput): GuardDecision {
  const contracts = new Map(
    contractsFor(input.market, input.shape).map((c) => [c.fieldId, c]),
  );

  const currentMask: FieldMask = {};
  const transitions: FieldTransition[] = [];
  const blocking = new Set<DegradationCode>();

  for (const obs of input.observations) {
    const contract = contracts.get(obs.fieldId);
    const to = stateOf(obs);
    currentMask[obs.fieldId] = to;

    // Not applicable for this market/shape → never a degradation.
    if (!contract || obs.availability === "not_applicable") {
      transitions.push({
        fieldId: obs.fieldId, code: "not_applicable", from: input.baseline?.[obs.fieldId] ?? null,
        to, required: false, blocking: false,
        detail: contract
          ? "structurally not applicable for this symbol shape"
          : `no contract for ${obs.fieldId} in ${input.market}/${input.shape}`,
      });
      continue;
    }

    const from = input.baseline?.[obs.fieldId] ?? null;
    const usableNow = isUsable(to, contract);
    const usableBefore = from ? isUsable(from, contract) : null;
    const required = contract.required;

    let code: TransitionCode;
    let detail: string;

    if (usableNow) {
      if (usableBefore === false) { code = "missing_to_available"; detail = "recovered since baseline"; }
      else if (from && to.quality !== from.quality) { code = "improved"; detail = `quality ${from.quality} → ${to.quality}, still usable`; }
      else { code = "unchanged"; detail = "usable, no degradation"; }
    } else if (usableBefore === false) {
      // Already unusable at the accepted baseline — not a NEW degradation. But a
      // REQUIRED field that is unusable still gates (§6.4): the two-dimension
      // floor is not a universal assurance when a required gate field is absent.
      code = required ? reasonUnusable(to, contract) : "still_missing_not_required";
      detail = required
        ? "required field unusable (also unusable at baseline — persistent outage)"
        : "optional field still absent; score renormalizes as before";
    } else if (usableBefore === true) {
      code = reasonUnusable(to, contract);
      detail = `usable at baseline (${from!.quality}) → unusable now (${to.quality}, availability=${to.availability}, contractOk=${to.contractOk})`;
    } else {
      // No baseline at all. Do NOT read that as "all clear" — for a required
      // field this is exactly the default-to-abstain case (§6 closing line).
      code = required ? "no_baseline_required_field" : "still_missing_not_required";
      detail = required
        ? "no accepted baseline and required field is unusable — defaulting to abstain"
        : "no baseline; optional field unusable";
    }

    // §6.3 — abstain only from a new long whose eligibility DEPENDS on
    // renormalizing around the degradation. A required field that is unusable
    // and was renormalized around is precisely that dependency.
    const isBlocking =
      required && !usableNow && obs.renormalizedAround && isDegradation(code);

    if (isBlocking) {
      // `required_field_unusable` is the umbrella cause; the specific transition
      // code is retained on the transition row for the audit trail.
      blocking.add(code as DegradationCode);
      blocking.add("required_field_unusable");
    }

    transitions.push({ fieldId: obs.fieldId, code, from, to, required, blocking: isBlocking, detail });
  }

  const action: GuardAction = blocking.size > 0 ? "abstain_new_long" : "allow";

  return {
    market: input.market,
    symbol: input.symbol,
    action,
    transitions,
    blockingCodes: [...blocking].sort(),
    baselineMask: input.baseline,
    currentMask,
    // Only a clean run may become the baseline future runs are compared to —
    // otherwise a degraded run silently becomes "normal" and the guard blinds
    // itself (baseline drift).
    baselineAcceptable: action === "allow",
    policyVersionId: input.policyVersionId,
    evidenceRunId: input.evidenceRunId,
  };
}

// ── application (the ONLY place the guard touches a decision) ────────────────

export type SignalDirection = "long" | "neutral" | "short";

export interface GuardApplication {
  direction: SignalDirection;
  /** True when the guard actually changed the direction. */
  applied: boolean;
  /** True when the guard WOULD have abstained but ran in measure_only. */
  wouldAbstain: boolean;
  note: string;
}

/**
 * Apply a decision to a proposed direction. STRICTLY SUBTRACTIVE.
 *
 * The only transformation this function can ever perform is long → neutral.
 * "short" (a deterministic exit on a held position) and "neutral" are returned
 * untouched — an evidence outage may not suppress an exit (§6.5). There is no
 * branch here that produces a "long" that was not already proposed.
 */
export function applyDegradationGuard(
  proposed: SignalDirection,
  decision: GuardDecision,
  mode: GuardMode,
): GuardApplication {
  const wants = mode !== "off" && decision.action === "abstain_new_long";

  // Never touch an exit or an existing abstain. Guarded before the mode check so
  // no configuration can make the guard interfere with a sell.
  if (proposed !== "long") {
    return {
      direction: proposed,
      applied: false,
      wouldAbstain: wants,
      note: wants
        ? ` [evidence-degradation: ${decision.blockingCodes.join(",")} — exit/abstain path unaffected]`
        : "",
    };
  }

  if (!wants) return { direction: "long", applied: false, wouldAbstain: false, note: "" };

  if (mode === "measure_only") {
    return {
      direction: "long", // unchanged — measuring only
      applied: false,
      wouldAbstain: true,
      note: ` [evidence-degradation WOULD abstain (measure-only): ${decision.blockingCodes.join(",")}]`,
    };
  }

  return {
    direction: "neutral",
    applied: true,
    wouldAbstain: true,
    note: ` [abstained: evidence degraded — ${decision.blockingCodes.join(",")}]`,
  };
}
