import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { inspectRobinhoodResearchReadSchemas } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Owner-only diagnostics. This exposes only the input schemas of the hardcoded
// read allowlist; it cannot call an account, order, cancel, or review tool.
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const inspected = await inspectRobinhoodResearchReadSchemas();
  if (!inspected.ok) {
    return NextResponse.json({ error: inspected.errorCode }, { status: 503 });
  }
  return NextResponse.json(inspected);
}
