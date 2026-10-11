import { describe, expect, it } from "vitest";
import { CODEX_SUBSCRIPTION_MODEL_OPTIONS, DEFAULT_CODEX_SUBSCRIPTION_MODEL } from "@/lib/llm-council/worker-model-options";
import { COUNCIL_MODEL_CATALOG, isValidCouncilEffort, supportedCouncilEfforts } from "@/lib/llm-model-catalog";

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

  it("offers GPT-6 Luna and only its documented effort values on the API council", () => {
    expect(supportedCouncilEfforts("gpt-6-luna")).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(isValidCouncilEffort("gpt-6-luna", "max")).toBe(true);
    expect(isValidCouncilEffort("gpt-6-luna", "minimal")).toBe(false);
  });

  it("groups current text API model options by the requested providers and keeps legacy CLI models separate", () => {
    const providers = new Set(COUNCIL_MODEL_CATALOG.map(model => model.provider));
    expect([...providers]).toEqual(expect.arrayContaining(["Anthropic", "OpenAI", "xAI", "Google", "DeepSeek"]));
    expect(COUNCIL_MODEL_CATALOG.some(model => model.id === "gpt-6-luna")).toBe(true);
    expect(COUNCIL_MODEL_CATALOG.some(model => model.id === "claude-sonnet-5")).toBe(true);
    expect(COUNCIL_MODEL_CATALOG.some(model => model.id === "grok-4.7")).toBe(true);
    expect(COUNCIL_MODEL_CATALOG.some(model => model.id === "gemini-3.8-flash")).toBe(true);
    expect((COUNCIL_MODEL_CATALOG as readonly { id: string }[]).some(model => model.id === "gpt-5.6-luna")).toBe(false);
  });
});
