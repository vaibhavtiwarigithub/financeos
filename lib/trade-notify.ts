import { getEmailProvider } from "@/lib/providers/email";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vterminater@gmail.com";
const FROM_EMAIL = "kairos@notifications.kairos.trade";

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

  await getEmailProvider().send({
    from: FROM_EMAIL,
    to: ADMIN_EMAIL,
    subject,
    html: `<div style="font-family:monospace;font-size:14px;line-height:1.8">${lines}</div>`,
  });
}
