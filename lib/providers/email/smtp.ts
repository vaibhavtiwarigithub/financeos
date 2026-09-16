// SMTP email provider. Activate with EMAIL_PROVIDER=smtp plus SMTP_HOST,
// SMTP_PORT, SMTP_USER and SMTP_PASS.
//
// Gmail: smtp.gmail.com:465, SMTP_USER is the full address and SMTP_PASS is an
// APP PASSWORD (requires 2FA — a normal account password is refused). EMAIL_FROM
// must be that same mailbox or one of its verified aliases; Gmail rewrites or
// rejects a From it does not own. This exists because Resend's shared
// `onboarding@resend.dev` sender may only mail the Resend account owner, so
// inviting anyone else needs either a verified domain or a different transport.
//
// This file was a stub whose send() only logged a warning. That was worse than
// missing: `invite()` falls back to `provider.send(...).then(() => ({ ok: true }))`
// when `sendChecked` is absent, so EMAIL_PROVIDER=smtp would have reported every
// invitation as sent, written the access grant, and mailed nothing — the exact
// "granted access to someone who was never told" failure the invite route's
// checked-send contract exists to prevent.
import nodemailer, { type Transporter } from "nodemailer";
import type { EmailProvider, EmailMessage, SendResult } from "./types";

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: Transporter | null = null;

  isAvailable(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  /**
   * Every SMTP setting is env-only — there is no vault lookup behind this one,
   * unlike Resend — so the synchronous answer is already the honest one. Present
   * so callers can use `emailDeliveryAvailable()` uniformly across providers.
   */
  async isDeliverable(): Promise<boolean> {
    return this.isAvailable();
  }

  private getTransport(): Transporter | null {
    if (!this.isAvailable()) return null;
    if (!this.transporter) {
      const port = Number(process.env.SMTP_PORT ?? 465);
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
        secure: port === 465,
        auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
      });
    }
    return this.transporter;
  }

  async sendChecked(msg: EmailMessage): Promise<SendResult> {
    const transport = this.getTransport();
    if (!transport) {
      return { ok: false, error: "SMTP is not configured (needs SMTP_HOST, SMTP_USER, SMTP_PASS)" };
    }
    try {
      const info: any = await transport.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
      // sendMail RESOLVES as long as the server accepted at least one recipient,
      // reporting the refused ones in `rejected`. A refused address is not a
      // delivery, and reporting ok:true for it would grant access to someone the
      // mail server already said it would not carry mail to.
      const rejected: string[] = Array.isArray(info?.rejected) ? info.rejected : [];
      if (rejected.length) {
        return { ok: false, error: `SMTP server rejected: ${rejected.join(", ")}`.slice(0, 200) };
      }
      // Kept for the same reason as Resend's id: acceptance is not delivery, and
      // this is the only handle tying a later bounce back to this exact send.
      const id = typeof info?.messageId === "string" ? info.messageId : undefined;
      return { ok: true, id };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** Best-effort send. Never throws, per the EmailProvider contract. */
  async send(msg: EmailMessage): Promise<void> {
    try {
      await this.sendChecked(msg);
    } catch {
      // Non-critical — never let email failure propagate to callers.
    }
  }
}
