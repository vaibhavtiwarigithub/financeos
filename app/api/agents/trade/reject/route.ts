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

    await supabase.from("trade_queue").update({
      status: "rejected",
      rejection_reason: reason ?? "Rejected by user",
      user_decision_at: new Date().toISOString(),
    } as any).eq("id", tradeId);

    // Re-open the signal for future consideration
    if (trade.signal_id) {
      await supabase.from("agent_signals").update({ status: "pending" } as any).eq("id", trade.signal_id);
    }

    return NextResponse.json({ success: true, message: `Trade rejected: ${trade.symbol}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
