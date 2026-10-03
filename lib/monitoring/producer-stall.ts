// Upgrade Path producers (ATR forward book, allocation replay, ...) write one run row per invocation. The Upgrade
// Path page shows the latest status, but nothing alerted when a producer stopped making progress: the ATR forward
// book was blocked/errored on every run from 2026-09-28 to 2026-10-03 (an inverted population check plus an
// order-ambiguity refusal) and only a manual review noticed. A producer is stalled when its most recent
// `window` runs span at least two UTC days and none of them collected.
export interface ProducerRunRow {
  program_id: string;
  market: string;
  status: string;
  started_at: string;
  blockers?: unknown;
}

export interface StalledProducer {
  programId: string;
  market: string;
  runs: number;
  firstStartedAt: string;
  lastStartedAt: string;
  lastStatus: string;
  lastBlocker: string | null;
}

const OK_STATUSES = new Set(["collected", "running"]);

export function detectStalledProducers(rows: ProducerRunRow[], window = 4): StalledProducer[] {
  const groups = new Map<string, ProducerRunRow[]>();
  for (const row of rows) {
    const key = `${row.program_id}|${row.market}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const stalled: StalledProducer[] = [];
  for (const [, list] of groups) {
    const recent = [...list].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, window);
    if (recent.length < window) continue;
    if (recent.some((row) => OK_STATUSES.has(row.status))) continue;
    const days = new Set(recent.map((row) => row.started_at.slice(0, 10)));
    if (days.size < 2) continue;
    const latest = recent[0];
    const blockers = Array.isArray(latest.blockers) ? latest.blockers : [];
    stalled.push({
      programId: latest.program_id, market: latest.market, runs: recent.length,
      firstStartedAt: recent[recent.length - 1].started_at, lastStartedAt: latest.started_at,
      lastStatus: latest.status, lastBlocker: blockers.length ? String(blockers[0]).slice(0, 240) : null,
    });
  }
  return stalled;
}
