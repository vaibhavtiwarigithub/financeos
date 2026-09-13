// Immutable input contract for a template-backed forward shadow.
//
// This module is deliberately independent of PaperTrader, proposals, orders,
// and the scorer.  A strategy can enter the experiment ledger only after its
// complete, deterministic RuleSpec has been frozen here.

import { specFingerprint, validateSpec, type RuleSpec } from "./rule-spec";

export type TemplateShadowKind = "template" | "combination";
export type TemplateShadowOperator = "single" | "parallel_sleeves" | "confirmation" | "regime_routing";

export interface TemplateShadowRequest {
  market: "us" | "india";
  templateIds: string[];
  kind: TemplateShadowKind;
  operator: TemplateShadowOperator;
  /** Optional only for `single` and `confirmation`; otherwise weights sum to 1. */
  weights: Record<string, number>;
  ruleVersion: string;
  trialFamilyId: string;
  ruleSpec: RuleSpec;
}

export interface ParsedTemplateShadowRequest {
  ok: true;
  value: TemplateShadowRequest & { fingerprint: string };
}

export interface RejectedTemplateShadowRequest {
  ok: false;
  errors: string[];
}

export type TemplateShadowParseResult = ParsedTemplateShadowRequest | RejectedTemplateShadowRequest;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPS = new Set<TemplateShadowOperator>(["single", "parallel_sleeves", "confirmation", "regime_routing"]);

/**
 * Parse before the RPC is called. The database repeats all money/data-integrity
 * checks; this function exists to give the owner a typed refusal rather than a
 * generic database error.
 */
export function parseTemplateShadowRequest(body: unknown): TemplateShadowParseResult {
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const market = b.market === "india" ? "india" : b.market === "us" ? "us" : null;
  const rawIds = Array.isArray(b.template_ids) ? b.template_ids : [];
  const templateIds = rawIds.filter((v): v is string => typeof v === "string" && UUID.test(v))
    .map(v => v.toLowerCase()).sort();
  const kind: TemplateShadowKind | null = b.kind === "template" || b.kind === "combination" ? b.kind : null;
  const operator = typeof b.operator === "string" && OPS.has(b.operator as TemplateShadowOperator)
    ? b.operator as TemplateShadowOperator : null;
  const weights: Record<string, number> = {};
  if (b.weights && typeof b.weights === "object" && !Array.isArray(b.weights)) {
    for (const [key, value] of Object.entries(b.weights as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) weights[key] = value;
    }
  }
  const ruleVersion = typeof b.rule_version === "string" ? b.rule_version.trim() : "";
  const trialFamilyId = typeof b.trial_family_id === "string" ? b.trial_family_id.trim() : "";
  const ruleSpec = b.rule_spec as RuleSpec;
  const errors: string[] = [];
  if (!market) errors.push("market must be us or india");
  if (!kind) errors.push("kind must be template or combination");
  if (!operator) errors.push("operator is unsupported");
  if (!templateIds.length || templateIds.length !== rawIds.length || new Set(templateIds).size !== templateIds.length) {
    errors.push("template_ids must be unique UUIDs");
  }
  if (templateIds.length > 3) errors.push("at most three template_ids are allowed");
  if (kind === "template" && templateIds.length !== 1) errors.push("a template shadow needs exactly one template");
  if (kind === "template" && operator !== "single") errors.push("a template shadow requires operator=single");
  if (kind === "combination" && templateIds.length < 2) errors.push("a combination needs two or three templates");
  if (kind === "combination" && operator === "single") errors.push("a combination requires a combination operator");
  if (!ruleVersion || ruleVersion.length > 80) errors.push("rule_version is required and must be <= 80 characters");
  if (!trialFamilyId || trialFamilyId.length > 120) errors.push("trial_family_id is required and must be <= 120 characters");
  if (!ruleSpec || typeof ruleSpec !== "object") errors.push("rule_spec is required");
  else {
    errors.push(...validateSpec(ruleSpec));
    if (market && ruleSpec.market !== market) errors.push("rule_spec.market must match market");
    if (ruleSpec.ruleVersion !== ruleVersion) errors.push("rule_spec.ruleVersion must match rule_version");
  }
  const values = Object.values(weights);
  if (!values.every(v => v > 0 && v <= 1)) errors.push("weights must be finite fractions in (0, 1]");
  if ((operator === "parallel_sleeves" || operator === "regime_routing") && Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-9) {
    errors.push("parallel_sleeves and regime_routing weights must sum to 1");
  }
  if (Object.keys(weights).some(id => !templateIds.includes(id.toLowerCase()))) errors.push("weights may name only selected templates");
  if (errors.length || !market || !kind || !operator || !ruleSpec) return { ok: false, errors };

  // The identity includes every behavior-defining input. `specFingerprint`
  // includes the complete rule grammar; wrapping it prevents a source-template
  // or combination change from masquerading as the same experiment.
  const canonical = JSON.stringify({
    market, templateIds, kind, operator,
    weights: Object.fromEntries(Object.entries(weights).sort(([a], [b]) => a.localeCompare(b))),
    ruleVersion, trialFamilyId, ruleSpecFingerprint: specFingerprint(ruleSpec),
  });
  // Reuse the project’s stable 64-hex implementation through the spec wrapper.
  const fingerprint = specFingerprint({ ...ruleSpec, id: `template-shadow:${canonical}` });
  return { ok: true, value: { market, templateIds, kind, operator, weights, ruleVersion, trialFamilyId, ruleSpec, fingerprint } };
}
