import { describe, it, expect } from "vitest";
import { evaluateFeature, validateFeatureInputs, FeatureCompileError } from "@/lib/validation/feature-compiler";

describe("evaluateFeature — whitelisted grammar", () => {
  it("evaluates basic arithmetic", () => {
    expect(evaluateFeature("2 + 3 * 4", { values: {} })).toBe(14);
    expect(evaluateFeature("(2 + 3) * 4", { values: {} })).toBe(20);
  });

  it("resolves identifiers from the context", () => {
    expect(evaluateFeature("pe_ratio / eps", { values: { pe_ratio: 20, eps: 4 } })).toBe(5);
  });

  it("supports log/abs/min/max", () => {
    expect(evaluateFeature("abs(-5)", { values: {} })).toBe(5);
    expect(evaluateFeature("min(3, 7)", { values: {} })).toBe(3);
    expect(evaluateFeature("max(3, 7)", { values: {} })).toBe(7);
    expect(evaluateFeature("log(1)", { values: {} })).toBe(0);
  });

  it("supports lag() via the series context", () => {
    expect(evaluateFeature("lag(rsi, 1)", { values: {}, series: { rsi: [55, 60, 62] } })).toBe(60);
  });

  it("returns null (abstains) when an input is missing, rather than throwing", () => {
    expect(evaluateFeature("missing_field + 1", { values: {} })).toBeNull();
  });

  it("returns null on division by zero", () => {
    expect(evaluateFeature("5 / zero", { values: { zero: 0 } })).toBeNull();
  });

  it("rejects disallowed characters (no code injection surface)", () => {
    expect(() => evaluateFeature("require('fs')", { values: {} })).toThrow(FeatureCompileError);
    expect(() => evaluateFeature("process.exit()", { values: { process: 1 } })).toThrow();
  });

  it("rejects a function not in the whitelist", () => {
    expect(() => evaluateFeature("eval(1)", { values: {} })).toThrow(FeatureCompileError);
  });

  it("rejects malformed expressions", () => {
    expect(() => evaluateFeature("1 +", { values: {} })).toThrow();
    expect(() => evaluateFeature("(1 + 2", { values: {} })).toThrow();
  });
});

describe("validateFeatureInputs", () => {
  it("passes when every identifier is declared", () => {
    expect(validateFeatureInputs("pe_ratio / eps", ["pe_ratio", "eps"]).ok).toBe(true);
  });

  it("fails when an identifier is not declared (prevents reading undeclared fields)", () => {
    const result = validateFeatureInputs("pe_ratio / secret_field", ["pe_ratio"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("secret_field");
  });

  it("fails cleanly on a syntax error rather than throwing", () => {
    const result = validateFeatureInputs("1 +", []);
    expect(result.ok).toBe(false);
  });
});
