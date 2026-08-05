import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("app/api/agents/theme-scout/route.ts", "utf8").replace(/\r\n/g, "\n");

// Theme Scout ran weekly for five weeks writing no agent_runs row at all: no run
// record, no duration, no error trail. Its only trace was watchlist rows whose
// created_at is pinned by upsert and whose updated_at is moved by unrelated
// migrations — so "did it run, and what did it find" was unanswerable, and an
// attempt to reconstruct run history from those timestamps produced 68
// misattributed ledger rows that had to be deleted.
describe("theme scout is observable", () => {
  it("opens an agent_runs row", () => {
    expect(src).toContain('agent_type: "theme_scout", status: "running"');
    expect(src).toContain('trigger_source: isCron ? "scheduled" : "manual"');
  });

  it("closes the run on EVERY terminal path, not just success", () => {
    // A row left "running" is indistinguishable from a hang — the exact class of
    // silence this change removes. Five paths: no-data, parse-fail, no-themes,
    // no-owner, success.
    expect((src.match(/await finishRun\(/g) ?? []).length).toBe(5);
    expect(src).toContain('await finishRun("error", "No market data available');
    expect(src).toContain('await finishRun("error", `LLM theme parse failed');
    expect(src).toContain('await finishRun("done", "LLM returned no themes.")');
    expect(src).toContain('await finishRun("error", "Owner profile unavailable');
  });

  it("never lets observability break the scout", () => {
    // The run row is telemetry; a failure to write it must not fail the agent.
    expect(src).toContain("/* observability must never block the scout */");
    expect(src).toContain("if (!runId) return;");
  });

  it("reports unmatched themes in the run summary", () => {
    // Vocabulary coverage is the signal for when to extend it, so it belongs in
    // the run record rather than only the HTTP response.
    expect(src).toContain("unmatched: ${unmatchedThemes.join");
  });
});
