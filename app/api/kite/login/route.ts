import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { getKiteCreds, kiteLoginUrl } from "@/lib/kite";
import { makeState, signOAuthCookie } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
const STATE_COOKIE = "kite_oauth_state";

// Kicks off the Kite daily login — redirects the browser to Zerodha's auth
// page. After the user authorizes, Kite redirects back to the app-configured
// redirect URL (/api/kite/callback) with a request_token. Kite's own login
// flow has no state parameter, so we bind a signed nonce in an HttpOnly
// cookie and verify it matches on callback — otherwise a stray/replayed
// callback hitting /api/kite/callback (no auth gate, by design, since Kite
// itself drives that redirect) could get exchanged for an access token.
export async function GET(req: NextRequest) {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const base = process.env.APP_BASE_URL || req.nextUrl.origin;
  const { apiKey } = await getKiteCreds();
  if (!apiKey) {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=missing_key", base));
  }
  const state = makeState();
  const cookie = signOAuthCookie({ state, verifier: "", exp: Date.now() + 10 * 60 * 1000 });
  const res = NextResponse.redirect(kiteLoginUrl(apiKey));
  res.cookies.set(STATE_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
