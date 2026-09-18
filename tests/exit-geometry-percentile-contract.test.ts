import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/risk/percentiles.ts", "utf8");

describe("exit geometry percentile evidence contract", () => {
  it("uses one eligible entry observation per symbol/session", () => {
    expect(source).toContain("seenSymbolSessions");
    expect(source).toContain('select("id,symbol,ts,entry_eligible,direction,decision_context,discovery_source")');
  });

  it("uses one complete excursion pair per observation and never coerces null to zero", () => {
    expect(source).toContain("seenObservationIds");
    expect(source).toContain("observation_id,max_adverse_excursion, max_favorable_excursion");
    expect(source).toContain("value == null ? null");
    expect(source).not.toContain(".limit(5000)");
  });
});
