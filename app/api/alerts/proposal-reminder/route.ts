import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sendProposalReminderEmail } from "@/lib/trade-alert";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

// Called every 15 min by Task Scheduler on weekdays.
// Finds proposals expiring in <10 min that are still pending, sends reminder.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const now = new Date();
  const reminderWindow = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 min from now
  const tooSoon = new Date(now.getTime() + 2 * 60 * 1000).toISOString();         // >2 min remaining

  // Proposals expiring in 2-10 min, still pending, not yet reminded
  const { data: proposals } = await supabase
    .from("trade_proposals")
    .select("id, symbol, side, qty, analyst_score, price_at_proposal, approval_expires_at, thesis")
    .eq("status", "pending_review")
    .gt("approval_expires_at", tooSoon)
    .lte("approval_expires_at", reminderWindow)
    .is("reminder_sent_at", null);

  if (!proposals?.length) {
    return NextResponse.json({ sent: 0 });
  }

  let sent = 0;
  for (const p of proposals) {
    await sendProposalReminderEmail({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      analyst_score: p.analyst_score,
      price_at_proposal: p.price_at_proposal,
      approval_expires_at: p.approval_expires_at,
      thesis: p.thesis,
    }).catch(() => {});

    // Mark reminder sent so we don't double-send on next cron tick
    await supabase
      .from("trade_proposals")
      .update({ reminder_sent_at: now.toISOString() })
      .eq("id", p.id);

    sent++;
  }

  return NextResponse.json({ sent, proposals: proposals.map((p: any) => p.symbol) });
}
