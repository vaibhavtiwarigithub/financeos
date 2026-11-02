import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/system-health", () => ({ reportIssue: vi.fn(async () => {}), resolveIssue: vi.fn(async () => {}) }));
vi.mock("@/lib/llm-keys", () => ({ getProviderKey: vi.fn(async () => "synthetic-test-key") }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }));
import { callLLM, isReasoningModel, priceFor } from "@/lib/llm-router";
import { COUNCIL_MODELS, isCouncilModel } from "@/lib/llm-model-catalog";
import { createCouncilBudgetGuard } from "@/lib/llm-council/limits";

describe("November 2026 official catalog contracts", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("dispatches GPT-6 Luna as a text API request with medium effort and a reserved reasoning budget", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"score":60}' } }], usage: { prompt_tokens: 100, completion_tokens: 1200 } })));
    expect(isCouncilModel("gpt-6-luna")).toBe(true);
    expect(isReasoningModel("gpt-6-luna")).toBe(true);
    expect(COUNCIL_MODELS.filter(m => m === "gpt-6-luna")).toHaveLength(1);
    const result = await callLLM({ task: "summarize", model: "gpt-6-luna", prompt: "Synthetic packet", maxTokens: 900 });
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(opts!.body as string)).toEqual({ model: "gpt-6-luna", messages: [{ role: "user", content: "Synthetic packet" }], max_completion_tokens: 16000, reasoning_effort: "medium" });
    expect(result).toMatchObject({ text: '{"score":60}', model: "gpt-6-luna", tokensIn: 100, tokensOut: 1200 });
    expect(result.costUsd).toBeCloseTo(0.00061);
    const [input, output] = priceFor("gpt-6-luna");
    const reserve = (100 * input + 16000 * output) / 1e6;
    expect(reserve).toBeGreaterThan(result.costUsd);
    expect(createCouncilBudgetGuard(0, reserve - 0.000001).reserve(reserve)).toBeNull();
    // The collector shares the same pricing and reasoning classification.
    const collector = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    expect(collector).toContain("priceFor(model)");
    expect(collector).toContain("isReasoningModel(model) ? Math.max(maxOutput, 16_000)");
  });

  it.each(["claude-haiku-4-5", "claude-haiku-4-5-20251001"])("prices %s at standard first-party API rates", model => {
    expect(priceFor(model)).toEqual([1, 5]);
  });

  it("does not turn a GPT-6 provider failure into a fabricated result", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("temporarily unavailable", { status: 503 }));
    await expect(callLLM({ task: "summarize", model: "gpt-6-luna", prompt: "Synthetic packet" })).rejects.toThrow("OpenAI 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 1200])("bills Gemini output plus thoughts (%s) exactly once", async thoughts => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Synthetic answer" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: thoughts, totalTokenCount: 1500 } })));
    const result = await callLLM({ task: "summarize", model: "gemini-2.5-flash", prompt: "Synthetic packet", maxTokens: 2000 });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ generationConfig: { maxOutputTokens: 2000 } });
    expect(result.tokensOut).toBe(200 + (thoughts ?? 0));
    expect(result.costUsd).toBeCloseTo((100 * 0.30 + (200 + (thoughts ?? 0)) * 2.50) / 1e6);
    expect(priceFor("gemini-2.5-flash")).toEqual([0.30, 2.50]);
  });
});
