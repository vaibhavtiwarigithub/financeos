import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getOrRegisterClient, makePkce, makeState, buildAuthUrl, signOAuthCookie } from "@/lib/robinhood-mcp";

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
  const appBase = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  const redirectUris = [...new Set(
    [
      redirectUri,
      appBase ? `${appBase}/api/robinhood-mcp/callback` : null,
      // Only register the plaintext-HTTP localhost redirect in non-production —
      // a real-money client shouldn't carry a localhost redirect in prod.
      process.env.NODE_ENV !== "production" ? "http://localhost:3000/api/robinhood-mcp/callback" : null,
    ].filter(Boolean) as string[]
  )];

  const svc = createServiceClient();
  const reg = await getOrRegisterClient(svc, redirectUris);
  if (!reg.ok || !reg.clientId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&rhmcp=register_failed`);
  }

  const { verifier, challenge } = makePkce();
  const state = makeState();
  const res = NextResponse.redirect(buildAuthUrl({ clientId: reg.clientId, redirectUri, state, challenge }));
  res.cookies.set(COOKIE, signOAuthCookie({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }), {
    // Scope to the OAuth routes only — the state+verifier cookie has no business
    // being sent on every request to the site.
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/robinhood-mcp", maxAge: 600,
  });
  return res;
}
