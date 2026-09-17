import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getOrRegisterClient, exchangeCode, verifyOAuthCookie } from "@/lib/robinhood-mcp";
import { consumeOAuthState } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
const COOKIE = "rh_mcp_oauth";

// Completes the OAuth flow: verifies single-use server-side state (with a
// signed cookie fallback), exchanges the code for server-stored tokens, and
// redirects back to Settings. The callback intentionally does not require an
// app session: the OAuth browser round trip can return without that cookie.
// Post-auth redirect is hardcoded — no open-redirect `next` parameter.
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const done = (status: string) => {
    const r = NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&rhmcp=${status}`);
    // Must match the path the login route set the cookie with, or the delete
    // is a no-op and the single-use cookie lingers.
    r.cookies.delete({ name: COOKIE, path: "/api/robinhood-mcp" });
    return r;
  };

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const svc = createServiceClient();
  let verifier: string | null = null;
  let savedRedirectUri: string | null = null;
  if (code && state) {
    const server = await consumeOAuthState(svc, state, "robinhood");
    if (server) {
      verifier = server.verifier;
      savedRedirectUri = server.redirectUri;
    }
    else {
      const saved = verifyOAuthCookie(req.cookies.get(COOKIE)?.value);
      if (saved?.state === state) verifier = saved.verifier;
    }
  }

  // State must be single-use server evidence, or the signed same-browser
  // cookie fallback. No session check belongs here: OAuth callbacks can return
  // without a usable application session.
  const redirectUri = `${origin}/api/robinhood-mcp/callback`;
  if (!code || !state || !verifier || (savedRedirectUri && savedRedirectUri !== redirectUri)) {
    return done("state_mismatch");
  }

  const reg = await getOrRegisterClient(svc, [redirectUri]); // returns the stored client_id
  if (!reg.ok || !reg.clientId) return done("no_client");

  const ex = await exchangeCode(svc, { code, verifier, redirectUri, clientId: reg.clientId });
  return done(ex.ok ? "connected" : "exchange_failed");
}
