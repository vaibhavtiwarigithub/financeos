import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Thin redirect → the generic config-driven MCP broker status. Webull was
// migrated onto /api/broker-mcp/[broker]/*; the Settings card now calls the
// generic endpoint directly, but this legacy path is kept for any other callers.
// 307 preserves the method; fetch() follows it transparently.
export function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/broker-mcp/webull/status";
  return NextResponse.redirect(url, 307);
}
