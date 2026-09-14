// Start a Zerodha login for the SIGNED-IN GUEST.
//
// Zerodha registers ONE redirect URL per app, in the developer console, so this
// cannot have a callback of its own — it reuses `/api/kite/callback`, which
// branches on who the login was started for.
//
// That branch must not depend on the session being present when Kite redirects
// back. Instead the intended user id is written into the SIGNED state cookie, so
// the callback learns who to store the token for from a value it can verify and
// a guest cannot forge. Getting this wrong would let a guest's token overwrite
// the owner's vault entry, which is why it is bound cryptographically rather
// than inferred.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { getKiteCreds, kiteLoginUrl } from "@/lib/kite";
import { makeState, signOAuthCookie } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
const STATE_COOKIE = "kite_oauth_state";

/** Marks a login started by a guest, and for whom. Verified, never trusted raw. */
export const GUEST_VERIFIER_PREFIX = "guest:";

export async function GET(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) {
    return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL || req.nextUrl.origin));
  }

  const base = process.env.APP_BASE_URL || req.nextUrl.origin;
  const { apiKey } = await getKiteCreds();
  if (!apiKey) {
    return NextResponse.redirect(new URL("/dashboard/connections?kite=missing_key", base));
  }

  const cookie = signOAuthCookie({
    state: makeState(),
    verifier: `${GUEST_VERIFIER_PREFIX}${userId}`,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = NextResponse.redirect(kiteLoginUrl(apiKey));
  res.cookies.set(STATE_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
