import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildValueScenarios, indexAdjustedReference } from "@/lib/property/value-intelligence";

describe("property value intelligence", () => {
  it("rebases a dated evidence amount only by the compatible index ratio", () => {
    expect(indexAdjustedReference(500_000, 200, 220)).toBe(550_000);
    expect(indexAdjustedReference(500_000, 0, 220)).toBeNull();
  });

  it("produces bounded 1/3/5-year scenarios from index history, never an exact price", () => {
    const points = Array.from({ length: 24 }, (_, index) => ({ asOf: `${2020 + Math.floor(index / 4)}-${String((index % 4) * 3 + 3).padStart(2, "0")}-28`, value: 100 + index * 2 }));
    const scenarios = buildValueScenarios(600_000, points);
    expect(scenarios.map((scenario) => scenario.horizonYears)).toEqual([1, 3, 5]);
    for (const scenario of scenarios) {
      expect(scenario.lower).toBeLessThanOrEqual(scenario.base);
      expect(scenario.base).toBeLessThanOrEqual(scenario.upper);
    }
  });

  it("makes both ledgers encrypted, owner-only, and append-only", () => {
    const migration = readFileSync("supabase/migrations/20260808210000_property_value_intelligence.sql", "utf8");
    expect(migration).toContain("encrypted_payload text not null");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on public.property_value_observations, public.property_value_references from anon, authenticated");
    expect(migration).toContain("before truncate");
  });

  it("requires an explicit UI/API selection before derived references are created", () => {
    const route = readFileSync("app/api/property/value-intelligence/route.ts", "utf8");
    expect(route).toContain("const deriveReference = body?.deriveReference === true");
    expect(route).toContain("? await referencesForEvidence");
  });
});
