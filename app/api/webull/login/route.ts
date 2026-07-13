import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getOrRegisterClient, makePkce, makeState, buildAuthUrl, signOAuthCookie } from "@/lib/webull-mcp";

export const dynamic = "force-dynamic";
const COOKIE = "wb_mcp_oauth";

// Begins the Webull OAuth 2.1 (PKCE S256) flow. Owner-only. Ensures a
// dynamically registered client exists (redirect = the HOSTED Vercel callback,
// like Kite — this is a cloud OAuth flow, not a localhost loopback), sets a
// short-lived HttpOnly signed state+verifier cookie, and redirects to Webull's
// authorization endpoint. READ-ONLY Phase 1 — the requested scope is account/
// market/instrument read; no order:write.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const origin = req.nextUrl.origin;
  const appBase = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  // Hosted callback — prefer the configured public base URL, fall back to the
  // request origin. This is the redirect registered via DCR and sent to Webull.
  const redirectUri = `${appBase ?? origin}/api/webull/callback`;

  const svc = createServiceClient();
  const reg = await getOrRegisterClient(svc, [redirectUri]);
  if (!reg.ok || !reg.clientId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&webull=register_failed`);
  }

  const { verifier, challenge } = makePkce();
  const state = makeState();
  const res = NextResponse.redirect(buildAuthUrl({ clientId: reg.clientId, redirectUri, state, challenge }));
  res.cookies.set(COOKIE, signOAuthCookie({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }), {
    // Scope to the OAuth routes only — the state+verifier cookie has no business
    // being sent on every request to the site.
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/webull", maxAge: 600,
  });
  return res;
}
