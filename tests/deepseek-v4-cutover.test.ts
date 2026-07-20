import { describe, expect, it } from "vitest";
import { deepSeekThinkingConfig, TIER_MODELS } from "@/lib/llm-router";

describe("DeepSeek V4 cutover", () => {
  it("routes tiers to concrete non-retiring model IDs", () => {
    expect(TIER_MODELS.fast).toBe("deepseek-v4-flash");
    expect(TIER_MODELS.reasoning).toBe("deepseek-v4-pro");
  });

  it("keeps the cheap Flash tier explicitly non-thinking", () => {
    expect(deepSeekThinkingConfig("deepseek-v4-flash")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("keeps the Pro tier explicitly reasoning-enabled", () => {
    expect(deepSeekThinkingConfig("deepseek-v4-pro")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });
});
