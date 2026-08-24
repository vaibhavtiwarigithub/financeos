export interface OpenRunAlert {
  issue_key: string;
  created_at: string;
}

export interface AgentRunIdentity {
  agent_type: string;
  market: string | null;
  status: string;
  started_at: string;
}

function alertIdentity(issueKey: string): { agentType: string; market: "us" | "india" } | null {
  const stale = /^cron-stale:([^:]+):\d{4}-\d{2}-\d{2}:(us|india)$/.exec(issueKey);
  if (stale) return { agentType: stale[1], market: stale[2] as "us" | "india" };
  const failed = /^run-failed:([^:]+):(us|india)$/.exec(issueKey);
  if (failed) return { agentType: failed[1], market: failed[2] as "us" | "india" };
  return null;
}

export function isTerminalSuccessfulRun(status: unknown): boolean {
  return /^(done|completed|success|succeeded|skipped)$/i.test(String(status ?? ""));
}

/** An incident becomes historical only after the same market/job records a
 * later terminal-success run. Running/queued/unknown rows are not recovery.
 * The old alert row is retained and marked resolved. */
export function recoveredRunAlert(alert: OpenRunAlert, runs: AgentRunIdentity[]): boolean {
  const identity = alertIdentity(alert.issue_key);
  const openedAt = Date.parse(alert.created_at);
  if (!identity || !Number.isFinite(openedAt)) return false;
  return runs.some((run) =>
    run.agent_type === identity.agentType
    && run.market === identity.market
    && isTerminalSuccessfulRun(run.status)
    && Date.parse(run.started_at) > openedAt,
  );
}
