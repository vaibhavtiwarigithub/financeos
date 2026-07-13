import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getMcpBroker } from "@/lib/brokers/mcp-registry";
import { getOrRegisterClient, makePkce, makeState, buildAuthUrl, signOAuthCookie, saveOAuthState } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
const COOKIE = "broker_mcp_oauth";

// Generic MCP broker OAuth 2.1 (PKCE S256) start. Owner-only. Resolves the
// broker config from the registry (404 if unknown), ensures a dynamically
// registered client exists (redirect = the HOSTED Vercel callback), persists the
// state+verifier server-side (primary) plus a 30-min signed cookie (fallback),
// and redirects to the broker's authorization endpoint. READ-ONLY — the requested
// scopes come from cfg.oauth.scopes; no order:write.
export async function GET(req: NextRequest, { params }: { params: Promise<{ broker: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;

  const { broker } = await params;
  const cfg = getMcpBroker(broker);
  if (!cfg) return NextResponse.json({ error: `unknown MCP broker '${broker}'` }, { status: 404 });

  const origin = req.nextUrl.origin;
  const appBase = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  // Hosted callback — prefer the configured public base URL, fall back to the
  // request origin. This is the redirect registered via DCR and sent to the broker.
  const redirectUri = `${appBase ?? origin}${cfg.callbackPath}`;

  const svc = createServiceClient();
  const reg = await getOrRegisterClient(svc, cfg, [redirectUri]);
  if (!reg.ok || !reg.clientId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?tab=agents&${cfg.id}=register_failed`);
  }

  const { verifier, challenge } = makePkce();
  const state = makeState();

  // PRIMARY: persist state+verifier server-side (oauth_pkce_state) keyed by the
  // broker id as provider. Immune to cookie/domain/expiry across multi-screen OAuth.
  await saveOAuthState(svc, state, verifier, redirectUri, cfg.id);

  const res = NextResponse.redirect(buildAuthUrl(cfg, { clientId: reg.clientId, redirectUri, state, challenge }));
  // Belt-and-suspenders cookie fallback. Path "/api" so it's readable at both the
  // generic callback and any broker-pinned callback path (e.g. Webull's legacy one).
  res.cookies.set(COOKIE, signOAuthCookie({ state, verifier, exp: Date.now() + 30 * 60 * 1000 }), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/api", maxAge: 1800,
  });
  return res;
}
