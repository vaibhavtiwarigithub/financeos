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
  /**
   * Stable identifier for the CONDITION, not this occurrence — e.g.
   * `research-deferred-holdings:us`. `resolveIssue()` clears by this key and the
   * partial unique index keeps at most one open row per key, so a recurring
   * condition refreshes one alert instead of stacking new ones.
   *
   * Omitting it produces an alert nothing can ever clear. That is why the board
   * accumulated eight permanently-open "Research: N symbols failed" rows from
   * late July: this helper did not write the column at all, so every alert it
   * emitted was unclearable by construction while `reportIssue()` alerts cleared
   * normally. Half a board of stale warns is how a real one gets missed.
   *
   * Leave undefined ONLY for a genuinely one-shot notice that should persist
   * until manually dismissed.
   */
  issue_key?: string | null;
}

/**
 * Insert or refresh one agent alert. Never throws — best-effort, returns ok flag.
 *
 * With an `issue_key`, this is idempotent: an already-open row for that key is
 * refreshed in place rather than duplicated, matching `reportIssue()` and
 * satisfying the partial unique index on (issue_key) where not resolved.
 */
export async function emitAlert(input: AlertInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const svc = createServiceClient();
    const payload = {
      severity: input.severity ?? "warn",
      category: input.category ?? "system",
      title: input.title,
      detail: input.detail ?? null,
      auto_expire_at: input.auto_expire_at ?? null,
    };

    if (input.issue_key) {
      const { data: existing } = await svc
        .from("agent_alerts")
        .select("id")
        .eq("issue_key", input.issue_key)
        .eq("resolved", false)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        const { error } = await svc.from("agent_alerts").update(payload).eq("id", (existing as any).id);
        return error ? { ok: false, error: error.message } : { ok: true };
      }
    }

    const { error } = await svc.from("agent_alerts").insert({ ...payload, issue_key: input.issue_key ?? null });
    // A concurrent emitter won the race for this key; an open row exists, which
    // is the desired end state.
    if (error && /duplicate key|unique/i.test(error.message)) return { ok: true };
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
