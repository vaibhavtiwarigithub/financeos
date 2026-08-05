// Controlled event vocabulary for the market event ledger.
//
// WHY A CURATED TABLE AND NOT FREE TEXT:
// The theme ledger learned this three days earlier at a cost. Theme Scout minted
// a theme name per run from an LLM with no vocabulary, and 182 rows over 13 runs
// produced 42 distinct strings with 32 appearing exactly once — "Cybersecurity"
// arrived as six variants. A type minted per occurrence cannot be counted, and
// counting a base rate is the entire purpose of this ledger.
//
// WHY THE LIST IS DELIBERATELY SHORT:
// Every event type is another trial. `walk-forward-ic-folds` Open Decision #3
// (false-discovery procedure) is unresolved, so there is no correction available
// for testing many types at once. Start with one family, extend by owner review
// only when a genuinely distinct recurring event appears — never to make a
// particular row fit.
//
// MEASUREMENT ONLY. No type here reaches a score, eligibility, size, entry, exit,
// promotion or broker decision. An event is market-wide, so its per-date
// cross-sectional variance within the affected set is zero by construction — the
// defect that disqualified NSE FII/DII in
// features/india-scorer-discrimination/R3_DIMENSION_FEASIBILITY.md.

export type EventDirection = "escalation" | "de_escalation" | "neutral";

export interface EventTypeDefinition {
  type: string;
  label: string;
  /** What a row of this type must record, so magnitude stays comparable. */
  magnitudeUnit: string | null;
  description: string;
}

// Seeded with the trade-policy family only — the motivating pattern where an
// aggressive announcement moves the market and the actor has historically
// reversed. Paired announce/reverse types make the interval between them
// measurable, which is the quantity the pattern actually claims.
export const EVENT_VOCABULARY: readonly EventTypeDefinition[] = [
  {
    type: "policy_tariff_announced",
    label: "Tariff announced or escalated",
    magnitudeUnit: "headline tariff rate, percentage points",
    description: "A new or increased tariff is announced publicly. occurred_at is the announcement, not the effective date.",
  },
  {
    type: "policy_tariff_reversed",
    label: "Tariff withdrawn, paused or reduced",
    magnitudeUnit: "percentage points removed from the headline rate",
    description: "A previously announced tariff is withdrawn, paused, delayed or cut. Pairs with an earlier policy_tariff_announced.",
  },
];

const TYPE_INDEX: ReadonlyMap<string, EventTypeDefinition> = new Map(
  EVENT_VOCABULARY.map((e) => [e.type, e]),
);

export const EVENT_TYPES: readonly string[] = EVENT_VOCABULARY.map((e) => e.type);

export function isKnownEventType(value: unknown): value is string {
  return typeof value === "string" && TYPE_INDEX.has(value);
}

export function eventTypeDefinition(type: string): EventTypeDefinition | null {
  return TYPE_INDEX.get(type) ?? null;
}

export const EVENT_DIRECTIONS: readonly EventDirection[] = ["escalation", "de_escalation", "neutral"];

export function isEventDirection(value: unknown): value is EventDirection {
  return typeof value === "string" && (EVENT_DIRECTIONS as readonly string[]).includes(value);
}

export interface EventTimestampCheck {
  ok: boolean;
  reason?: string;
}

/**
 * `occurred_at` must be when the event became PUBLIC, and must not postdate
 * `observed_at` (when we recorded it).
 *
 * This is the field the whole ledger rests on. If occurred_at drifts toward
 * "when we noticed", every backward measurement is contaminated by look-ahead
 * and the base rate is silently optimistic. Rejecting a future occurred_at is
 * the one check that can be made mechanically; a plausible-but-wrong date still
 * needs the cited source.
 */
export function checkEventTimestamps(occurredAt: string, observedAt: string): EventTimestampCheck {
  const occurred = Date.parse(occurredAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(occurred)) return { ok: false, reason: "occurred_at is not a valid timestamp" };
  if (!Number.isFinite(observed)) return { ok: false, reason: "observed_at is not a valid timestamp" };
  if (occurred > observed) {
    return { ok: false, reason: "occurred_at is after observed_at — an event cannot be recorded before it happened" };
  }
  return { ok: true };
}
