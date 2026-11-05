import { describe, expect, it } from "vitest";
import {
  EVENT_VOCABULARY, EVENT_TYPES, isKnownEventType, isEventDirection,
  eventTypeDefinition, checkEventTimestamps,
} from "@/lib/events/vocabulary";

describe("event vocabulary", () => {
  it("keeps only the explicitly approved event families", () => {
    // The US election/policy shadow architecture was owner-approved on
    // 2026-11-04. Keep the four prior tariff/guidance types and those two
    // additions explicit so later event families still require review.
    expect(EVENT_TYPES).toEqual([
      "policy_tariff_announced", "policy_tariff_reversed", "guidance_cut",
      "guidance_raised", "election_control_change", "federal_policy_action",
    ]);
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

  it("documents numeric magnitude units where the event has one", () => {
    for (const def of EVENT_VOCABULARY) {
      expect(def.description.length).toBeGreaterThan(20);
      if (["election_control_change", "federal_policy_action"].includes(def.type)) {
        expect(def.magnitudeUnit).toBeNull(); // Governed by certified/control or lifecycle state, not a numeric magnitude.
      } else {
        expect(def.magnitudeUnit, `${def.type} needs a documented unit`).toBeTruthy();
      }
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
