import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

describe("council worker supervisor output classification", () => {
  it("idles on an empty queue, continues after jobs, and pauses a failing client instead of draining the queue", async () => {
    const mod: any = await import(/* @vite-ignore */ pathToFileURL(resolve("scripts/council-worker-supervisor.mjs")).href);
    expect(mod.classifyOutput("No claimable job.\n").kind).toBe("idle");
    expect(mod.classifyOutput('{"job":"x","status":"accepted","outcome":"forecast_submitted"}').kind).toBe("job");
    expect(mod.classifyOutput('{"job":"x","status":"failed","outcome":"quota_exhausted"}')).toMatchObject({ kind: "pause", why: "quota_exhausted" });
    expect(mod.classifyOutput('{"job":"x","status":"failed","outcome":"authentication_required"}')).toMatchObject({ kind: "pause", why: "authentication_required" });
    expect(mod.classifyOutput("worker_http_422: model_citation_path_missing").kind).toBe("error");
    expect(mod.classifyOutput("").kind).toBe("error");
  });
});
