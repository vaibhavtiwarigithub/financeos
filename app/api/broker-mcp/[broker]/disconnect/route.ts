import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { getMcpBroker } from "@/lib/brokers/mcp-registry";
import { disconnect } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";

// Kill switch: wipe the stored MCP token for the resolved broker locally.
// Owner-only. Wipes regardless of remote reachability. The authoritative revoke
// is the broker's own connected-apps dashboard.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ broker: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;

  const { broker } = await params;
  const cfg = getMcpBroker(broker);
  if (!cfg) return NextResponse.json({ error: `unknown MCP broker '${broker}'` }, { status: 404 });

  const svc = createServiceClient();
  const res = await disconnect(svc, cfg);
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
