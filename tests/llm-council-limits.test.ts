import { describe, expect, it } from "vitest";
import {
  councilCallsPerSymbol,
  councilProviderTimeoutMs,
  effectiveCouncilDebateRounds,
  limitCouncilCandidates,
  validCouncilConsensus,
  validCouncilParticipants,
} from "@/lib/llm-council/limits";
import { providerForModel } from "@/lib/llm-keys";
import { isCouncilModel } from "@/lib/llm-model-catalog";

describe("LLM council bounded configuration", () => {
  const provider = (model: string) => model.split(":")[0] ?? null;
  const supported = (model: string) => /^(a|b|c|d|e):/.test(model);

  it("allows 1–5 participants, requires distinct models and diverse providers for multi-model councils", () => {
    expect(validCouncilParticipants(["a:one"], supported, provider)).toBe(true);
    expect(validCouncilParticipants(["a:one", "b:two"], supported, provider)).toBe(true);
    expect(validCouncilParticipants(["a:1", "b:2", "c:3", "d:4", "e:5"], supported, provider)).toBe(true);
    expect(validCouncilParticipants([], supported, provider)).toBe(false);
    expect(validCouncilParticipants(Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(97 + i)}:${i}`), supported, provider)).toBe(false);
    expect(validCouncilParticipants(["a:one", "a:two"], supported, provider)).toBe(false);
    expect(validCouncilParticipants(["a:one", "a:one"], supported, provider)).toBe(false);
  });

  it("turns off debate for a single-model baseline and keeps worst-case calls inside the wait budget", () => {
    expect(effectiveCouncilDebateRounds(1, 3)).toBe(0);
    expect(councilCallsPerSymbol(1, 3)).toBe(2); // baseline + synthesis
    expect(councilCallsPerSymbol(5, 3)).toBe(21);
    expect(councilCallsPerSymbol(5, 3) * councilProviderTimeoutMs(5, 3)).toBeLessThanOrEqual(165_000);
    expect(limitCouncilCandidates([1, 2, 3], 5, 5, 3)).toHaveLength(1);
  });

  it("requires enough distinct providers for multi-model consensus", () => {
    expect(validCouncilConsensus(1, 1, 1)).toBe(true);
    expect(validCouncilConsensus(2, 1, 1)).toBe(false);
    expect(validCouncilConsensus(2, 2, 2)).toBe(true);
    expect(validCouncilConsensus(5, 4, 2)).toBe(true);
  });

  it("classifies the DeepSeek-named Groq distillation model under Groq", () => {
    expect(providerForModel("deepseek-r1-distill-llama-70b")).toBe("groq");
    expect(isCouncilModel("deepseek-r1-distill-llama-70b")).toBe(false);
    expect(isCouncilModel("llama-3.3-70b-versatile")).toBe(false);
    expect(isCouncilModel("gemini-2.5-flash")).toBe(true);
  });
});
