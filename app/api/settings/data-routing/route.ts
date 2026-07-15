import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { EVIDENCE_INTENTS, isMarket } from "@/lib/evidence/contracts";
import { adaptersForIntent, PROVIDER_SPECS } from "@/lib/evidence/registry";

export const dynamic = "force-dynamic";

// Canonical Evidence Router — data-routing POLICY read API (owner-only).
//
// Returns everything the Settings → Data Routing screen needs to render the
// active policy for one market: the active version + its rules, the effective
// Auto-mode provider chain per intent (code-owned registry), provider
// availability specs (NO credentials), the latest unactivated draft version if
// any, and recent version history. Read-only — reflects DB + code constants;
// never runs a research run, calls a provider, or touches the money path.

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const market = req.nextUrl.searchParams.get("market");
  if (!isMarket(market)) {
    return NextResponse.json(
      { error: "invalid market — expected 'us' or 'india'" },
      { status: 400 },
    );
  }

  const svc = createServiceClient();

  // Active pointer → active version row.
  const { data: pointer } = await svc
    .from("active_evidence_policy")
    .select("policy_version_id, activated_at, activated_by")
    .eq("market", market)
    .maybeSingle();

  const activeVersionId: string | null = pointer?.policy_version_id ?? null;

  // All versions for this market (for active row, history, and latest-draft calc).
  const { data: versionRows } = await svc
    .from("evidence_policy_versions")
    .select("id, version, router_enabled, created_at, created_by, change_note")
    .eq("market", market)
    .order("version", { ascending: false });

  const versions = (versionRows ?? []) as Array<{
    id: string; version: number; router_enabled: boolean;
    created_at: string; created_by: string | null; change_note: string | null;
  }>;

  const activeVersion = versions.find((v) => v.id === activeVersionId) ?? null;

  // Rules of the active version.
  let rules: Array<Record<string, unknown>> = [];
  if (activeVersionId) {
    const { data: ruleRows } = await svc
      .from("evidence_policy_rules")
      .select("intent, mode, preferred_provider, max_age_seconds, stale_max_seconds, max_sync_attempts, advanced_config")
      .eq("policy_version_id", activeVersionId);
    rules = (ruleRows ?? []) as Array<Record<string, unknown>>;
  }

  // Effective Auto-mode provider chain per intent (code-owned registry).
  const effectiveChains = EVIDENCE_INTENTS.map((intent) => ({
    intent,
    // Allowlisted providers for this intent (Auto-fallback order), market-filtered.
    providers: adaptersForIntent(intent, market).map((a) => a.providerId),
    // Every registry-allowed provider (ignoring market) — the prefer/only choices.
    allowedProviders: adaptersForIntent(intent, market).map((a) => a.providerId),
  }));

  // Provider availability — code-owned specs, credentials stripped.
  const providers = Object.values(PROVIDER_SPECS)
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({
      id: s.id,
      label: s.label,
      transport: s.transport,
      markets: s.markets,
      capabilities: s.capabilities,
      entitlementRequired: s.entitlementRequired,
      trustTier: s.trustTier,
      official: s.official,
      // credentialRef intentionally omitted — never expose credential handles.
    }));

  // Latest UNACTIVATED version = highest version whose id != active pointer.
  const latestUnactivated = versions.find((v) => v.id !== activeVersionId) ?? null;

  return NextResponse.json({
    market,
    active: activeVersion
      ? {
          id: activeVersion.id,
          version: activeVersion.version,
          router_enabled: activeVersion.router_enabled,
          created_at: activeVersion.created_at,
          change_note: activeVersion.change_note,
          activated_at: pointer?.activated_at ?? null,
          rules,
        }
      : null,
    effectiveChains,
    providers,
    latestUnactivated: latestUnactivated
      ? {
          id: latestUnactivated.id,
          version: latestUnactivated.version,
          created_at: latestUnactivated.created_at,
          change_note: latestUnactivated.change_note,
        }
      : null,
    history: versions.map((v) => ({
      id: v.id,
      version: v.version,
      router_enabled: v.router_enabled,
      created_at: v.created_at,
      change_note: v.change_note,
      is_active: v.id === activeVersionId,
    })),
    as_of: new Date().toISOString(),
  });
}
