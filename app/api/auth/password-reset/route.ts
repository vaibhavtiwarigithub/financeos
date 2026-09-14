// Password reset for anyone the owner has actually granted access to.
//
// WHY THIS IS A SERVER ROUTE. The login page used to call
// `supabase.auth.resetPasswordForEmail` directly, behind a client-side check
// that the address equalled OWNER_EMAIL. That check existed for two good
// reasons — the endpoint SENDS EMAIL, so it must not be usable to mail an
// arbitrary address, nor to probe which addresses have accounts — but it also
// meant an invited viewer could never reset their own password.
//
// Moving the decision server-side keeps both protections and fixes the gap: the
// only addresses that receive mail are the owner and accounts with a live grant
// in `app_user_roles`, and the response is IDENTICAL either way, so this cannot
// be used to discover who has access.
//
// Deliberately unauthenticated: it is a pre-login endpoint. Middleware's
// no-cookie fast path lets it through, and it reveals nothing.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { OWNER_EMAIL } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same answer for every input — success, refusal and unknown address alike. */
const SAME_ANSWER = {
  ok: true,
  message: "If that address has access, a password reset link is on its way.",
};

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json(SAME_ANSWER); }

  const email = String(body?.email ?? "").trim().toLowerCase();
  const redirectTo = typeof body?.redirect_to === "string" ? body.redirect_to : null;
  if (!EMAIL_RE.test(email)) return NextResponse.json(SAME_ANSWER);

  const svc = createServiceClient();

  let eligible = email === OWNER_EMAIL.toLowerCase();
  if (!eligible) {
    const { data } = await svc
      .from("app_user_roles")
      .select("revoked_at")
      .eq("email", email)
      .maybeSingle();
    // A revoked viewer is not eligible: revocation must not leave a working
    // route back in.
    eligible = Boolean(data && !data.revoked_at);
  }

  if (eligible) {
    // Failures are swallowed on purpose — surfacing "user not found" here would
    // turn this into the account probe the guard was protecting against.
    await svc.auth
      .resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined)
      .catch(() => {});
  }

  return NextResponse.json(SAME_ANSWER);
}
