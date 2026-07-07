import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { disconnectRobinhoodMcp } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";

// Kill switch: wipe the stored Robinhood MCP token locally. Mirrors the Kite
// disconnect — wipes regardless of remote reachability. (Remote OAuth
// revocation is added when the OAuth flow lands.)
export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const res = await disconnectRobinhoodMcp(svc);
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
