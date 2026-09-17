import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getOrRegisterClient, makePkce, makeState, buildAuthUrl, signOAuthCookie } from "@/lib/robinhood-mcp";
import { saveOAuthState } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
const COOKIE = "rh_mcp_oauth";

// Begins the Robinhood OAuth 2.1 (PKCE) flow. Owner-only. Ensures a dynamically
// registered client exists, sets a short-lived HttpOnly signed state+verifier
// cookie, and redirects to Robinhood's authorization endpoint.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/robinhood-mcp/callback`;
  const svc = createServiceClient();
  // Register exactly the callback used in this authorization request. Do not
  // add localhost or an unrelated deployment alias: OAuth requires byte-for-
  // byte redirect URI consistency across registration, authorize and exchange.
  const reg = await getOrRegisterClient(svc, [redirectUri]);
  if (!reg.ok || !reg.clientId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&rhmcp=register_failed`);
  }

  const { verifier, challenge } = makePkce();
  const state = makeState();
  // Server-side state is primary. A phone-confirmed or cross-site OAuth return
  // may not carry the browser cookie; without this row it looks like a CSRF
  // failure even though the user approved the connection.
  await saveOAuthState(svc, state, verifier, redirectUri, "robinhood");
  const res = NextResponse.redirect(buildAuthUrl({ clientId: reg.clientId, redirectUri, state, challenge }));
  res.cookies.set(COOKIE, signOAuthCookie({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }), {
    // Scope to the OAuth routes only — the state+verifier cookie has no business
    // being sent on every request to the site.
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/robinhood-mcp", maxAge: 600,
  });
  return res;
}
