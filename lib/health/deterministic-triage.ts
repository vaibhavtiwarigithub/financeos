export interface HealthAlertInput {
  issue_key?: string | null;
  severity?: string | null;
  category?: string | null;
  title?: string | null;
  detail?: string | null;
  created_at?: string | null;
}

export interface HealthRunInput {
  agent_type: string;
  market?: string | null;
  status: string;
  error?: string | null;
  result_summary?: string | null;
  started_at?: string | null;
}

export interface DeterministicHealthIssue {
  issue_key: string;
  severity: "critical" | "warn" | "info";
  root_cause: string;
  blast_radius: string;
  suggested_fix: string;
}

function severity(value: string | null | undefined): DeterministicHealthIssue["severity"] {
  const v = String(value ?? "info").toLowerCase();
  if (v === "critical" || v === "error") return "critical";
  if (v === "warn" || v === "warning") return "warn";
  return "info";
}

function actionFor(category: string, detail: string): string {
  if (category === "broker") return detail || "Reconnect the broker in Settings.";
  if (category === "trading" || category === "risk") return detail || "Review the affected market control before resuming entries.";
  if (category === "cron") return detail || "Inspect the latest run and retry the scheduled job.";
  if (category === "data") return detail || "No action unless the condition persists beyond its stated reset window.";
  return detail || "Review the linked System Health item.";
}

export function buildDeterministicTriage(
  alerts: HealthAlertInput[],
  runs: HealthRunInput[],
): { summary: string; issues: DeterministicHealthIssue[] } {
  const issues: DeterministicHealthIssue[] = alerts.map((alert, index) => {
    const category = String(alert.category ?? "system");
    const title = String(alert.title ?? "Open system issue");
    const detail = String(alert.detail ?? "");
    return {
      issue_key: String(alert.issue_key ?? `open-alert-${index + 1}`),
      severity: severity(alert.severity),
      root_cause: title,
      blast_radius: category,
      suggested_fix: actionFor(category, detail),
    };
  });

  // Only the latest run for an agent/market can create a run issue. An older
  // timeout followed by a successful run is recovered history, not an active
  // fault that should remain on Home.
  const latestByAgent = new Map<string, HealthRunInput>();
  for (const run of runs) {
    const key = `${run.agent_type}:${run.market ?? "global"}`;
    const existing = latestByAgent.get(key);
    const ts = Date.parse(run.started_at ?? "") || 0;
    const existingTs = Date.parse(existing?.started_at ?? "") || 0;
    if (!existing || ts > existingTs) latestByAgent.set(key, run);
  }
  for (const [key, run] of latestByAgent) {
    if (run.status !== "error") continue;
    issues.push({
      issue_key: `run-error:${key}`,
      severity: "warn",
      root_cause: run.error || run.result_summary || `${run.agent_type} ended in error`,
      blast_radius: `${run.agent_type}${run.market ? ` (${run.market})` : ""}`,
      suggested_fix: "Inspect the recorded run output; retry only if the next scheduled run has not recovered.",
    });
  }

  const actionable = issues.filter((issue) => issue.severity !== "info").length;
  const critical = issues.filter((issue) => issue.severity === "critical").length;
  const summary = issues.length === 0
    ? "All monitored systems are normal."
    : `${issues.length} current issue${issues.length === 1 ? "" : "s"}: ${actionable} actionable${critical ? `, ${critical} critical` : ""}.`;
  return { summary, issues };
}
