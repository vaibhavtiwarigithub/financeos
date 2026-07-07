import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";

// System Health issue funnel.
//
// One place every subsystem reports a fault into. Backed by `agent_alerts`
// (migration 099 added `issue_key` + a partial unique index so at most ONE open
// row per issue_key). A recurring condition therefore produces exactly one open
// alert (refreshed, not duplicated) and clears automatically via resolveIssue.
//
// issue_key is a STABLE identifier for a condition, e.g.
//   model-deprecated:deepseek-reasoner
//   av-budget-exhausted
//   broker-token:kite
//   order-needs-reconcile:<orderId>
//   killswitch:trading_us
//   cron-failed:kairos-learner
// Keep it deterministic for the same condition so dedup + auto-resolve work.

export type Severity = "info" | "warn" | "critical";

export interface ReportIssueInput {
  issueKey: string;
  severity: Severity;
  category: string;
  title: string;
  detail?: string | null;
  /** Optional absolute expiry — the alert self-clears after this time. */
  autoExpireAt?: string | null;
}

/**
 * Open (or refresh) the single open alert for `issueKey`. Idempotent: if an open
 * row already exists for the key, its severity/title/detail/expiry are updated
 * in place rather than creating a duplicate. Never throws — a health-reporting
 * failure must not break the caller's real work.
 */
export async function reportIssue(
  input: ReportIssueInput,
  client?: SupabaseClient,
): Promise<void> {
  const svc = client ?? createServiceClient();
  try {
    const { data: existing } = await svc
      .from("agent_alerts")
      .select("id")
      .eq("issue_key", input.issueKey)
      .eq("resolved", false)
      .limit(1)
      .maybeSingle();

    const payload = {
      severity: input.severity,
      category: input.category,
      title: input.title,
      detail: input.detail ?? null,
      auto_expire_at: input.autoExpireAt ?? null,
    };

    if (existing?.id) {
      await svc.from("agent_alerts").update(payload).eq("id", (existing as any).id);
    } else {
      // The partial unique index guards against a race creating two open rows.
      // On conflict there's already an open row — treat as success.
      const { error } = await svc.from("agent_alerts").insert({ issue_key: input.issueKey, resolved: false, ...payload });
      if (error && !/duplicate key|unique/i.test(error.message)) {
        console.error(`[system-health] reportIssue(${input.issueKey}) failed:`, error.message);
      }
    }
  } catch (e) {
    console.error(`[system-health] reportIssue(${input.issueKey}) threw:`, e);
  }
}

/**
 * Resolve the open alert for `issueKey`, if any. Safe to call unconditionally
 * (e.g. every scheduled check calls resolveIssue when the condition is absent).
 * Never throws.
 */
export async function resolveIssue(issueKey: string, client?: SupabaseClient): Promise<void> {
  const svc = client ?? createServiceClient();
  try {
    await svc
      .from("agent_alerts")
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq("issue_key", issueKey)
      .eq("resolved", false);
  } catch (e) {
    console.error(`[system-health] resolveIssue(${issueKey}) threw:`, e);
  }
}

/**
 * Reconcile a set of issue_keys against the conditions that are currently
 * active for a given key PREFIX: report each active one, and resolve any open
 * alert under that prefix whose key is no longer active. Lets a scheduled
 * reporter own a whole namespace (e.g. `model-deprecated:`) and self-heal.
 */
export async function reconcileIssues(
  prefix: string,
  active: ReportIssueInput[],
  client?: SupabaseClient,
): Promise<void> {
  const svc = client ?? createServiceClient();
  const activeKeys = new Set(active.map((a) => a.issueKey));
  for (const a of active) await reportIssue(a, svc);
  try {
    const { data: open } = await svc
      .from("agent_alerts")
      .select("issue_key")
      .eq("resolved", false)
      .like("issue_key", `${prefix}%`);
    for (const row of open ?? []) {
      const k = (row as any).issue_key as string;
      if (k && !activeKeys.has(k)) await resolveIssue(k, svc);
    }
  } catch (e) {
    console.error(`[system-health] reconcileIssues(${prefix}) threw:`, e);
  }
}
