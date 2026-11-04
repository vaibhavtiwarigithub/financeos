import { createHash, randomUUID } from "node:crypto";
import { isEventDirection } from "@/lib/events/vocabulary";
import { CHAMBERS, CONTROL_STATES, ELECTION_STAGES, EXPOSURE_STANCES, POLICY_DOMAINS, POLICY_STAGES } from "@/lib/events/policy-constants";
export { CHAMBERS, CONTROL_STATES, ELECTION_STAGES, EXPOSURE_STANCES, POLICY_DOMAINS, POLICY_STAGES } from "@/lib/events/policy-constants";

export type PolicyExposureInput = {
  symbol: string;
  exposure_stance: typeof EXPOSURE_STANCES[number];
  rationale: string;
  source_name: string;
  source_url: string;
  source_published_at: string;
};

export type PolicyContextInput = {
  policy_chain_id?: string;
  family: "election" | "federal_policy";
  stage_status: string;
  policy_domain?: string | null;
  chamber?: string | null;
  previous_control?: string | null;
  resulting_control?: string | null;
  event_title: string;
  source_evidence: string;
};

export type PolicyEventInput = {
  event_type: "election_control_change" | "federal_policy_action";
  occurred_at: string;
  market: "us";
  direction: "escalation" | "de_escalation" | "neutral";
  source_url: string;
  source_name: string;
  notes: string;
  magnitude?: number | null;
};

const isChoice = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === "string" && choices.includes(value);

export function isPolicyEventType(value: unknown): value is PolicyEventInput["event_type"] {
  return value === "election_control_change" || value === "federal_policy_action";
}

export function policyEventInputError(input: {
  event: Record<string, unknown>;
  context: Record<string, unknown>;
  exposures: unknown;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const { event, context, exposures } = input;
  if (!isPolicyEventType(event.event_type)) return "Unsupported election or policy event type.";
  if (event.market !== "us") return "Election and federal-policy tracking is currently US-only.";
  if (!isEventDirection(event.direction)) return "direction must be escalation | de_escalation | neutral.";
  if (typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at)) || Date.parse(event.occurred_at) > now.getTime()) {
    return "occurred_at must be a valid public timestamp no later than now.";
  }
  if (typeof event.source_url !== "string" || !/^https?:\/\//i.test(event.source_url)) return "A cited http(s) source_url is required.";
  if (typeof event.source_name !== "string" || event.source_name.trim().length < 1 || event.source_name.length > 120) return "source_name must be 1–120 characters.";
  if (typeof event.notes !== "string" || event.notes.trim().length < 1 || event.notes.length > 2000) return "A concise event summary (up to 2,000 characters) is required.";
  if (event.magnitude != null && !Number.isFinite(Number(event.magnitude))) return "magnitude must be numeric or omitted.";

  const election = event.event_type === "election_control_change";
  if (context.family !== (election ? "election" : "federal_policy")) return "Event family does not match event type.";
  if (typeof context.event_title !== "string" || context.event_title.trim().length < 1 || context.event_title.length > 240) return "event_title must be 1–240 characters.";
  if (typeof context.source_evidence !== "string" || context.source_evidence.trim().length < 10 || context.source_evidence.length > 1200) return "Add a concise 10–1,200 character source excerpt or factual paraphrase for the immutable evidence record.";
  if (context.policy_chain_id != null && (typeof context.policy_chain_id !== "string" || !/^[0-9a-f-]{36}$/i.test(context.policy_chain_id))) return "policy_chain_id must be a UUID.";
  if (election) {
    if (!isChoice(context.stage_status, ELECTION_STAGES)) return "Election status must be projected, called, or certified.";
    if (!isChoice(context.chamber, CHAMBERS)) return "Election chamber must be house, senate, or presidency.";
    if (!isChoice(context.previous_control, CONTROL_STATES) || !isChoice(context.resulting_control, CONTROL_STATES)) return "Prior and resulting control must be explicit.";
    if (context.policy_domain != null && context.policy_domain !== "") return "Election control events cannot specify a policy domain.";
  } else {
    if (!isChoice(context.stage_status, POLICY_STAGES)) return "Policy status must be proposed, passed, signed, effective, blocked, or reversed.";
    if (!isChoice(context.policy_domain, POLICY_DOMAINS)) return "Choose a supported policy domain.";
    if (context.chamber != null && context.chamber !== "") return "Federal policy events cannot specify a chamber.";
    if (context.previous_control != null && context.previous_control !== "") return "Federal policy events cannot specify prior control.";
    if (context.resulting_control != null && context.resulting_control !== "") return "Federal policy events cannot specify resulting control.";
  }

  if (!Array.isArray(exposures) || exposures.length > 50) return "Provide up to 50 symbol exposure records.";
  const seen = new Set<string>();
  for (const raw of exposures) {
    if (!raw || typeof raw !== "object") return "Each exposure must be a structured record.";
    const item = raw as Record<string, unknown>;
    if (typeof item.symbol !== "string" || !/^[A-Za-z0-9.^_-]{1,24}$/.test(item.symbol.trim())) return "Each exposure needs a valid ticker symbol.";
    const symbol = item.symbol.trim().toUpperCase();
    if (seen.has(symbol)) return `Duplicate exposure symbol: ${symbol}.`;
    seen.add(symbol);
    if (!isChoice(item.exposure_stance, EXPOSURE_STANCES)) return `${symbol}: exposure must be positive, negative, mixed, or unknown.`;
    if (typeof item.rationale !== "string" || item.rationale.trim().length < 1 || item.rationale.length > 500) return `${symbol}: rationale must be 1–500 characters.`;
    if (typeof item.source_name !== "string" || item.source_name.trim().length < 1 || item.source_name.length > 120) return `${symbol}: evidence source name is required.`;
    if (typeof item.source_url !== "string" || !/^https?:\/\//i.test(item.source_url)) return `${symbol}: evidence source URL is required.`;
    if (typeof item.source_published_at !== "string" || !Number.isFinite(Date.parse(item.source_published_at))) return `${symbol}: evidence publication time is required.`;
    if (Date.parse(item.source_published_at) > Date.parse(String(event.occurred_at))) return `${symbol}: exposure evidence must have been public by the event time.`;
  }
  return null;
}

export function buildPolicyContext(
  input: PolicyContextInput,
  eventType: PolicyEventInput["event_type"],
  evidence: { occurred_at: string; source_url: string; source_name: string; direction: string; notes: string; exposures: PolicyExposureInput[] },
) {
  const exposures = [...evidence.exposures].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    policy_chain_id: input.policy_chain_id ?? randomUUID(),
    family: input.family,
    stage_status: input.stage_status,
    policy_domain: input.policy_domain || null,
    chamber: input.chamber || null,
    previous_control: input.previous_control || null,
    resulting_control: input.resulting_control || null,
    event_title: input.event_title.trim(),
    source_snapshot_hash: createHash("sha256").update(JSON.stringify({ eventType, event: evidence, context: input, exposures })).digest("hex"),
  };
}
