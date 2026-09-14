// The Kairos invitation email.
//
// WHY THIS EXISTS. Invitations used to be sent by Supabase itself, via
// `inviteUserByEmail`. That sends Supabase's stock template: the sender reads
// "Supabase Auth", the body says "You've been invited to create an account" with
// no mention of what the account is FOR, and the footer advertises Supabase. For
// someone being invited by a person they know, to look at that person's
// portfolio, that email is both bland and slightly alarming — it gives them no
// reason to trust the link they are being asked to click.
//
// So the link is now minted with `generateLink` (which does NOT send anything)
// and delivered through the app's own email provider, with the app's own name on
// it. Same mail infrastructure as the daily risk email, and the same
// constraints: table-based layout and no inline SVG, because Gmail strips it.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type InviteEmailInput = {
  /** The one-time Supabase action link. Never logged, never shown anywhere else. */
  actionLink: string;
  /** Who invited them, so the email is from a person and not a system. */
  inviterEmail: string;
  /** Optional note the owner typed when inviting. */
  note?: string | null;
  /** True when the recipient already had an account (a restored invite). */
  returning?: boolean;
};

export function inviteEmailSubject(input: InviteEmailInput): string {
  return input.returning
    ? "Your Kairos access has been restored"
    : "You've been invited to Kairos";
}

export function buildInviteEmailHtml(input: InviteEmailInput): string {
  const { actionLink, inviterEmail, note, returning } = input;
  const heading = returning ? "Your access is back" : "You've been invited to Kairos";
  const cta = returning ? "Sign back in" : "Set your password";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;">

    <tr><td style="padding:26px 28px 0;">
      <div style="font:800 15px Arial,sans-serif;color:#4F46E5;letter-spacing:0.14em;">KAIROS</div>
      <div style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:3px;">Personal investing research</div>
    </td></tr>

    <tr><td style="padding:20px 28px 0;">
      <div style="font:700 22px Arial,sans-serif;color:#111;">${esc(heading)}</div>
      <div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:10px;">
        <strong>${esc(inviterEmail)}</strong> has given you read-only access to their Kairos workspace —
        their paper portfolio, the research behind each position, and market analytics.
      </div>
      ${note ? `<div style="font:400 14px/1.6 Arial,sans-serif;color:#4B5563;margin-top:12px;padding:10px 14px;background:#F9FAFB;border-left:3px solid #C7D2FE;">
        &ldquo;${esc(note)}&rdquo;
      </div>` : ""}
    </td></tr>

    <tr><td style="padding:22px 28px 0;">
      <a href="${esc(actionLink)}" style="display:inline-block;background:#4F46E5;color:#FFFFFF;text-decoration:none;font:600 14px Arial,sans-serif;padding:13px 26px;border-radius:7px;">${esc(cta)}</a>
      <div style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:10px;">
        This link is single-use and expires. If it has already expired, ask ${esc(inviterEmail)} to send another.
      </div>
    </td></tr>

    <tr><td style="padding:22px 28px 0;">
      <div style="font:700 12px Arial,sans-serif;color:#111;margin-bottom:6px;">What you can and cannot do</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="font:400 13px/1.6 Arial,sans-serif;color:#4B5563;">
        <tr><td style="padding:3px 0;">You can <strong>view</strong> the portfolio, the research and the markets pages.</td></tr>
        <tr><td style="padding:3px 0;">You can connect <strong>your own</strong> brokerage, read-only, to see risk analytics on your own holdings — only you can see those.</td></tr>
        <tr><td style="padding:3px 0;">You <strong>cannot</strong> trade, place orders, or change anything. Nothing you do can affect anyone's money.</td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:20px 28px 26px;">
      <div style="font:400 11px/1.6 Arial,sans-serif;color:#9CA3AF;border-top:1px solid #EEF0F4;padding-top:13px;">
        Kairos is a personal research tool. Nothing in it is investment advice, and nothing it shows you
        is a recommendation to buy or sell.
        <br>If you weren't expecting this invitation, you can ignore this email — no account is created until
        you set a password.
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}
