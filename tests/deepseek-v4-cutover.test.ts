import { describe, expect, it } from "vitest";
import { deepSeekThinkingConfig, TIER_MODELS } from "@/lib/llm-router";

describe("DeepSeek V4 cutover", () => {
  it("routes tiers to concrete non-retiring model IDs", () => {
    expect(TIER_MODELS.fast).toBe("deepseek-flash");
    expect(TIER_MODELS.reasoning).toBe("deepseek-flash");
  });

  it("keeps the cheap Flash tier explicitly non-thinking", () => {
    expect(deepSeekThinkingConfig("deepseek-flash")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("keeps the Pro tier explicitly reasoning-enabled", () => {
    expect(deepSeekThinkingConfig("deepseek-v4-pro")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("maps exposed DeepSeek effort levels to API-supported effort levels", () => {
    expect(deepSeekThinkingConfig("deepseek-flash", "none")).toEqual({ thinking: { type: "disabled" } });
    expect(deepSeekThinkingConfig("deepseek-flash", "low")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(deepSeekThinkingConfig("deepseek-v4-pro", "medium")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(deepSeekThinkingConfig("deepseek-v4-pro", "max")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });
});
