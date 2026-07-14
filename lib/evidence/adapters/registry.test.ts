// Golden unit tests — Canonical Evidence Router registry (market filtering +
// default chains). Pure lookups: no network, no DB, no mocking required.
//
// Locks the allowlist invariants from FEATURE_ARCHITECTURE.md §22:
//   • Webull is US-only → it is filtered out of any India chain;
//   • US fundamentals.reported leads with Finnhub, then Webull + Yahoo shadow;
//   • the flat ALL_ADAPTERS list is non-empty (capability-status seeding relies on it).

import { describe, expect, it } from "vitest";
import { adaptersForIntent, ALL_ADAPTERS, ADAPTERS_BY_INTENT } from "@/lib/evidence/registry";

describe("adaptersForIntent — market filtering", () => {
  it("returns [] for analyst.consensus in India (Webull is US-only)", () => {
    expect(adaptersForIntent("analyst.consensus", "india")).toEqual([]);
  });

  it("US fundamentals.reported starts with finnhub, then includes webull + yahoo", () => {
    const chain = adaptersForIntent("fundamentals.reported", "us");
    const ids = chain.map((a) => a.providerId);
    expect(ids[0]).toBe("finnhub");
    expect(ids).toContain("webull");
    expect(ids).toContain("yahoo");
  });

  it("India fundamentals.reported drops Webull but keeps Yahoo", () => {
    const ids = adaptersForIntent("fundamentals.reported", "india").map((a) => a.providerId);
    expect(ids).toContain("yahoo");
    expect(ids).not.toContain("webull");
    expect(ids).not.toContain("finnhub"); // Finnhub spec is US-only.
  });

  it("returns [] for an intent with no registered chain", () => {
    expect(adaptersForIntent("sentiment.news", "us")).toEqual([]);
  });
});

describe("registry shape", () => {
  it("ALL_ADAPTERS is non-empty and every entry carries a providerId + intent", () => {
    expect(ALL_ADAPTERS.length).toBeGreaterThan(0);
    for (const a of ALL_ADAPTERS) {
      expect(typeof a.providerId).toBe("string");
      expect(typeof a.intent).toBe("string");
    }
  });

  it("analyst.consensus is registered to exactly the Webull adapter", () => {
    const ids = (ADAPTERS_BY_INTENT["analyst.consensus"] ?? []).map((a) => a.providerId);
    expect(ids).toEqual(["webull"]);
  });
});
