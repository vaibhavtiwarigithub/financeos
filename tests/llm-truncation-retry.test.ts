import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const router = readFileSync(join(process.cwd(), "lib/llm-router.ts"), "utf8");
const mentorRoute = readFileSync(join(process.cwd(), "app/api/mentor/evaluate/route.ts"), "utf8");

// A reasoning model that runs out of budget mid-thought returns EMPTY content
// with finish_reason=length. The model is fine; the budget was too small.
//
// THE DEFECT. callDeepSeek's truncation error is deliberately worded to avoid the
// "invalid/not found" vocabulary that isModelUnavailable() keys on, so it does not
// raise the deprecated-model alert. But callLLM's ONLY retry path was gated on
// isModelUnavailable(), so the truncation error matched nothing and propagated.
// The error text ("retrying via same-tier fallback") and the comment beside it
// ("same-tier fallback fires for that one call") both promised a retry the
// control flow prevented.
//
// Measured: Judgment Coach was on the reasoning model deepseek-v4-pro with
// maxTokens 2000 (under half the 4096 default) and a prompt demanding a large
// JSON object. Every submission 500'd with reasoning_len 8764 and empty content.
// One successful evaluation ever recorded, 2026-07-12; failures wrote no
// agent_runs row, so it read as "unused" rather than "broken".

describe("truncated reasoning is retried, not treated as a dead model", () => {
  it("has a predicate distinct from isModelUnavailable", () => {
    expect(router).toContain("function isTruncatedReasoning(");
    const unavailable = router.match(/function isModelUnavailable[\s\S]*?\n}/)?.[0] ?? "";
    // The truncation wording must NOT match the dead-model predicate, or the
    // deprecated-model health alert fires on every budget overrun.
    expect(unavailable).not.toContain("finish_reason");
    expect(unavailable).not.toContain("no answer content");
  });

  it("checks truncation BEFORE the unavailable-model branch", () => {
    const truncAt = router.indexOf("if (isTruncatedReasoning(err))");
    const unavailAt = router.indexOf("isModelUnavailable(err) && fb");
    expect(truncAt).toBeGreaterThan(-1);
    expect(unavailAt).toBeGreaterThan(truncAt); // truncation handled first
  });

  it("retries the SAME model, not a sibling", () => {
    // Truncation is a budget problem. Swapping to a same-tier sibling would
    // truncate identically and waste a call proving it.
    const branch = router.slice(
      router.indexOf("if (isTruncatedReasoning(err))"),
      router.indexOf("} else if (isModelUnavailable(err)"),
    );
    expect(branch).toContain("dispatchProvider(model,");
    expect(branch).toContain("maxTokens: retryMax");
    expect(branch).not.toContain("dispatchProvider(fb");
  });

  it("retries with strictly more headroom than was requested", () => {
    const branch = router.slice(
      router.indexOf("if (isTruncatedReasoning(err))"),
      router.indexOf("} else if (isModelUnavailable(err)"),
    );
    expect(branch).toContain("Math.max(requested * 3, TRUNCATION_RETRY_MIN_TOKENS)");
    expect(router).toContain("export const TRUNCATION_RETRY_MIN_TOKENS = 16000");
  });

  it("surfaces the retry instead of hiding a doubled cost", () => {
    // A silent retry doubles the bill on every call of a misconfigured flow.
    const branch = router.slice(
      router.indexOf("if (isTruncatedReasoning(err))"),
      router.indexOf("} else if (isModelUnavailable(err)"),
    );
    expect(branch).toContain("model-truncation-retry:");
  });
});

describe("the predicate and the thrown message stay coupled", () => {
  it("matches the exact fragments callDeepSeek throws", () => {
    // These two strings are the contract between callDeepSeek and callLLM. If
    // either side is reworded independently, the retry silently stops firing and
    // the flow returns to hard-failing — with no test to notice.
    expect(router).toContain("returned no answer content (finish_reason=");
    const predicate = router.match(/function isTruncatedReasoning[\s\S]*?\n}/)?.[0] ?? "";
    expect(predicate).toContain('"no answer content"');
    expect(predicate).toContain('"finish_reason=length"');
  });

  it("the real production error string would be caught", () => {
    // Verbatim from the reproduced 500 on 2026-09-02.
    const real = "Error: DeepSeek model deepseek-v4-pro returned no answer content (finish_reason=length, reasoning_len=8764) — transient truncation, retrying via same-tier fallback";
    const lower = real.toLowerCase();
    expect(lower.includes("no answer content") && lower.includes("finish_reason=length")).toBe(true);
    // ...and would NOT be mistaken for a dead model.
    expect(/model.*(not exist|not found|does not exist|deprecat|invalid)|invalid_model|not_found_error|unknown model|\b404\b|\b400\b/.test(lower)).toBe(false);
  });
});

