// Owner-only guest access management: who has access, and revoke/restore it.
//
// Revocation sets `revoked_at` rather than deleting, so the grant history
// survives. It takes effect at the NEXT request: middleware re-reads the grant
// on every request, so a revoked viewer is stopped at the edge and at every
// viewer-safe API route — not merely hidden from navigation.
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { describeRoleAccess, VIEWER_PAGES } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("app_user_roles")
    .select("user_id, email, role, granted_at, granted_by, revoked_at, revoked_by, note")
    .order("granted_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    owner: { email: OWNER_EMAIL, access: describeRoleAccess("owner") },
    viewer_access: describeRoleAccess("viewer"),
    viewer_pages: VIEWER_PAGES,
    grants: (data ?? []).map((g: any) => ({ ...g, active: !g.revoked_at })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const action = String(body?.action ?? "");
  const userId = String(body?.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  if (!["revoke", "restore"].includes(action)) {
    return NextResponse.json({ error: "action must be revoke|restore" }, { status: 400 });
  }

  const svc = createServiceClient();
  const patch = action === "revoke"
    ? { revoked_at: new Date().toISOString(), revoked_by: OWNER_EMAIL }
    : { revoked_at: null, revoked_by: null };

  const { data, error } = await svc
    .from("app_user_roles")
    .update(patch)
    .eq("user_id", userId)
    .select("user_id, email, revoked_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "grant not found" }, { status: 404 });

  return NextResponse.json({ ok: true, action, grant: { ...data, active: !data.revoked_at } });
}
