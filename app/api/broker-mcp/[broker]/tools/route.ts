import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { MCP_BROKERS } from "@/lib/brokers/mcp-registry";
import { getValidAccessToken, mcpRpc } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Owner-only diagnostic: enumerate a connected broker MCP's REAL tool surface
// (tools/list) so we can see whether it exposes fundamentals / analyst / news
// data — not just account/order tools. READ-ONLY: only calls initialize +
// tools/list, never any tool. GET /api/broker-mcp/webull/tools
export async function GET(req: NextRequest, ctx: { params: Promise<{ broker: string }> }) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const { broker } = await ctx.params;
  const cfg = MCP_BROKERS[broker];
  if (!cfg) return NextResponse.json({ error: `unknown broker '${broker}'`, known: Object.keys(MCP_BROKERS) }, { status: 404 });

  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc, cfg);
  if (!tk.ok || !tk.token) return NextResponse.json({ error: `not connected / no token: ${tk.error ?? "unknown"}` }, { status: 400 });

  // Open a session (initialize → notifications/initialized), then tools/list.
  const init = await mcpRpc(cfg, tk.token, "initialize", {
    protocolVersion: cfg.protocolVersion, capabilities: {}, clientInfo: { name: "kairos-probe", version: "1.0" },
  });
  if (!init.ok) return NextResponse.json({ error: `initialize failed: ${init.error}` }, { status: 502 });
  await mcpRpc(cfg, tk.token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});

  const list = await mcpRpc(cfg, tk.token, "tools/list", {}, init.sessionId);
  if (!list.ok) return NextResponse.json({ error: `tools/list failed: ${list.error}` }, { status: 502 });

  const tools = (list.result?.tools ?? []) as any[];
  const withSchemas = req.nextUrl.searchParams.get("schemas") === "1";
  return NextResponse.json({
    broker: cfg.id,
    tool_count: tools.length,
    tools: tools.map(t => ({
      name: t.name,
      description: String(t.description ?? "").slice(0, 200),
      ...(withSchemas ? { inputSchema: t.inputSchema } : {}),
    })),
  });
}

// Alias so the pg_cron kairos_call_agent helper (which POSTs) can invoke the probe too.
export const POST = GET;
