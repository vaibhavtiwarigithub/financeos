import { createServiceClient } from "@/lib/supabase/service";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vterminater@gmail.com";
const FROM_EMAIL = "kairos@notifications.kairos.trade";

async function getResendKey(): Promise<string | null> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("api_key_vault")
      .select("key_value")
      .eq("key_name", "RESEND_API_KEY")
      .single();
    return (data as any)?.key_value ?? process.env.RESEND_API_KEY ?? null;
  } catch {
    return process.env.RESEND_API_KEY ?? null;
  }
}

export async function notifyTradeAction(opts: {
  action: "submitted" | "approved" | "rejected" | "failed" | "expired" | "blocked";
  symbol: string;
  qty: number;
  side: string;
  price?: number;
  orderId?: string;
  proposalId: number;
  reason?: string;
  warning?: string;
}): Promise<void> {
  const resendKey = await getResendKey();
  if (!resendKey) return; // silent — no key configured yet

  const { action, symbol, qty, side, price, orderId, proposalId, reason, warning } = opts;

  const emoji = {
    submitted:  "✅",
    approved:   "⏳",
    rejected:   "❌",
    failed:     "🚨",
    expired:    "⏰",
    blocked:    "🛑",
  }[action];

  const subject = `${emoji} Kairos Trade ${action.toUpperCase()}: ${side.toUpperCase()} ${qty}x ${symbol}`;

  const lines = [
    `<b>Action:</b> ${action.toUpperCase()}`,
    `<b>Symbol:</b> ${symbol}`,
    `<b>Side:</b> ${side.toUpperCase()}`,
    `<b>Qty:</b> ${qty}`,
    price ? `<b>Price:</b> $${price.toFixed(2)}` : null,
    orderId ? `<b>Robinhood Order ID:</b> ${orderId}` : null,
    `<b>Proposal ID:</b> ${proposalId}`,
    reason ? `<b>Reason:</b> ${reason}` : null,
    warning ? `<b>⚠️ Warning:</b> ${warning}` : null,
    `<b>Time:</b> ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    `<br><small>Kairos — if you did not initiate this, disable trading immediately in Settings → Strategy.</small>`,
  ].filter(Boolean).join("<br>");

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_EMAIL],
        subject,
        html: `<div style="font-family:monospace;font-size:14px;line-height:1.8">${lines}</div>`,
      }),
    });
  } catch {
    // Non-critical — never let email failure block a trade operation
  }
}
