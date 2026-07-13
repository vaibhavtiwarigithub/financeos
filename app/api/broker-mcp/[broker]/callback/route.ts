import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getMcpBroker } from "@/lib/brokers/mcp-registry";
import { getOrRegisterClient, exchangeCode, verifyOAuthCookie, consumeOAuthState } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
const COOKIE = "broker_mcp_oauth";

// Completes the OAuth flow for the resolved broker: looks up the server-side
// state FIRST (immune to cookie/domain/expiry), falls back to the signed cookie,
// exchanges the code for tokens (stored server-side in the vault), and redirects
// back to Settings. NOT owner-gated — the request arrives from the broker's
// redirect with no session; the single-use server-side state IS the CSRF proof.
// Post-auth redirect is hardcoded — no open-redirect `next` param. The
// redirect_uri used for the exchange MUST match the one the login route
// registered (base + cfg.callbackPath).
export async function GET(req: NextRequest, { params }: { params: Promise<{ broker: string }> }) {
  const { broker } = await params;
  const cfg = getMcpBroker(broker);
  if (!cfg) return NextResponse.json({ error: `unknown MCP broker '${broker}'` }, { status: 404 });

  const origin = req.nextUrl.origin;
  const done = (status: string) => {
    const r = NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&${cfg.id}=${status}`);
    r.cookies.delete({ name: COOKIE, path: "/api" });
    return r;
  };

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const svc = createServiceClient();

  // PRIMARY: server-side state store (keyed by broker id) — immune to cookie/
  // domain/expiry. Falls back to the signed cookie only if the row is absent.
  let verifier: string | null = null;
  if (code && state) {
    const server = await consumeOAuthState(svc, state, cfg.id);
    if (server) {
      verifier = server.verifier;
    } else {
      const cookie = verifyOAuthCookie(req.cookies.get(COOKIE)?.value);
      if (cookie && cookie.state === state) verifier = cookie.verifier;
    }
  }
  if (!code || !state || !verifier) return done("state_mismatch");

  const appBase = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  const redirectUri = `${appBase ?? origin}${cfg.callbackPath}`;
  const reg = await getOrRegisterClient(svc, cfg, [redirectUri]); // returns the stored client_id
  if (!reg.ok || !reg.clientId) return done("no_client");

  const ex = await exchangeCode(svc, cfg, { code, verifier, redirectUri, clientId: reg.clientId });
  return done(ex.ok ? "connected" : "exchange_failed");
}
