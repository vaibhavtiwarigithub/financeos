import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { EVIDENCE_INTENTS, isMarket } from "@/lib/evidence/contracts";

export const dynamic = "force-dynamic";

// Canonical Evidence Router — activate a policy VERSION (owner-only).
//
// Swaps the active_evidence_policy pointer for one market to a chosen version via
// the atomic activate_evidence_policy RPC (per-market advisory lock; validates
// the version belongs to the market and has a rule for every required intent).
// Activation ONLY moves the pointer — router_enabled stays false, so the newly
// active policy is inert until Phase 4 flips the router on. No provider call, no
// research run, no money path.

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

  const { market, version_id } = (body ?? {}) as { market?: unknown; version_id?: unknown };
  if (!isMarket(market)) return bad("invalid market — expected 'us' or 'india'");
  if (typeof version_id !== "string" || version_id.length === 0) return bad("version_id is required");

  const svc = createServiceClient();
  const { data: target, error: targetError } = await svc
    .from("evidence_policy_versions")
    .select("router_enabled")
    .eq("id", version_id)
    .eq("market", market)
    .maybeSingle();
  if (targetError || !target) return bad("unknown policy version for this market");
  if (target.router_enabled) {
    return bad("enabled router versions require a fresh bound evaluation and owner-approved divergences");
  }
  const { error } = await svc.rpc("activate_evidence_policy", {
    p_market: market,
    p_version_id: version_id,
    p_required_intents: EVIDENCE_INTENTS,
    p_actor: null,
  });

  if (error) {
    return NextResponse.json({ error: `failed to activate version: ${error.message}` }, { status: 400 });
  }

  return NextResponse.json({ ok: true, market, version_id });
}
