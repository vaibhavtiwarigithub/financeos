import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Thin redirect → the generic config-driven MCP broker login. Webull was
// migrated onto lib/brokers/mcp-driver.ts + /api/broker-mcp/[broker]/*; this
// legacy path is kept so any in-flight bookmarks still work. 307 preserves the
// method and forwards the query string.
export function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/broker-mcp/webull/login";
  return NextResponse.redirect(url, 307);
}
