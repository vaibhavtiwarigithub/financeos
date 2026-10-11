import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isWorkerId, isWorkerModel, subscriptionPrompt, validateSubscriptionResult, workerTokenHash } from "@/lib/llm-council/subscription";
import { sha256 } from "@/lib/llm-council/core";
import { endpointFor, forecastSchema, safeClientEnv } from "../scripts/council-subscription-worker.mjs";

const job = { expected_model: "test-model" };
const packet = { symbol: "TEST-NO-REAL-ASSET", facts: { as_of: "2026-10-10", growth: 8 } };
const forecast = { score: 52, confidence: 0.4, rationale: "Synthetic", bull_case: "Growth", bear_case: "Unknown", evidence_citations: [{ claim: "Growth 8", source: "facts.growth", as_of: "2026-10-10" }] };
const body = { job_id: "11111111-1111-4111-8111-111111111111", lease_id: "22222222-2222-4222-8222-222222222222", actual_model: "test-model", input_sha256: sha256(JSON.stringify(packet)), forecast };
describe("subscription worker boundary", () => {
  it("hashes only correctly shaped bearer credentials", () => {
    expect(workerTokenHash(`Bearer kcw_${"a".repeat(64)}`)).toBe(sha256(`kcw_${"a".repeat(64)}`));
    for (const header of [null, "Bearer service-role-key", "kcw_abc", `Bearer kcw_${"g".repeat(64)}`]) expect(workerTokenHash(header)).toBeNull();
  });
  it("rejects invalid identities and command-like model names", () => {
    expect(isWorkerId(body.job_id)).toBe(true); expect(isWorkerId("anything")).toBe(false);
    expect(isWorkerModel("gpt-6.1-sol")).toBe(true);
    for (const value of ["x; echo secret", "--flag", "", null]) expect(isWorkerModel(value)).toBe(false);
  });
  it("normalizes and hashes a valid result reproducibly", () => {
    const r = validateSubscriptionResult(body, job, packet);
    expect(r.result?.score).toBe(52); expect(r.tokens_in).toBeNull();
    expect(r.result_hash).toBe(validateSubscriptionResult({ ...body }, job, packet).result_hash);
  });
  it("rejects hallucinated evidence, substituted model and coerced scores", () => {
    expect(() => validateSubscriptionResult({ ...body, actual_model: "other" }, job, packet)).toThrow("model_mismatch");
    expect(() => validateSubscriptionResult({ ...body, forecast: { ...forecast, score: "52" } }, job, packet)).toThrow();
    expect(() => validateSubscriptionResult({ ...body, forecast: { ...forecast, evidence_citations: [{ claim: "x", source: "nonexistent", as_of: "unknown" }] } }, job, packet)).toThrow("model_citation_path_missing");
  });
  it("records failures without inventing neutral scores or token usage", () => {
    const r = validateSubscriptionResult({ ...body, forecast: undefined, failure_code: "authentication_required" }, job, packet);
    expect(r.result).toBeNull(); expect(r.tokens_out).toBeNull();
    expect(() => validateSubscriptionResult({ ...body, tokens_in: -1 }, job, packet)).toThrow("invalid_usage");
  });
  it("initial answers never see peers; debate preserves the frozen packet", () => {
    expect(subscriptionPrompt({ snapshot: packet, round: 0, peers: ["secret peer"] })).not.toContain("secret peer");
    expect(subscriptionPrompt({ snapshot: packet, round: 1, peers: ["opposing view"] })).toContain("opposing view");
  });
  it("keeps synthetic and late-availability forecasts out of existing IC", () => {
    const sql = readFileSync("supabase/migrations/20261011015916_llm_council_subscription_jobs.sql", "utf8");
    expect(sql).toContain("subscription_forward_v1");
    expect(sql).toContain("synthetic and run_id is null");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("if exists(select 1 from public.llm_council_jobs");
    expect(sql).toContain("j.lease_id is distinct from p_lease");
  });
  it("keeps Kairos and provider credentials out of model subprocesses", () => {
    const env = safeClientEnv({ PATH: "path", CODEX_HOME: "private-login-location", KAIROS_WORKER_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", ANTHROPIC_BASE_URL: "evil" } as unknown as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: "path", CODEX_HOME: "private-login-location" });
    expect(forecastSchema.additionalProperties).toBe(false);
  });
  it("only permits HTTPS production origins or loopback test origins", () => {
    expect(endpointFor("https://example.com")).toBe("https://example.com/api/agents/llm-council/worker");
    expect(endpointFor("http://localhost:3000")).toBe("http://localhost:3000/api/agents/llm-council/worker");
    for (const origin of ["http://example.com", "https://user:pass@example.com", "https://example.com/path"]) expect(() => endpointFor(origin)).toThrow();
  });
});
