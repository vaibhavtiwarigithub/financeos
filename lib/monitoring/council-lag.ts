// LLM-council silence detection. The council writes no agent_runs rows, so the cron-liveness checks cannot see it; these two
// signals make a dead or stalled council visible instead of silent (nothing reads council scores, so nothing else would notice).
//   1. Unscored research: a symbol's NEWEST observation (the one the council would pick) is older than the grace period and
//      has no council run. Older same-symbol observations are superseded by design and never count.
//   2. Delayed workers: selected subscription jobs queued past the grace period are a real score-latency signal. A recent
//      `last_seen_at` means the local worker is active and draining a backlog, not offline; stale/missing heartbeat means it
//      has stopped progressing. DeepSeek still scores while the local members wait.

export type CouncilObservation = { id: number; market: "us" | "india"; symbol: string; ts: string };
export type QueuedCouncilJob = { family: string; created_at: string; last_seen_at?: string | null };
export type TerminalCouncilJob = { family: string; model: string; market: string; symbol: string; runId: string; status: string; created_at: string; hasCompletedForecast?: boolean };

export const COUNCIL_UNSCORED_GRACE_MIN = 90;
export const COUNCIL_QUEUE_GRACE_MIN = 120;
export const COUNCIL_WORKER_HEARTBEAT_GRACE_MIN = 30;
export const COUNCIL_TERMINAL_JOB_WINDOW_HOURS = 24;

export type StalledWorkerSummary = { count: number; oldest: string; active: boolean; lastSeenAt: string | null };
export type TerminalCouncilGap = { count: number; symbols: string[]; statuses: string[]; oldest: string };

// Terminal membership failures mean the run can never receive that member's score. Keep them
// visible in System Health; do not retry here, because retries consume subscription/API quota.
export function findTerminalCouncilGaps(args: { jobs: TerminalCouncilJob[]; limitSymbols?: number }) {
  const byMember = new Map<string, TerminalCouncilGap>();
  const countedRuns = new Set<string>();
  for (const job of args.jobs) {
    if ((job.status !== "failed" && job.status !== "expired") || job.hasCompletedForecast) continue;
    const member = job.family.toLowerCase();
    if (member !== "claude" && member !== "codex") continue;
    const key = `${job.market}:${member}`;
    const runKey = `${key}:${job.runId}:${job.model}`;
    if (countedRuns.has(runKey)) continue;
    countedRuns.add(runKey);
    const current = byMember.get(key) ?? { count: 0, symbols: [], statuses: [], oldest: job.created_at };
    current.count += 1;
    if (job.symbol && !current.symbols.includes(job.symbol) && current.symbols.length < (args.limitSymbols ?? 5)) current.symbols.push(job.symbol);
    if (!current.statuses.includes(job.status)) current.statuses.push(job.status);
    if (job.created_at < current.oldest) current.oldest = job.created_at;
    byMember.set(key, current);
  }
  return byMember;
}

export function findUnscoredResearch(args: { now: Date; observations: CouncilObservation[]; scoredObservationIds: Set<number>; graceMin?: number }) {
  const grace = (args.graceMin ?? COUNCIL_UNSCORED_GRACE_MIN) * 60_000;
  const newest = new Map<string, CouncilObservation>();
  for (const o of args.observations) {
    const key = `${o.market}:${o.symbol}`;
    const cur = newest.get(key);
    if (!cur || o.ts > cur.ts || (o.ts === cur.ts && o.id > cur.id)) newest.set(key, o);
  }
  const byMarket = new Map<string, { count: number; oldestTs: string; example: string }>();
  for (const o of newest.values()) {
    if (args.now.getTime() - Date.parse(o.ts) < grace || args.scoredObservationIds.has(Number(o.id))) continue;
    const cur = byMarket.get(o.market);
    byMarket.set(o.market, { count: (cur?.count ?? 0) + 1, oldestTs: !cur || o.ts < cur.oldestTs ? o.ts : cur.oldestTs, example: cur?.example ?? o.symbol });
  }
  return byMarket;
}

export function findStalledWorkers(args: { now: Date; jobs: QueuedCouncilJob[]; graceMin?: number; heartbeatGraceMin?: number }) {
  const grace = (args.graceMin ?? COUNCIL_QUEUE_GRACE_MIN) * 60_000;
  const heartbeatGrace = (args.heartbeatGraceMin ?? COUNCIL_WORKER_HEARTBEAT_GRACE_MIN) * 60_000;
  const byFamily = new Map<string, StalledWorkerSummary>();
  for (const j of args.jobs) {
    if (args.now.getTime() - Date.parse(j.created_at) < grace) continue;
    // Old queued work is a real lag signal, but not evidence that a worker is
    // dead if that worker has recently claimed/submitted jobs. Keep the alert
    // while backlog exists; callers can distinguish active backlog from a
    // worker that has stopped progressing.
    const cur = byFamily.get(j.family);
    const lastSeenIsRecent = j.last_seen_at != null && args.now.getTime() - Date.parse(j.last_seen_at) < heartbeatGrace;
    const latestSeen = j.last_seen_at && (!cur?.lastSeenAt || j.last_seen_at > cur.lastSeenAt) ? j.last_seen_at : cur?.lastSeenAt ?? null;
    byFamily.set(j.family, {
      count: (cur?.count ?? 0) + 1,
      oldest: !cur || j.created_at < cur.oldest ? j.created_at : cur.oldest,
      active: Boolean(cur?.active || lastSeenIsRecent),
      lastSeenAt: latestSeen,
    });
  }
  return byFamily;
}
