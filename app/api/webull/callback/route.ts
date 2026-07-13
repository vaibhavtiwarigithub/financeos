import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Thin redirect → the generic config-driven MCP broker callback. This is the
// redirect_uri the live Webull DCR client was registered with (webull's
// callbackPath in the registry is pinned to this path), so Webull still redirects
// here; we forward the ?code&state to the generic handler which performs the
// server-side-state lookup + token exchange. 307 preserves the query string.
export function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/broker-mcp/webull/callback";
  return NextResponse.redirect(url, 307);
}
