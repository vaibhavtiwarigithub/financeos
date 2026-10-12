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

describe("council prompts stay inside the output-token cap", () => {
  it("both forecast prompts demand a compact answer (live run 2026-10-12 was truncated at 900 tokens)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    const clauses = source.match(/Be compact: rationale at most 600 characters/g) ?? [];
    expect(clauses).toHaveLength(2);
  });
  it("tells models the exact citation format and repairs a rejected reply once", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    expect(source.match(/\$\{citationGuidance\(snapshot as Record<string, unknown>\)\}/g) ?? []).toHaveLength(2);
    expect(source.match(/await invokeWithRepair\(/g) ?? []).toHaveLength(2);
    expect(source).toContain("EXACTLY ONE dotted path");
    // Only validation failures are repaired, never provider/budget failures, and never past the runtime guard.
    expect(source).toContain("model_citation_|model_citations_required");
    expect(source).toContain("Date.now() - startedAt > 150_000");
    // The repair gets its own turn row (attempt 1); the unique key includes attempt (migration 20261012144810).
    expect(source).toContain("attempt: 1 })");
    expect(source).toContain("attempt: args.attempt ?? 0");
    expect(readFileSync("supabase/migrations/20261012144810_llm_council_turns_repair_attempt.sql", "utf8")).toContain("(run_id, model_requested, turn_role, round, attempt)");
  });
});
