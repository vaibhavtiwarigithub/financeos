import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { EVIDENCE_INTENTS, isMarket } from "@/lib/evidence/contracts";

export const dynamic = "force-dynamic";

// Canonical Evidence Router — restore all-Auto policy (owner-only).
//
// One-click safe default: create a fresh version with every canonical intent set
// to mode 'auto' (router picks the code-owned default provider chain), then
// activate it. router_enabled stays false — this is the inert "reset routing to
// Auto" escape hatch. No provider call, no research run, no money path.

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

  const { market } = (body ?? {}) as { market?: unknown };
  if (!isMarket(market)) return bad("invalid market — expected 'us' or 'india'");

  const svc = createServiceClient();

  // All-Auto rule set — one row per canonical intent, mode 'auto', no provider.
  const rules = EVIDENCE_INTENTS.map((intent) => ({ intent, mode: "auto" as const }));

  const { data: newVersionId, error: createErr } = await svc.rpc("create_evidence_policy_version", {
    p_market: market,
    p_rules: rules,
    p_note: "restore-auto: all intents → Auto",
    p_actor: null,
  });
  if (createErr) {
    return NextResponse.json({ error: `failed to create all-Auto version: ${createErr.message}` }, { status: 500 });
  }

  const { error: activateErr } = await svc.rpc("activate_evidence_policy", {
    p_market: market,
    p_version_id: newVersionId,
    p_required_intents: EVIDENCE_INTENTS,
    p_actor: null,
  });
  if (activateErr) {
    return NextResponse.json(
      { error: `created version ${newVersionId} but activation failed: ${activateErr.message}`, version_id: newVersionId },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, market, version_id: newVersionId as string });
}
