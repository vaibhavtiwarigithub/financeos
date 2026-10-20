const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

export function vaultPinRecoverySubject(): string {
  return "Your Kairos Vault PIN reset code";
}

export function buildVaultPinRecoveryEmailHtml(input: { code: string; ownerEmail: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;">
  <tr><td style="padding:26px 28px 0;"><div style="font-weight:800;font-size:15px;color:#4F46E5;letter-spacing:.14em;">KAIROS</div><div style="font-size:11px;color:#9CA3AF;margin-top:3px;">API Key Vault security</div></td></tr>
  <tr><td style="padding:22px 28px 0;"><div style="font-weight:700;font-size:22px;">Reset your Vault PIN</div><p style="font-size:14px;line-height:1.6;color:#4B5563;">Enter this one-time code in the Vault recovery form. It verifies your owner email and does not change any API keys or your Kairos account password.</p>
  <div style="margin:20px 0;padding:16px;text-align:center;background:#F3F4F6;border-radius:8px;font-size:30px;font-weight:700;letter-spacing:.32em;color:#111827;">${escapeHtml(input.code)}</div>
  <p style="font-size:12px;line-height:1.6;color:#6B7280;">This code expires according to your Supabase email OTP settings and can be used once. If you did not request it, ignore this email. Never share this code.</p></td></tr>
  <tr><td style="padding:8px 28px 26px;"><div style="font-size:11px;line-height:1.6;color:#9CA3AF;border-top:1px solid #EEF0F4;padding-top:13px;">Requested for ${escapeHtml(input.ownerEmail)}. Kairos will never ask you to send this code by email or chat.</div></td></tr>
</table></td></tr></table></body></html>`;
}
