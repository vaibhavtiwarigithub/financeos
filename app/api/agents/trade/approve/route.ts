import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

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

    // Attempt Robinhood execution via Claude subprocess
    const robinhoodPrompt = `Use the Robinhood MCP to place a ${trade.order_type} ${trade.order_side} order.
Order details:
- Symbol: ${trade.symbol}
- Quantity: ${trade.qty} shares
- ${trade.order_type === "limit" ? `Limit price: $${trade.limit_price}` : "Order type: market"}
- Account: use the agentic trading account

Call place_equity_order with these parameters. After the call, output ONLY a JSON object:
{"success": true, "order_id": "...", "status": "...", "filled_price": 0.00}
OR on failure:
{"success": false, "error": "reason"}`;

    let robinhoodResult: any = null;
    let executionStatus = "approved_pending_execution";

    try {
      const stdout = await execClaude(robinhoodPrompt, 60000);
      const raw = parseClaudeOutput(stdout);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        robinhoodResult = JSON.parse(jsonMatch[0]);
        if (robinhoodResult?.success) {
          executionStatus = "executed";
          await supabase.from("trade_queue").update({
            status: "executed",
            robinhood_order_id: robinhoodResult.order_id ?? null,
          } as any).eq("id", tradeId);
        } else {
          executionStatus = "approved_pending_execution";
        }
      }
    } catch {
      executionStatus = "approved_pending_execution";
      robinhoodResult = { success: false, error: "Robinhood OAuth not complete in subprocess — complete auth in main Claude session" };
    }

    // Log to trade_log (best-effort)
    try {
      await supabase.from("trade_log").insert({
        symbol: trade.symbol,
        order_side: trade.order_side,
        qty: trade.qty,
        fill_price: robinhoodResult?.filled_price ?? trade.limit_price,
        analyst_score: trade.analyst_score,
        rationale: (reason ? `User note: ${reason}. ` : "") + (trade.rationale ?? ""),
        outcome: null,
        executed_at: new Date().toISOString(),
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({
      success: true,
      executionStatus,
      robinhoodResult,
      message: executionStatus === "executed"
        ? `Order placed: ${trade.qty} shares of ${trade.symbol}`
        : `Trade approved. Robinhood execution pending — complete OAuth to enable auto-execution.`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
