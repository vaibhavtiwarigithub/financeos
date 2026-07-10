import { createServiceClient } from "@/lib/supabase/service";
import type { EmailProvider, EmailMessage } from "./types";

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  isAvailable(): boolean {
    return !!(process.env.RESEND_API_KEY);
  }

  private async resolveKey(): Promise<string | null> {
    try {
      const svc = createServiceClient();
      const { data } = await svc
        .from("api_key_vault")
        .select("key_value")
        .eq("key_name", "RESEND_API_KEY")
        .maybeSingle();
      return (data as any)?.key_value ?? process.env.RESEND_API_KEY ?? null;
    } catch {
      return process.env.RESEND_API_KEY ?? null;
    }
  }

  async send(msg: EmailMessage): Promise<void> {
    const key = await this.resolveKey();
    if (!key) return;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: msg.from,
          to: Array.isArray(msg.to) ? msg.to : [msg.to],
          subject: msg.subject,
          html: msg.html,
        }),
      });
    } catch {
      // Non-critical — never let email failure propagate to callers.
    }
  }
}
