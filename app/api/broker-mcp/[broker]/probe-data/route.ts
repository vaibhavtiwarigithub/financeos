import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { MCP_BROKERS } from "@/lib/brokers/mcp-registry";
import { getValidAccessToken, mcpRpc, mcpToolJson } from "@/lib/brokers/mcp-driver";
import { fetchWebullAnalyst, fetchWebullFinancials, webullAnalystLine } from "@/lib/data/webull-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Phase-0 CONTRACT PROBE (data-source-policy feature). READ-ONLY.
//
// Calls the four Webull research DATA tools for a symbol, TWICE each: once with
// bare { symbol } and once with { symbol, category: "US_STOCK" } — so we can see
// with our own eyes (a) whether the category arg is actually required, and (b)
// the REAL raw payload shape (est/actual/reported? {currency,values}?
// under_perform bucket?) before any parser is written. This exists to KILL the
// "confirmed contract" assumption in the architecture doc: nothing about the
// Webull payload is trusted until a live tools/call proves it here.
//
// It calls ONLY the four read tools below. No order tool. No write. Returns the
// decoded JSON (and a truncated raw string) so the shape is inspectable.
//
// GET/POST /api/broker-mcp/webull/probe-data?symbol=AAPL
//   symbol defaults to AAPL. Owner-gated, or cron-gated (CRON_SECRET) so the
//   same call can be fired in a real unattended cron context to prove the data
//   tools stay entitled outside an interactive session.

const DATA_TOOLS = [
  "get_analyst_rating",
  "get_analyst_target_price",
  "get_stock_forecast_eps",
  "get_financial_indicators",
] as const;

function summarize(result: any): { decoded: unknown; rawHead: string } {
  const decoded = mcpToolJson(result?.content ?? result);
  let rawHead = "";
  try {
    const txt = result?.content?.[0]?.text ?? JSON.stringify(result?.content ?? result);
    rawHead = String(txt).slice(0, 1200);
  } catch {
    rawHead = "";
  }
  return { decoded, rawHead };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ broker: string }> }) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const { broker } = await ctx.params;
  const cfg = MCP_BROKERS[broker];
  if (!cfg) return NextResponse.json({ error: `unknown broker '${broker}'`, known: Object.keys(MCP_BROKERS) }, { status: 404 });

  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "AAPL").trim().toUpperCase();

  // ?tool=<name> → probe a single arbitrary tool with {symbol, category:US_STOCK}
  const singleTool = req.nextUrl.searchParams.get("tool");
  if (singleTool) {
    const svc2 = createServiceClient();
    const tk2 = await getValidAccessToken(svc2, cfg);
    if (!tk2.ok || !tk2.token) return NextResponse.json({ error: `not connected: ${tk2.error}` }, { status: 400 });
    const init2 = await mcpRpc(cfg, tk2.token, "initialize", { protocolVersion: cfg.protocolVersion, capabilities: {}, clientInfo: { name: "kairos-probe", version: "1.0" } });
    if (!init2.ok) return NextResponse.json({ error: `initialize failed: ${init2.error}` }, { status: 502 });
    await mcpRpc(cfg, tk2.token, "notifications/initialized", undefined, init2.sessionId, true).catch(() => {});
    const r = await mcpRpc(cfg, tk2.token, "tools/call", { name: singleTool, arguments: { symbol, category: "US_STOCK" } }, init2.sessionId);
    const { decoded, rawHead } = summarize(r.result);
    return NextResponse.json({ broker: cfg.id, symbol, tool: singleTool, ok: r.ok, error: r.error, decoded, rawHead, probedAt: new Date().toISOString() });
  }

  // ?parsed=1 → skip the raw dual-variant dump and instead prove the ACTUAL
  // adapter parsers (fetchWebullAnalyst / fetchWebullFinancials) produce the
  // right numbers on live data. This is the end-to-end Phase-1a proof.
  if (req.nextUrl.searchParams.get("parsed") === "1" && broker === "webull") {
    const [analyst, financials] = await Promise.all([
      fetchWebullAnalyst(symbol),
      fetchWebullFinancials(symbol),
    ]);
    return NextResponse.json({
      broker, symbol, mode: "parsed", probedAt: new Date().toISOString(),
      analyst, analystLine: webullAnalystLine(analyst), financials,
    });
  }

  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc, cfg);
  if (!tk.ok || !tk.token) return NextResponse.json({ error: `not connected / no token: ${tk.error ?? "unknown"}` }, { status: 400 });

  const init = await mcpRpc(cfg, tk.token, "initialize", {
    protocolVersion: cfg.protocolVersion, capabilities: {}, clientInfo: { name: "kairos-probe", version: "1.0" },
  });
  if (!init.ok) return NextResponse.json({ error: `initialize failed: ${init.error}` }, { status: 502 });
  await mcpRpc(cfg, tk.token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});

  const out: Record<string, unknown> = { broker: cfg.id, symbol, probedAt: new Date().toISOString() };

  for (const tool of DATA_TOOLS) {
    const variants: Record<string, unknown> = {};
    for (const [label, args] of [
      ["bare", { symbol }],
      ["with_category", { symbol, category: "US_STOCK" }],
    ] as const) {
      const r = await mcpRpc(cfg, tk.token, "tools/call", { name: tool, arguments: args }, init.sessionId);
      if (!r.ok) {
        variants[label] = { ok: false, error: r.error };
        continue;
      }
      const { decoded, rawHead } = summarize(r.result);
      variants[label] = { ok: true, decoded, rawHead };
    }
    out[tool] = variants;
  }

  return NextResponse.json(out);
}

// Alias so the pg_cron kairos_call_agent helper (which POSTs) can fire this in a
// real unattended cron context — proving the data tools stay entitled off-session.
export const POST = GET;
