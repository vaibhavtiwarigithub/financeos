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

  /**
   * The honest availability check.
   *
   * `isAvailable()` looks only at the env var, but `resolveKey()` prefers
   * `api_key_vault` — so the two disagreed whenever the key lived only in the
   * vault, which it has since 2026-07-02. That false negative made the
   * invitation route report "email is not configured" while mail was in fact
   * working perfectly well.
   */
  async isDeliverable(): Promise<boolean> {
    return Boolean(await this.resolveKey());
  }

  async sendChecked(msg: EmailMessage): Promise<{ ok: boolean; error?: string }> {
    const key = await this.resolveKey();
    if (!key) return { ok: false, error: "no Resend API key in env or api_key_vault" };
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: msg.from, to: msg.to, subject: msg.subject, html: msg.html }),
      });
      if (!res.ok) {
        // Never echo the body verbatim — it can carry request details.
        return { ok: false, error: `Resend returned HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
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
