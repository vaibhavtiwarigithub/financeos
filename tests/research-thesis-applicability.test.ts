import { describe, expect, it } from "vitest";
import { buildThesisOnlyPrompt, RESEARCH_THESIS_PROMPT_VERSION } from "@/lib/research-agent";
const scores: any = { fundamental_score: 55, technical_score: 0, sentiment_score: 75, macro_score: 65, insider_score: 50,
  evidence: { fundamental: {}, technical: { as_of: "2026-10-23", rsi14: 31 }, macro: { regime: "yellow" } }, dataQuality: {} };
describe("thesis applicability and horizon truth", () => {
  it("does not present a leveraged fund's company fundamentals as a failed gate", () => {
    const prompt = buildThesisOnlyPrompt("SOXL", false, scores, 41, 60);
    expect(prompt).toContain("Fundamental: NOT APPLICABLE");
    expect(prompt).toContain("Insider:     NOT APPLICABLE");
    expect(prompt).toContain("completed-data as of: 2026-10-23");
    expect(prompt).toContain("dedicated paper door evaluates current-session entry independently");
    expect(prompt).not.toContain("Fundamental: 55/100");
    expect(RESEARCH_THESIS_PROMPT_VERSION).toBe("research_thesis_v2_dimension_applicability");
  });
  it("preserves a company's genuinely missing fundamental evidence", () => {
    expect(buildThesisOnlyPrompt("AAPL", false, scores, 41, 60)).toContain("Fundamental: 55/100 | data unavailable");
  });
});
