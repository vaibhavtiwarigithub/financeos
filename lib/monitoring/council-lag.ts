// LLM-council silence detection. The council writes no agent_runs rows, so the cron-liveness checks cannot see it; these two
// signals make a dead or stalled council visible instead of silent (nothing reads council scores, so nothing else would notice).
//   1. Unscored research: a symbol's NEWEST observation (the one the council would pick) is older than the grace period and
//      has no council run. Older same-symbol observations are superseded by design and never count.
//   2. Stalled workers: subscription jobs sitting in `queued` past the grace period mean a local worker (Claude/Codex) is not
//      draining, usually the PC is off or the CLI signed out. DeepSeek still scores; the other members wait.

export type CouncilObservation = { id: number; market: "us" | "india"; symbol: string; ts: string };
export type QueuedCouncilJob = { family: string; created_at: string };

export const COUNCIL_UNSCORED_GRACE_MIN = 90;
export const COUNCIL_QUEUE_GRACE_MIN = 120;

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

export function findStalledWorkers(args: { now: Date; jobs: QueuedCouncilJob[]; graceMin?: number }) {
  const grace = (args.graceMin ?? COUNCIL_QUEUE_GRACE_MIN) * 60_000;
  const byFamily = new Map<string, { count: number; oldest: string }>();
  for (const j of args.jobs) {
    if (args.now.getTime() - Date.parse(j.created_at) < grace) continue;
    const cur = byFamily.get(j.family);
    byFamily.set(j.family, { count: (cur?.count ?? 0) + 1, oldest: !cur || j.created_at < cur.oldest ? j.created_at : cur.oldest });
  }
  return byFamily;
}
