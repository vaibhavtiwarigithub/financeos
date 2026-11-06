import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toRpcEvaluation, type RuleSelectionEvaluation } from "@/lib/strategy-replay/autonomous-template-selector";

// Incident 2026-11-06: apply_autonomous_rule_evaluations reads config_id / selector_version (snake_case) but the caller sent camelCase,
// so every call raised "evaluation candidate is not an active market-local shadow" and the autonomous tournament alerted critical.
const evaluation: RuleSelectionEvaluation = {
  configId: "11111111-1111-4111-8111-111111111111", status: "insufficient", selectorVersion: "paired-horizon-spaced-forward-v2",
  pairedSessions: 0, nonoverlapWindows: 0, trialCount: 1, meanRuleReturnPct: null, meanBaselineReturnPct: null, meanPairedExcessPct: null,
  oneSidedT: null, requiredT: 2, maxDrawdownRulePct: null, maxDrawdownBaselinePct: null, positiveWindowFraction: null,
  firstHalfExcessPct: null, secondHalfExcessPct: null, reason: "x",
};

describe("autonomous selector RPC payload", () => {
  it("carries the snake_case identity keys the stored function reads", () => {
    const row = toRpcEvaluation(evaluation);
    expect(row.config_id).toBe(evaluation.configId);
    expect(row.selector_version).toBe(evaluation.selectorVersion);
  });
  it("keeps the camelCase evidence fields the SQL evidence gate reads", () => {
    const row = toRpcEvaluation({ ...evaluation, pairedSessions: 61, nonoverlapWindows: 21, oneSidedT: 3.1 });
    expect(row.pairedSessions).toBe(61);
    expect(row.nonoverlapWindows).toBe(21);
    expect(row.oneSidedT).toBe(3.1);
    expect(row.status).toBe("insufficient");
  });
  it("never emits an undefined identity (a missing config would silently match nothing in SQL)", () => {
    const { configId, ...rest } = evaluation;
    void configId;
    expect(toRpcEvaluation(rest as RuleSelectionEvaluation).config_id).toBeNull();
  });
  it("is the payload the learner actually sends", () => {
    const src = readFileSync("lib/strategy-replay/autonomous-template-selector.ts", "utf8");
    expect(src).toContain("p_evaluations: evaluations.map(toRpcEvaluation)");
  });
  it("matches the keys the deployed SQL function reads", () => {
    const sql = readFileSync("supabase/migrations/20261030205231_autonomous_rule_paper_selector.sql", "utf8");
    for (const key of ["config_id", "selector_version", "pairedSessions", "nonoverlapWindows", "oneSidedT", "requiredT"]) {
      expect(sql).toContain(`'${key}'`);
    }
  });
});

describe("tournament alert lifecycle", () => {
  it("resolves the critical after a successful tournament run (it was only ever raised)", () => {
    const learner = readFileSync("app/api/agents/learner/route.ts", "utf8");
    expect(learner).toContain("resolveIssue(`autonomous-rule-tournament:${LEARN_MARKET}`");
  });
});
