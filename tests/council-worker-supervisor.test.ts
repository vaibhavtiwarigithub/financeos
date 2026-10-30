import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

describe("council worker supervisor output classification", () => {
  it("idles on an empty queue, continues after jobs, and pauses a failing client instead of draining the queue", async () => {
    const mod: any = require(resolve("scripts/council-worker-output.cjs"));
    expect(mod.classifyOutput("No claimable job.\n").kind).toBe("idle");
    expect(mod.classifyOutput('{"job":"x","status":"accepted","outcome":"forecast_submitted"}').kind).toBe("job");
    expect(mod.classifyOutput('{"job":"x","status":"failed","outcome":"quota_exhausted"}')).toMatchObject({ kind: "pause", ownerAction: true, why: "quota_exhausted" });
    expect(mod.classifyOutput('{"job":"x","status":"failed","outcome":"authentication_required"}')).toMatchObject({ kind: "pause", ownerAction: true, why: "authentication_required" });
    expect(mod.classifyOutput("worker_http_422: model_citation_path_missing").kind).toBe("error");
    expect(mod.classifyOutput("").kind).toBe("error");
  });
  it("pauses a worker after repeated client_failed instead of draining the queue", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("scripts/council-worker-supervisor.mjs", "utf8");
    expect(source).toContain("result.outcome === 'client_failed' ? (state.failStreak ?? 0) + 1 : 0");
    expect(source).toContain("state.failStreak >= 3");
    expect(source).toContain("paused 10 min: repeated client_failed");
  });
  it("stops a provider worker until owner action after authentication or quota failures", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("scripts/council-worker-supervisor.mjs", "utf8");
    expect(source).toContain("result.kind === 'pause' && result.ownerAction");
    expect(source).toContain("owner action required before restart");
    expect(source).toContain("return;");
  });
});