describe("mentor evaluate budget and failure visibility", () => {
  it("no longer passes the 2000-token budget that caused the outage", () => {
    expect(mentorRoute).not.toContain("maxTokens: 2000");
    expect(mentorRoute).toContain("const MENTOR_EVALUATE_MAX_TOKENS = 16000");
    expect(mentorRoute).toContain("maxTokens: MENTOR_EVALUATE_MAX_TOKENS");
  });

  it("writes an agent_runs row on FAILURE, not only on success", () => {
    // Without this, a flow broken since 2026-07-12 is indistinguishable from one
    // nobody used.
    expect(mentorRoute).toContain('status: "failed"');
    expect(mentorRoute).toContain("Evaluation FAILED for");
  });
});

// ── Reasoning budget floor ───────────────────────────────────────────────────
//
// THE AUDIT THAT MOTIVATED IT. Measured 2026-09-02 across 14 days of
// llm_call_log, EVERY failed LLM call in the system — 213 of them — was
// truncated reasoning, and every one was on the reasoning tier while every
// flash flow sat at zero failures:
//
//   research      197/561 (35%)  at maxTokens 1500 on deepseek-v4-pro
//   macro-read     11/11 (100%)  at maxTokens 1500 on deepseek-v4-pro
//   chat            0/82         on deepseek-v4-flash
//   holding-risk    0/60         on deepseek-v4-flash
//
// macro-read's own source comment records the SAME bug being fixed twice before
// (600 -> 1500, and research-agent 512 -> 1500), noting it "silently killed this
// agent for 4 days". A fifth constant bump would leave a sixth flow to find it
// in production, so the floor lives in the router.

describe("reasoning models get a budget they can actually use", () => {
  it("identifies the reasoning tier from TIER_MODELS, not a hardcoded id", () => {
    // A renamed reasoning tier must carry here automatically; a stale hardcoded
    // id would silently stop flooring the very model that needs it.
    expect(router).toContain("export function isReasoningModel(");
    const fn = router.match(/export function isReasoningModel[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn).toContain('TIER_MODELS["reasoning"]');
  });

  it("floors the budget BEFORE dispatch, not after a failure", () => {
    const floorAt = router.indexOf("if (isReasoningModel(model) && (opts.maxTokens ?? 4096) < REASONING_MIN_TOKENS)");
    const firstDispatch = router.indexOf("result = await dispatchProvider(model, effectiveOpts)");
    expect(floorAt).toBeGreaterThan(-1);
    expect(firstDispatch).toBeGreaterThan(floorAt);
  });

  it("dispatches the FLOORED options everywhere, including the fallbacks", () => {
    // A fallback that re-sent the original small budget would truncate again.
    expect(router).not.toMatch(/dispatchProvider\((?:model|fb|deepseekFb), opts\)/);
    expect(router).toContain("dispatchProvider(fb, effectiveOpts)");
    expect(router).toContain("dispatchProvider(deepseekFb, effectiveOpts)");
  });

  it("bases the truncation retry on the floored budget, not the original", () => {
    expect(router).toContain("const requested = effectiveOpts.maxTokens ?? 4096");
  });

  it("floors to a value proven sufficient, and agrees with the retry floor", () => {
    // Observed reasoning runs to ~8.8k tokens; mentor-evaluate needed ~3.9k of
    // answer on top. A floor below that just moves the failure.
    expect(router).toContain("export const REASONING_MIN_TOKENS = 16000");
    expect(router).toContain("export const TRUNCATION_RETRY_MIN_TOKENS = 16000");
  });

  it("says the cheaper alternative in the alert rather than only raising cost", () => {
    // A flow wanting 400 tokens of prose should move to the non-thinking tier,
    // not pay for 16k of reasoning it discards.
    const branch = router.slice(
      router.indexOf("reasoning-budget-floored:"),
      router.indexOf("reasoning-budget-floored:") + 1200,
    );
    expect(branch).toContain("assign a non-reasoning model");
  });
});
