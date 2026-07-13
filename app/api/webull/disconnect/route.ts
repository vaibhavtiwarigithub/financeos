import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { disconnectWebullMcp } from "@/lib/webull-mcp";

export const dynamic = "force-dynamic";

// Kill switch: wipe the stored Webull MCP token locally. Owner-only. Mirrors the
// Robinhood/Kite disconnect — wipes regardless of remote reachability. The
// authoritative revoke is Webull's own connected-apps dashboard.
export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const res = await disconnectWebullMcp(svc);
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
