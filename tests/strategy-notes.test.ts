import { describe, it, expect } from "vitest";
import { parseStrategyNotes } from "@/lib/risk/strategy-notes";

// THE INVARIANT: the LLM writes `strategy_note` prose and NOTHING else. It can
// never alter a number, score, posture, action, or sector-breach allocation.
// Enforced by the type — parseStrategyNotes can only ever emit
// Map<requestedSymbol, string> — and proven here rather than by trusting the prompt.
// Spec: features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md §7, §9.18–19.

const SYMBOLS = ["AVGO", "INTC"];

describe("parseStrategyNotes — the LLM cannot alter an allocation (§9.18)", () => {
  it("extracts prose for requested symbols", () => {
    const n = parseStrategyNotes('{"AVGO":"Biggest tech position.","INTC":"Small, untouched."}', SYMBOLS);
    expect(n.get("AVGO")).toBe("Biggest tech position.");
    expect(n.get("INTC")).toBe("Small, untouched.");
  });

  it("drops a structured value trying to smuggle an allocation", () => {
    const n = parseStrategyNotes('{"AVGO":{"trim_pct":99,"note":"trim it all"},"INTC":"ok"}', SYMBOLS);
    expect(n.has("AVGO")).toBe(false);   // never coerced to "[object Object]"
    expect(n.get("INTC")).toBe("ok");
  });

  it("drops keys that were not requested — no posture/score/trim smuggling", () => {
    const n = parseStrategyNotes(
      '{"AVGO":"note","risk_posture":"hold","holding_risk_score":"0","trim_pct":"99","ZZZZ":"invented"}',
      SYMBOLS,
    );
    expect([...n.keys()]).toEqual(["AVGO"]);
    expect(n.has("risk_posture")).toBe(false);
    expect(n.has("holding_risk_score")).toBe(false);
    expect(n.has("trim_pct")).toBe(false);
    expect(n.has("ZZZZ")).toBe(false);   // cannot invent a holding
  });

  it("drops non-string scalars rather than coercing them", () => {
    const n = parseStrategyNotes('{"AVGO":63,"INTC":null}', SYMBOLS);
    expect(n.size).toBe(0);
  });

  it("drops arrays and empty/whitespace strings", () => {
    const n = parseStrategyNotes('{"AVGO":["trim"],"INTC":"   "}', SYMBOLS);
    expect(n.size).toBe(0);
  });

  it("does not resolve prototype keys into notes", () => {
    const n = parseStrategyNotes('{"__proto__":{"AVGO":"injected"}}', SYMBOLS);
    expect(n.has("AVGO")).toBe(false);
    expect(n.size).toBe(0);
  });

  it("caps note length (a note can never become an essay in the row)", () => {
    const n = parseStrategyNotes(JSON.stringify({ AVGO: "x".repeat(5000) }), SYMBOLS);
    expect(n.get("AVGO")!.length).toBe(600);
  });
});

describe("parseStrategyNotes — prose failure never blocks a deterministic row (§9.19)", () => {
  for (const [label, raw] of [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["no JSON at all", "I cannot help with that."],
    ["malformed JSON", '{"AVGO": "unterminated'],
    ["a JSON array", "[1,2,3]"],
    ["JSON null", "{}...null"],
    ["a bare number", "42"],
  ] as const) {
    it(`${label} → empty map, never throws`, () => {
      let n: Map<string, string> | null = null;
      expect(() => { n = parseStrategyNotes(raw as any, SYMBOLS); }).not.toThrow();
      expect(n!.size).toBe(0);
    });
  }

  it("salvages the JSON object out of surrounding prose", () => {
    const n = parseStrategyNotes('Sure! Here you go:\n```json\n{"AVGO":"note"}\n```\nHope that helps.', SYMBOLS);
    expect(n.get("AVGO")).toBe("note");
  });

  it("no requested symbols → empty map", () => {
    expect(parseStrategyNotes('{"AVGO":"note"}', []).size).toBe(0);
  });
});
