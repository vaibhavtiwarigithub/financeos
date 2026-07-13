import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Thin redirect → the generic config-driven MCP broker disconnect. 307 preserves
// the POST method so the kill switch still wipes the Webull token via the driver.
export function POST(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/broker-mcp/webull/disconnect";
  return NextResponse.redirect(url, 307);
}
