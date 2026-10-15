import { describe, expect, it } from "vitest";
import { isViewerSharedReadRoute } from "./roles";

describe("score formula lab viewer access", () => {
  it("allows only the persisted GET view, never the owner-only mining write", () => {
    expect(isViewerSharedReadRoute("/api/learning/score-formula-lab", "GET")).toBe(true);
    expect(isViewerSharedReadRoute("/api/learning/score-formula-lab", "POST")).toBe(false);
    expect(isViewerSharedReadRoute("/api/agents/score-formula-lab/mine", "POST")).toBe(false);
  });
});
