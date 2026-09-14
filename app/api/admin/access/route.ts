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

  if (action === "invite") return invite(body);

  const userId = String(body?.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  if (!["revoke", "restore"].includes(action)) {
    return NextResponse.json({ error: "action must be invite|revoke|restore" }, { status: 400 });
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite a viewer by email.
 *
 * The recipient sets their OWN password through Supabase's invitation flow. No
 * password is ever accepted, generated, stored, logged, or returned here.
 *
 * Access comes from the `app_user_roles` row written below, which is the only
 * authority for a non-owner role — the auth user alone grants nothing. So an
 * invite that half-completes fails CLOSED: the person can sign in but reaches
 * nothing until the grant exists.
 */
async function invite(body: any): Promise<NextResponse> {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }
  if (email === OWNER_EMAIL.toLowerCase()) {
    return NextResponse.json({ error: "the owner already has full access" }, { status: 400 });
  }

  const svc = createServiceClient();
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : null;

  const { data: invited, error: inviteError } = await svc.auth.admin.inviteUserByEmail(email);

  let userId: string | null = invited?.user?.id ?? null;
  if (!userId) {
    // Already a registered account — e.g. re-inviting someone previously
    // revoked. Not an error: find them and grant access.
    userId = await findUserByEmail(svc, email);
    if (!userId) {
      return NextResponse.json(
        { error: `invite failed: ${inviteError?.message ?? "unknown error"}` },
        { status: 502 },
      );
    }
  }

  const { error: grantError } = await svc.from("app_user_roles").upsert(
    {
      user_id: userId,
      email,
      role: "viewer",
      granted_by: OWNER_EMAIL,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      revoked_by: null,
      note,
    },
    { onConflict: "user_id" },
  );
  if (grantError) return NextResponse.json({ error: grantError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    action: "invite",
    email,
    invited_new_account: Boolean(invited?.user?.id),
    access: describeRoleAccess("viewer"),
  });
}

/** Bounded lookup — this supabase-js version has no getUserByEmail. */
async function findUserByEmail(svc: any, email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u: any) => String(u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}
