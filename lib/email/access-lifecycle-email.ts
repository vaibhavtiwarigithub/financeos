// Branded, non-actionable notices for owner-managed viewer access changes.
// These messages never contain a credential or an account-recovery link.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

type LifecycleKind = "revoked" | "deleted";

export function accessLifecycleSubject(kind: LifecycleKind): string {
  return kind === "deleted"
    ? "Your Kairos account has been deleted"
    : "Your Kairos viewing permission has been revoked";
}

export function buildAccessLifecycleEmailHtml(input: {
  kind: LifecycleKind;
  recipientEmail: string;
  ownerEmail: string;
}): string {
  const deleted = input.kind === "deleted";
  const heading = deleted ? "Your Kairos account has been deleted" : "Your Kairos access has been revoked";
  const body = deleted
    ? "Your Kairos account and its sign-in access have been removed by the workspace owner."
    : "Your permission to view the Kairos workspace has been removed by the workspace owner.";
  const followUp = deleted
    ? "You can no longer sign in. If this was unexpected, contact the workspace owner."
    : "You can no longer sign in or view the workspace. Your account has not been deleted; the owner may restore access later.";

  return `<!doctype html><html><body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;">
  <tr><td style="padding:26px 28px 0;"><div style="font:800 15px Arial,sans-serif;color:#4F46E5;letter-spacing:0.14em;">KAIROS</div><div style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:3px;">Personal investing research</div></td></tr>
  <tr><td style="padding:20px 28px 0;"><div style="font:700 22px Arial,sans-serif;color:#111;">${esc(heading)}</div><div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">Hello ${esc(input.recipientEmail)},</div><div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">${esc(body)}</div><div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">${esc(followUp)}</div></td></tr>
  <tr><td style="padding:22px 28px 26px;"><div style="font:400 11px/1.6 Arial,sans-serif;color:#9CA3AF;border-top:1px solid #EEF0F4;padding-top:13px;">This is a notice from ${esc(input.ownerEmail)}'s Kairos workspace. No action is required. Nothing in Kairos is investment advice.</div></td></tr>
</table></td></tr></table></body></html>`;
}

export function accessResendSubject(): string {
  return "Your Kairos viewer access";
}

export function buildAccessResendEmailHtml(input: { actionLink: string; recipientEmail: string; ownerEmail: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;">
  <tr><td style="padding:26px 28px 0;"><div style="font:800 15px Arial,sans-serif;color:#4F46E5;letter-spacing:0.14em;">KAIROS</div><div style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:3px;">Personal investing research</div></td></tr>
  <tr><td style="padding:20px 28px 0;"><div style="font:700 22px Arial,sans-serif;color:#111;">Your viewer access</div><div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">Hello ${esc(input.recipientEmail)},</div><div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">${esc(input.ownerEmail)} has resent your read-only Kairos access. You can view the shared paper portfolio and research, but cannot trade, change settings, or access the owner's live accounts.</div></td></tr>
  <tr><td style="padding:22px 28px 0;"><a href="${esc(input.actionLink)}" style="display:inline-block;background:#4F46E5;color:#FFFFFF;text-decoration:none;font:600 14px Arial,sans-serif;padding:13px 26px;border-radius:7px;">Open Kairos</a><div style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:10px;">This sign-in link is single-use and expires. If you were not expecting it, you can ignore this email.</div></td></tr>
  <tr><td style="padding:22px 28px 26px;"><div style="font:400 11px/1.6 Arial,sans-serif;color:#9CA3AF;border-top:1px solid #EEF0F4;padding-top:13px;">Kairos is a personal research tool. Nothing in it is investment advice.</div></td></tr>
</table></td></tr></table></body></html>`;
}
