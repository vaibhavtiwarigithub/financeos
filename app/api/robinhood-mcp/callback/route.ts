import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getOrRegisterClient, exchangeCode, verifyOAuthCookie } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
const COOKIE = "rh_mcp_oauth";

// Completes the OAuth flow: verifies the signed state cookie (CSRF/PKCE),
// exchanges the code for tokens (stored server-side in the vault), and
// redirects back to Settings. Owner-only. Post-auth redirect is hardcoded — no
// open-redirect `next` param.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const origin = req.nextUrl.origin;
  const done = (status: string) => {
    const r = NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&rhmcp=${status}`);
    r.cookies.delete(COOKIE);
    return r;
  };

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const saved = verifyOAuthCookie(req.cookies.get(COOKIE)?.value);

  // state must be present, unexpired, signed by us, and match the query.
  if (!code || !state || !saved || saved.state !== state) return done("state_mismatch");

  const svc = createServiceClient();
  const redirectUri = `${origin}/api/robinhood-mcp/callback`;
  const reg = await getOrRegisterClient(svc, [redirectUri]); // returns the stored client_id
  if (!reg.ok || !reg.clientId) return done("no_client");

  const ex = await exchangeCode(svc, { code, verifier: saved.verifier, redirectUri, clientId: reg.clientId });
  return done(ex.ok ? "connected" : "exchange_failed");
}
