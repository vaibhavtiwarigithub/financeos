import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { OWNER_EMAIL } from "@/lib/auth/owner";

// Owner-only gate for API routes. middleware.ts gates /dashboard and /admin
// pages, but NOT /api/* — every /api route that returns or mutates personal
// data must call this itself. Returns null when the caller is the owner, or a
// NextResponse (401/403) to return immediately otherwise.
export async function requireOwner(): Promise<NextResponse | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Gate on email AND a confirmed email — so an unverified-email registration
  // of the owner's address (if any provider that skips email verification is
  // ever enabled) can't pass the gate.
  if (user.email !== OWNER_EMAIL || !user.email_confirmed_at) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}
