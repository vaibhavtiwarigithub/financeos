import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { inspectRobinhoodMcpCapabilities } from "@/lib/robinhood-mcp";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Contract observation only. inspectRobinhoodMcpCapabilities calls initialize
// and tools/list, never tools/call. It cannot affect data quotas or trading.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const observedAt = new Date().toISOString();
  const inspected = await inspectRobinhoodMcpCapabilities();
  const svc = createServiceClient();
  const { data: previous } = await svc
    .from("broker_mcp_capability_snapshots")
    .select("schema_fingerprint")
    .eq("broker", "robinhood")
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = inspected.ok
    ? {
        broker: "robinhood",
        market: "us",
        observed_at: observedAt,
        status: previous?.schema_fingerprint && previous.schema_fingerprint !== inspected.snapshot.schemaFingerprint
          ? "contract_changed"
          : "available",
        tool_count: inspected.snapshot.toolCount,
        tool_names: inspected.snapshot.toolNames,
        schema_fingerprint: inspected.snapshot.schemaFingerprint,
        error_code: null,
      }
    : {
        broker: "robinhood",
        market: "us",
        observed_at: observedAt,
        status: "unavailable",
        tool_count: 0,
        tool_names: [],
        schema_fingerprint: null,
        error_code: inspected.errorCode,
      };
  const { error } = await svc.from("broker_mcp_capability_snapshots").insert(row);
  if (error) return NextResponse.json({ error: "capability snapshot persistence failed" }, { status: 500 });

  return NextResponse.json({
    broker: row.broker,
    market: row.market,
    observedAt,
    status: row.status,
    toolCount: row.tool_count,
    toolNames: row.tool_names,
    schemaFingerprint: row.schema_fingerprint,
    errorCode: row.error_code,
  });
}
