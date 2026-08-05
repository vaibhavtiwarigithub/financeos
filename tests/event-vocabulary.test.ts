import { describe, expect, it } from "vitest";
import {
  EVENT_VOCABULARY, EVENT_TYPES, isKnownEventType, isEventDirection,
  eventTypeDefinition, checkEventTimestamps,
} from "@/lib/events/vocabulary";

describe("event vocabulary", () => {
  it("starts narrow — one family, because each type is another trial", () => {
    // walk-forward-ic-folds Open Decision #3 (false-discovery procedure) is
    // unresolved, so there is no correction available for testing many event
    // types at once. Growth here must be an owner-reviewed decision.
    expect(EVENT_TYPES.length).toBeLessThanOrEqual(4);
    expect(EVENT_TYPES).toContain("policy_tariff_announced");
    expect(EVENT_TYPES).toContain("policy_tariff_reversed");
  });

  it("rejects unknown types rather than minting them", () => {
    // The theme ledger's failure mode: 42 free-text strings over 13 runs, 32
    // appearing once. A type minted per occurrence cannot be counted.
    for (const bad of ["tariff", "Policy Tariff Announced", "policy_tariff", "", null, undefined, 7]) {
      expect(isKnownEventType(bad as any)).toBe(false);
    }
  });

  it("documents a magnitude unit per type so values stay comparable", () => {
    for (const def of EVENT_VOCABULARY) {
      expect(def.magnitudeUnit, `${def.type} needs a documented unit`).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it("has unique, snake_case types", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    for (const t of EVENT_TYPES) expect(t).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("resolves definitions and directions", () => {
    expect(eventTypeDefinition("policy_tariff_announced")?.label).toBeTruthy();
    expect(eventTypeDefinition("nope")).toBeNull();
    for (const d of ["escalation", "de_escalation", "neutral"]) expect(isEventDirection(d)).toBe(true);
    for (const d of ["up", "", null]) expect(isEventDirection(d as any)).toBe(false);
  });
});

// occurred_at is the field the whole ledger rests on. If it drifts toward "when
// we noticed", every backward measurement is contaminated by look-ahead and the
// base rate is silently optimistic.
describe("event timestamp guard", () => {
  it("accepts an event recorded after it happened", () => {
    expect(checkEventTimestamps("2026-08-01T12:00:00Z", "2026-08-05T09:00:00Z").ok).toBe(true);
    expect(checkEventTimestamps("2026-08-05T09:00:00Z", "2026-08-05T09:00:00Z").ok).toBe(true);
  });

  it("rejects an event recorded BEFORE it happened", () => {
    const r = checkEventTimestamps("2026-08-09T12:00:00Z", "2026-08-05T09:00:00Z");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/before it happened/);
  });

  it("rejects unparseable timestamps instead of coercing them", () => {
    expect(checkEventTimestamps("not-a-date", "2026-08-05T09:00:00Z").ok).toBe(false);
    expect(checkEventTimestamps("2026-08-05T09:00:00Z", "nonsense").ok).toBe(false);
  });
});
