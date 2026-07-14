import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  EVIDENCE_INTENTS,
  isMarket,
  isEvidenceIntent,
  type EvidenceIntent,
  type PolicyMode,
} from "@/lib/evidence/contracts";
import { ADAPTERS_BY_INTENT } from "@/lib/evidence/registry";

export const dynamic = "force-dynamic";

// Canonical Evidence Router — create a new immutable policy VERSION (owner-only).
//
// Fully server-validates the submitted rule set, then delegates the atomic
// version+rules insert to the create_evidence_policy_version RPC (advisory-locked
// version-number allocation). Does NOT activate — the new version is inert until
// a separate activate call swaps the pointer, and router_enabled stays false.

const VALID_MODES: readonly PolicyMode[] = ["auto", "prefer", "only", "off"];

interface RuleInput {
  intent: EvidenceIntent;
  mode: PolicyMode;
  preferred_provider?: string | null;
  max_age_seconds?: number;
  stale_max_seconds?: number;
  max_sync_attempts?: number;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body must be valid JSON");
  }

  const { market, rules, change_note } = (body ?? {}) as {
    market?: unknown; rules?: unknown; change_note?: unknown;
  };

  if (!isMarket(market)) return bad("invalid market — expected 'us' or 'india'");
  if (!Array.isArray(rules)) return bad("rules must be an array");
  if (change_note != null && typeof change_note !== "string") return bad("change_note must be a string");

  // Validate every rule and enforce exactly-one per canonical intent.
  const seen = new Set<string>();
  const normalized: RuleInput[] = [];

  for (const raw of rules as unknown[]) {
    if (typeof raw !== "object" || raw === null) return bad("each rule must be an object");
    const rule = raw as Record<string, unknown>;
    const intent = rule.intent;

    if (!isEvidenceIntent(intent)) return bad(`unknown intent: ${String(intent)}`);
    if (seen.has(intent)) return bad(`duplicate rule for intent: ${intent}`);
    seen.add(intent);

    const mode = rule.mode;
    if (typeof mode !== "string" || !VALID_MODES.includes(mode as PolicyMode)) {
      return bad(`invalid mode for ${intent}: ${String(mode)} (expected auto|prefer|only|off)`);
    }

    let preferred: string | null = null;
    if (mode === "prefer" || mode === "only") {
      const provider = rule.preferred_provider;
      if (typeof provider !== "string" || provider.length === 0) {
        return bad(`mode '${mode}' for ${intent} requires a preferred_provider`);
      }
      const allowed = (ADAPTERS_BY_INTENT[intent] ?? []).map((a) => a.providerId);
      if (!allowed.includes(provider as never)) {
        return bad(
          `preferred_provider '${provider}' is not a registered provider for ${intent}` +
            (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (no providers registered for this intent)"),
        );
      }
      preferred = provider;
    } else if (rule.preferred_provider != null) {
      // auto/off must not name a provider (matches the DB provider-shape check).
      return bad(`mode '${mode}' for ${intent} must not set preferred_provider`);
    }

    const maxAge = numOrDefault(rule.max_age_seconds, 86400);
    const staleMax = numOrDefault(rule.stale_max_seconds, 259200);
    const maxSync = numOrDefault(rule.max_sync_attempts, 2);
    if (maxAge == null || maxAge < 0) return bad(`max_age_seconds for ${intent} must be >= 0`);
    if (staleMax == null || staleMax < 0) return bad(`stale_max_seconds for ${intent} must be >= 0`);
    if (staleMax < maxAge) return bad(`stale_max_seconds must be >= max_age_seconds for ${intent}`);
    if (maxSync == null || maxSync < 0 || maxSync > 2) return bad(`max_sync_attempts for ${intent} must be 0..2`);

    normalized.push({
      intent,
      mode: mode as PolicyMode,
      preferred_provider: preferred,
      max_age_seconds: maxAge,
      stale_max_seconds: staleMax,
      max_sync_attempts: maxSync,
    });
  }

  // Every canonical intent must be present exactly once.
  const missing = EVIDENCE_INTENTS.filter((i) => !seen.has(i));
  if (missing.length) return bad(`missing rules for intent(s): ${missing.join(", ")}`);

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("create_evidence_policy_version", {
    p_market: market,
    p_rules: normalized,
    p_note: typeof change_note === "string" ? change_note : null,
    p_actor: null,
  });

  if (error) {
    return NextResponse.json({ error: `failed to create version: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, market, version_id: data as string });
}

function numOrDefault(v: unknown, def: number): number | null {
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v;
}
