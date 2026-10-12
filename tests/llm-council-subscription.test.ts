import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isWorkerId, isWorkerModel, subscriptionPrompt, validateSubscriptionResult, workerTokenHash } from "@/lib/llm-council/subscription";
import { sha256 } from "@/lib/llm-council/core";

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
    expect(validateSubscriptionResult({ ...body, forecast: undefined, failure_code: "client_failed" }, job, packet).failure_code).toBe("client_failed");
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
    // The worker is a standalone ESM executable. Run it through Node itself so
    // Vitest does not try to transform the .mjs script with its TS test loader.
    const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const worker = await import(${JSON.stringify(moduleUrl)});
      const env = worker.safeClientEnv({ PATH: "path", CODEX_HOME: "private-login-location", KAIROS_WORKER_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", ANTHROPIC_BASE_URL: "evil" });
      process.stdout.write(JSON.stringify({ env, additionalProperties: worker.forecastSchema.additionalProperties }));
    `], { encoding: "utf8" }));
    expect(result.env).toEqual({ PATH: "path", CODEX_HOME: "private-login-location" });
    expect(result.additionalProperties).toBe(false);
  });
  it("only permits HTTPS production origins or loopback test origins", () => {
    const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const worker = await import(${JSON.stringify(moduleUrl)});
      const valid = [worker.endpointFor("https://example.com"), worker.endpointFor("http://localhost:3000")];
      const invalid = ["http://example.com", "https://user:pass@example.com", "https://example.com/path"].map(value => {
        try { worker.endpointFor(value); return false; } catch { return true; }
      });
      process.stdout.write(JSON.stringify({ valid, invalid }));
    `], { encoding: "utf8" }));
    expect(result.valid).toEqual(["https://example.com/api/agents/llm-council/worker", "http://localhost:3000/api/agents/llm-council/worker"]);
    expect(result.invalid).toEqual([true, true, true]);
  });
  it("classifies local CLI failures without persisting provider diagnostics", () => {
    const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const worker = await import(${JSON.stringify(moduleUrl)});
      const classify = worker.clientFailureCategory;
      const persist = worker.persistedFailureCode;
      const diagnostic = worker.safeLocalDiagnostic;
      process.stdout.write(JSON.stringify([
        classify({ message: "client_failed", diagnostic: "Usage limit reached" }),
        classify({ message: "client_failed", diagnostic: "Model not found" }),
        classify({ message: "client_failed", diagnostic: "Invalid JSON schema" }),
        classify({ message: "client_failed", diagnostic: "opaque stderr" }),
        persist("authentication_required"), persist("subscription_quota_or_capacity"), persist("structured_output_rejected"), persist("unclassified_cli_failure"),
        diagnostic({ diagnostic: "API error: token=very-secret-value contact person@example.com at C:\\\\Users\\\\vaibh\\\\private" }, false),
        diagnostic({ diagnostic: "API error: token=very-secret-value contact person@example.com at C:\\\\Users\\\\vaibh\\\\private" }, true),
        diagnostic({ diagnostic: "FROZEN SNAPSHOT TEST-NO-REAL-ASSET" }, true),
      ]));
    `], { encoding: "utf8" }));
    expect(result.slice(0, 8)).toEqual(["subscription_quota_or_capacity", "model_unavailable", "structured_output_rejected", "unclassified_cli_failure", "authentication_required", "quota_exhausted", "invalid_output", "client_failed"]);
    expect(result[8]).toBeNull();
    expect(result[9]).not.toMatch(/very-secret-value|person@example.com|vaibh|private/);
    expect(result[10]).toBe("CLI diagnostic echoed synthetic prompt; content redacted");
  });
  it("parses Claude's JSON envelope and rejects a model identity mismatch", () => {
    const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const worker = await import(${JSON.stringify(moduleUrl)});
      const raw = JSON.stringify({ result: ${JSON.stringify(JSON.stringify(forecast))}, modelUsage: { "claude-sonnet-4-6": { inputTokens: 7, outputTokens: 4 } }, usage: { input_tokens: 7, output_tokens: 4 } });
      const good = worker.parseClaudeResponse(raw, "claude-sonnet-4-6");
      let mismatch = false;
      try { worker.parseClaudeResponse(raw, "other-model"); } catch (error) { mismatch = error.message === "model_mismatch"; }
      let cliError = null;
      try { worker.parseClaudeResponse(JSON.stringify({ is_error: true, error: { message: "TEST-NO-REAL-ASSET: synthetic provider failure" } }), "claude-sonnet-4-6"); }
      catch (error) { cliError = { category: worker.clientFailureCategory(error), diagnostic: worker.safeLocalDiagnostic(error, true) }; }
      let invalidResult = null;
      try { worker.parseClaudeResponse(JSON.stringify({ result: "TEST-NO-REAL-ASSET: synthetic CLI result", modelUsage: { "claude-sonnet-4-6": {} } }), "claude-sonnet-4-6"); }
      catch (error) { invalidResult = { category: worker.clientFailureCategory(error), failure: worker.persistedFailureCode(worker.clientFailureCategory(error)), diagnostic: worker.safeLocalDiagnostic(error, true) }; }
      process.stdout.write(JSON.stringify({ good, mismatch, cliError, invalidResult }));
    `], { encoding: "utf8" }));
    expect(result.good.forecast).toEqual(forecast);
    expect(result.good.actual_model).toBe("claude-sonnet-4-6");
    expect(result.mismatch).toBe(true);
    expect(result.cliError).toEqual({ category: "unclassified_cli_failure", diagnostic: "CLI diagnostic echoed synthetic prompt; content redacted" });
    expect(result.invalidResult).toEqual({ category: "invalid_cli_output", failure: "invalid_output", diagnostic: "CLI diagnostic echoed synthetic prompt; content redacted" });
  });
  it("finds a native Windows executable and diagnoses Claude's stdout error envelope", () => {
    const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const worker = await import(${JSON.stringify(moduleUrl)});
      const exists = path => /bin.claude\.exe$/.test(path);
      const found = worker.resolveNativeExecutable("claude", { PATH: "C:/other;C:/bin" }, exists);
      const missing = worker.resolveNativeExecutable("claude", { PATH: "C:/other" }, exists);
      // Non-zero exit with the error envelope on STDOUT and an empty stderr: the real Claude CLI shape.
      const fromEnvelope = worker.failureFromClaudeExit(JSON.stringify({ is_error: true, result: "Please run /login" }), "");
      const fromStderr = worker.failureFromClaudeExit("not json", "boom on stderr");
      process.stdout.write(JSON.stringify({ found, missing,
        envelope: { category: worker.clientFailureCategory(fromEnvelope), diagnostic: fromEnvelope.diagnostic },
        stderr: { category: worker.clientFailureCategory(fromStderr), diagnostic: fromStderr.diagnostic } }));
    `], { encoding: "utf8" }));
    expect(result.found).toMatch(/claude\.exe$/);
    expect(result.missing).toBeNull();
    expect(result.envelope).toEqual({ category: "authentication_required", diagnostic: "Please run /login" });
    expect(result.stderr).toEqual({ category: "unclassified_cli_failure", diagnostic: "boom on stderr" });
  });
  it("passes a large non-ASCII prompt to a client byte-for-byte on this platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "kairos-worker-test-"));
    try {
      const script = join(dir, "echo.js");
      writeFileSync(script, 'let s="";process.stdin.setEncoding("utf8").on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({len:s.length,head:s.slice(0,12),tail:s.slice(-6)})));');
      const moduleUrl = pathToFileURL(resolve("scripts/council-subscription-worker.mjs")).href;
      const prompt = "héllo ₹ — " + "x".repeat(60_000) + "END";
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, prompt, "utf8");
      const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        const worker = await import(${JSON.stringify(moduleUrl)});
        const out = await worker.client("node", [${JSON.stringify(script)}], (await import("node:fs")).readFileSync(${JSON.stringify(promptFile)}, "utf8"), ${JSON.stringify(dir)});
        process.stdout.write(out);
      `], { encoding: "utf8" }));
      // PowerShell may append one trailing newline; nothing else may change.
      expect(out.head.startsWith("héllo ₹ — ")).toBe(true);
      expect(out.len === prompt.length || out.len === prompt.length + 1 || out.len === prompt.length + 2).toBe(true);
      expect(out.tail.replace(/\s+$/, "").endsWith("END")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
