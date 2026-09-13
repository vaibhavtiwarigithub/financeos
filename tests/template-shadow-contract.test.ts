import { describe, expect, it } from "vitest";
import { parseTemplateShadowRequest } from "@/lib/strategy-replay/template-shadow-contract";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const rule = {
  id: "trend-v1", label: "Trend", role: "entry", market: "us", universe: ["SPY"],
  horizonSessions: 10, execution: "next_open", positionSizePct: 0.1,
  entry: { op: "always" as const }, exit: { op: "held_sessions" as const, cmp: ">=" as const, value: 10 }, ruleVersion: "v1",
};
const request = (over: Record<string, unknown> = {}) => ({
  market: "us", template_ids: [a], kind: "template", operator: "single", weights: {},
  rule_version: "v1", trial_family_id: "us-entry-v1", rule_spec: rule, ...over,
});

describe("template shadow contract", () => {
  it("freezes a complete deterministic template identity", () => {
    const parsed = parseTemplateShadowRequest(request());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses an incomplete, non-deterministic, or cross-market request", () => {
    expect(parseTemplateShadowRequest(request({ rule_version: "" })).ok).toBe(false);
    expect(parseTemplateShadowRequest(request({ rule_spec: { ...rule, market: "india" } })).ok).toBe(false);
    expect(parseTemplateShadowRequest(request({ template_ids: [a, a] })).ok).toBe(false);
  });

  it("counts an operator and weights as identity rather than silently colliding", () => {
    const one = parseTemplateShadowRequest(request({ kind: "combination", template_ids: [a, b], operator: "parallel_sleeves", weights: { [a]: 0.5, [b]: 0.5 } }));
    const two = parseTemplateShadowRequest(request({ kind: "combination", template_ids: [a, b], operator: "parallel_sleeves", weights: { [a]: 0.6, [b]: 0.4 } }));
    expect(one.ok && two.ok && one.value.fingerprint).not.toBe(two.ok && two.value.fingerprint);
  });
});
