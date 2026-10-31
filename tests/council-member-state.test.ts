import { describe, expect, it } from "vitest";
import { buildCouncilMemberState } from "@/lib/research/council-member-state";

describe("council member completeness", () => {
  const config = { participant_models: ["deepseek-flash"], subscription_worker_ids: ["w-claude", "w-codex"] };
  const workers = [
    { id: "w-claude", family: "claude", expected_model: "claude-sonnet-5-5" },
    { id: "w-codex", family: "codex", expected_model: "gpt-5.6-luna" },
  ];
  it("shows queued and expired members instead of silently omitting them", () => {
    const rows = buildCouncilMemberState(config, [
      { model_requested: "deepseek-flash", execution_source: "api", final_score: 66 },
    ], workers, [
      { worker_id: "w-claude", status: "queued", failure_code: null },
      { worker_id: "w-codex", status: "expired", failure_code: "deadline_exceeded" },
    ]);
    expect(rows.map(x => [x.model, x.score, x.status, x.reason])).toEqual([
      ["deepseek-flash", 66, "completed", null],
      ["claude-sonnet-5-5", null, "queued", null],
      ["gpt-5.6-luna", null, "expired", "deadline_exceeded"],
    ]);
  });
  it("handles five selected models without hardcoding three families", () => {
    const rows = buildCouncilMemberState({ participant_models: ["deepseek-flash", "gemini-2.5-flash", "grok-4-fast"], subscription_worker_ids: ["w-claude", "w-codex"] }, [], workers, []);
    expect(rows).toHaveLength(5);
    expect(rows.find(x => x.model === "gemini-2.5-flash")?.member).toBeNull();
  });
  it("uses the latest debate round and does not call a missing forecast completed", () => {
    const rows = buildCouncilMemberState(config, [], workers, [
      { worker_id: "w-claude", round: 0, status: "completed", failure_code: null },
      { worker_id: "w-claude", round: 1, status: "expired", failure_code: "deadline_expired" },
      { worker_id: "w-codex", round: 0, status: "completed", failure_code: null },
    ]);
    expect(rows[1]).toMatchObject({ score: null, status: "expired", reason: "deadline_expired" });
    expect(rows[2]).toMatchObject({ score: null, status: "missing_result", reason: "Completed job has no stored forecast" });
  });
  it("shows an accepted hybrid job score before its batch is terminal", () => {
    const rows = buildCouncilMemberState(config, [
      { model_requested: "deepseek-flash", execution_source: "api", final_score: 66 },
    ], workers, [
      { worker_id: "w-claude", round: 0, status: "queued", failure_code: null },
      { worker_id: "w-codex", round: 0, status: "completed", failure_code: null, result: { score: 74, confidence: 0.7 } },
    ]);
    expect(rows.find(x => x.member === "codex")).toMatchObject({ score: 74, status: "completed", reason: null });
    expect(rows.find(x => x.member === "claude")).toMatchObject({ score: null, status: "queued" });
  });
});
