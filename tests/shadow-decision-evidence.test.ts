import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shadowDecisionEntryEvidence } from "@/lib/shadows/decision-evidence";

describe("shadow decision entry-price provenance", () => {
  it("stores a positive decision-time reference without claiming it is a fill", () => {
    expect(shadowDecisionEntryEvidence(123.45)).toEqual({ entry_price: 123.45 });
    expect(shadowDecisionEntryEvidence("123.45")).toEqual({ entry_price: 123.45 });
  });

  it("keeps absent and invalid decision prices null rather than coercing them", () => {
    for (const value of [null, undefined, "", "unknown", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shadowDecisionEntryEvidence(value)).toEqual({ entry_price: null });
    }
  });

  it("selects price_at_decision before writing it to score-shadow rows", () => {
    const source = readFileSync("lib/research-agent.ts", "utf8");
    expect(source).toContain('}).select("id,price_at_decision").maybeSingle()');
    expect(source.match(/shadowDecisionEntryEvidence\(obsRow\.price_at_decision\)/g)).toHaveLength(3);
  });
});
