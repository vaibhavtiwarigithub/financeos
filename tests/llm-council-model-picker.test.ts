import { describe, expect, it } from "vitest";
import { CODEX_SUBSCRIPTION_MODEL_OPTIONS, DEFAULT_CODEX_SUBSCRIPTION_MODEL } from "@/lib/llm-council/worker-model-options";

describe("Codex subscription model picker", () => {
  it("preselects the locally verified GPT-5.6 Luna membership model", () => {
    expect(DEFAULT_CODEX_SUBSCRIPTION_MODEL).toBe("gpt-5.6-luna");
    expect(CODEX_SUBSCRIPTION_MODEL_OPTIONS.some(option => option.id === DEFAULT_CODEX_SUBSCRIPTION_MODEL)).toBe(true);
  });

  it("keeps Codex membership choices separate from API billing and allows future exact IDs", () => {
    expect(CODEX_SUBSCRIPTION_MODEL_OPTIONS.map(option => option.id)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect((CODEX_SUBSCRIPTION_MODEL_OPTIONS as readonly { id: string }[]).some(option => option.id === "gpt-6-luna")).toBe(false);
  });
});
