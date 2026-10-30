import { describe, expect, it } from "vitest";
import { isEligibleResearchSymbol, validateAutonomousPriceRules } from "./autonomous-template-discovery";

describe("autonomous strategy rule boundary", () => {
  it("accepts one or two conditions from the frozen threshold grid", () => {
    expect(validateAutonomousPriceRules({ rsi_min: 60 })).toEqual({ ok: true, rules: { rsi_min: 60 } });
    expect(validateAutonomousPriceRules({ rsi_min: 60, above_ma50: true })).toEqual({
      ok: true, rules: { rsi_min: 60, above_ma50: true },
    });
  });

  it("rejects arbitrary code, unsupported keys, and off-grid thresholds", () => {
    expect(validateAutonomousPriceRules({ rule: "close > 20" }).ok).toBe(false);
    expect(validateAutonomousPriceRules({ above_ma50: false }).ok).toBe(false);
    expect(validateAutonomousPriceRules({ rsi_min: 61 }).ok).toBe(false);
    expect(validateAutonomousPriceRules({ rsi_min: 60, above_ma50: true, above_ma200: true }).ok).toBe(false);
  });

  it("rejects contradictory RSI conditions", () => {
    expect(validateAutonomousPriceRules({ rsi_min: 65, rsi_max: 35 })).toEqual({
      ok: false, reason: "rsi_min cannot exceed rsi_max; the combined condition would be impossible",
    });
    expect(validateAutonomousPriceRules({ rsi_min: 65, rsi_max: 70 }).ok).toBe(false);
  });

  it("keeps the discovered universe within the requested market", () => {
    expect(isEligibleResearchSymbol("NVDA", "us")).toBe(true);
    expect(isEligibleResearchSymbol("RELIANCE.NS", "india")).toBe(true);
    expect(isEligibleResearchSymbol("NVDA", "india")).toBe(false);
    expect(isEligibleResearchSymbol("RELIANCE.NS", "us")).toBe(false);
    expect(isEligibleResearchSymbol("TEST-USD", "us")).toBe(false);
  });
});
