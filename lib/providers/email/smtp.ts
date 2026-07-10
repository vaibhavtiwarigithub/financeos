// SMTP email provider stub — set EMAIL_PROVIDER=smtp + SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.
// Uses Nodemailer (npm install nodemailer @types/nodemailer) — add to package.json when activating.
import type { EmailProvider, EmailMessage } from "./types";

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";

  isAvailable(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  async send(_msg: EmailMessage): Promise<void> {
    if (!this.isAvailable()) return;
    // To activate: npm install nodemailer @types/nodemailer, then implement here.
    console.warn("[SmtpEmailProvider] nodemailer not installed — run: npm install nodemailer @types/nodemailer");
  }
}
