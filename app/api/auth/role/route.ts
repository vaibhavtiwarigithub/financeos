// The caller's own role, so client components can hide owner-only controls.
// PRESENTATION ONLY — every owner action is enforced server-side regardless of
// what this returns. Hiding a button is not an access control.
import { NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { describeRoleAccess } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET() {
  const { role, email } = await getSessionRole();
  if (!role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ role, email, access: describeRoleAccess(role) });
}
