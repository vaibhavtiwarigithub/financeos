import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { tradeId, reason } = await req.json();
    if (!tradeId) return NextResponse.json({ error: "tradeId required" }, { status: 400 });

    const supabase = createServiceClient();

    const { data: tradeRaw } = await supabase
      .from("trade_queue")
      .select("*")
      .eq("id", tradeId)
      .single();
    const trade = tradeRaw as any;

    if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    if (trade.status !== "pending_approval")
      return NextResponse.json({ error: `Trade already ${trade.status}` }, { status: 409 });

    // Mark as approved immediately
    await supabase.from("trade_queue").update({
      status: "approved",
      user_decision_at: new Date().toISOString(),
    } as any).eq("id", tradeId);

    // Agentic account is the ONLY permitted account for order placement.
    // Hardcoded — must not be overridable by environment or config.
    // CONNECTIONS.md: 965848641 is NEVER used for orders (read-only positions only).
    const AGENTIC_ACCOUNT = "605420660";

    // Execution is manual-by-design: execClaude (a plain text-completion
    // subprocess, no MCP server attached) structurally cannot call
    // review_equity_order/place_equity_order — a prompt asking it to "call"
    // those tools can only ever produce a hallucinated result, which would
    // be a false "executed" with no real trade behind it. Instead, generate
    // the exact natural-language instruction to paste into an interactive
    // Claude session that DOES have live Robinhood MCP access (e.g. Claude
    // Code) — the human stays in the loop for every real order.
    const orderTypeText = trade.order_type === "limit"
      ? `a limit order at $${trade.limit_price}`
      : `a ${trade.order_type} order`;
    const manualCommand = `Review and place ${orderTypeText} to ${trade.order_side} ${trade.qty} shares of ${trade.symbol} on Robinhood account ${AGENTIC_ACCOUNT}.`;
    const executionStatus = "approved_awaiting_manual_execution";

    // Log to trade_log (best-effort) — no fill_price/outcome since nothing
    // was actually executed yet; those get filled in once a real order is
    // placed and the account snapshot syncs.
    try {
      await supabase.from("trade_log").insert({
        symbol: trade.symbol,
        order_side: trade.order_side,
        qty: trade.qty,
        fill_price: null,
        analyst_score: trade.analyst_score,
        rationale: (reason ? `User note: ${reason}. ` : "") + (trade.rationale ?? ""),
        outcome: null,
        executed_at: null,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({
      success: true,
      executionStatus,
      manual_command: manualCommand,
      manual_command_note: "Paste this into a Claude session with Robinhood MCP access (e.g. Claude Code) to actually place the order. This app cannot execute Robinhood trades itself.",
      message: `Approved — paste the manual_command into an MCP-enabled Claude session to place it: "${manualCommand}"`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
