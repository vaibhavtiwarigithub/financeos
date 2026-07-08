// lib/alerts/emit.ts — server-side alert insertion.
//
// Internal callers (cron routes, sync jobs) MUST use this helper instead of
// self-fetching POST /api/alerts. The HTTP route is owner/cron gated for
// safety (P1-3), so an unauthenticated self-fetch would 401 and silently drop
// the alert. Writing through the service client directly is both correct and
// cheaper (no network round-trip).

import { createServiceClient } from "@/lib/supabase/service";

export interface AlertInput {
  severity?: "info" | "warn" | "error" | "critical";
  category?: string;
  title: string;
  detail?: string | null;
  auto_expire_at?: string | null;
}

/** Insert one agent alert. Never throws — best-effort, returns ok flag. */
export async function emitAlert(input: AlertInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const svc = createServiceClient();
    const { error } = await svc.from("agent_alerts").insert({
      severity: input.severity ?? "warn",
      category: input.category ?? "system",
      title: input.title,
      detail: input.detail ?? null,
      auto_expire_at: input.auto_expire_at ?? null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
