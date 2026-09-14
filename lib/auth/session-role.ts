// Server-side role resolution for Shared Viewer Access.
//
// The grant is read with the SERVICE client on purpose: `app_user_roles` is
// owner-read-only under RLS, so a viewer's own session could never read its own
// grant. Authorization must not depend on the caller being able to see the
// record that authorizes them.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveRole, isViewerApiRoute, type AppRole } from "@/lib/auth/roles";

export type SessionRole = {
  role: AppRole | null;
  userId: string | null;
  email: string | null;
};

export async function getSessionRole(): Promise<SessionRole> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { role: null, userId: null, email: null };

  const base = { userId: user.id, email: user.email ?? null };

  // Owner never needs a grant row, so skip the read entirely for the common case.
  const ownerRole = resolveRole(user.email, user.email_confirmed_at, null);
  if (ownerRole === "owner") return { ...base, role: "owner" };

  const svc = createServiceClient();
  const { data: grant } = await svc
    .from("app_user_roles")
    .select("revoked_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return { ...base, role: resolveRole(user.email, user.email_confirmed_at, grant) };
}

/**
 * Guard for routes that back a viewer-visible page. Admits the owner always, and
 * a viewer only when this exact path+method is declared viewer-safe in
 * `VIEWER_API_ROUTES` — so adding a route to the UI can never silently widen a
 * viewer's reach.
 */
export async function requireViewerOrOwner(
  req: Request,
): Promise<{ gate: NextResponse; role: null } | { gate: null; role: AppRole }> {
  const { role } = await getSessionRole();
  if (!role) return { gate: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), role: null };
  if (role === "owner") return { gate: null, role };

  const { pathname } = new URL(req.url);
  if (!isViewerApiRoute(pathname, req.method)) {
    return { gate: NextResponse.json({ error: "Forbidden" }, { status: 403 }), role: null };
  }
  return { gate: null, role };
}
