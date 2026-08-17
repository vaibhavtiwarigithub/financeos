// W6 — layer 2 of 2: typed WITHIN-RUN accounting.
//
// Why this exists. In the 2026-08 evaluation-pipeline incident five separate
// checks could only ever report green. Three of them were run-level:
//   * label-maturation returned {success:true, matured:0, skipped:800}
//   * agent_runs recorded status='done' for that same zero-output run
//   * stale-check asked "did it run", never "did it produce"
//
// The obvious fix — "alert when a run produced nothing" — is WRONG and was
// refuted in review. Zero output is frequently CORRECT: no qualifying signal,
// no exits needed, no new research. A healthy production response looks like
// {"skipped":true,"reason":"weekend + shallow backlog","backlog":0}.
//
// So a run does not report a boolean. It reports RECONCILED COUNTS over the
// units it was responsible for:
//
//   eligible = succeeded + expectedSkip + deferred + unavailable + failed
//
// Every unit is accounted for under exactly one reason. That equation not
// balancing is itself a defect — it means the job lost track of its own work.
//
// Business metrics (trades_filled, positions_closed, labels_written) are
// TELEMETRY, never health criteria. A day with zero fills is a normal day; a
// day where 12 holdings were eligible and none were evaluated is not.
//
// Cross-RUN freshness (did the high-watermark actually advance over days?)
// is the other half and lives in ./freshness-contracts.ts.

export type RunState = "no_work" | "completed" | "partial" | "blocked" | "failed";

export type RunFindingCode =
  | "reconciliation_mismatch"
  | "failed_units"
  | "blocked_run"
  | "negative_counts";

export interface RunFinding {
  code: RunFindingCode;
  severity: "warn" | "critical";
  title: string;
  detail: string;
}

/**
 * What a job reports about the units it was responsible for this run.
 *
 * Reason buckets are deliberately heterogeneous — this is exactly why a mutable
 * DB table could not encode them and why the contract lives in code:
 *  - `succeeded`    unit was processed to completion
 *  - `expectedSkip` unit legitimately had no work (already matured, market shut,
 *                   horizon not reached, position already flat)
 *  - `deferred`     unit is real work postponed on purpose (budget/rate cap,
 *                   batch cursor) — normal once, suspicious forever
 *  - `unavailable`  an input the unit needed was missing (no fresh quote, no
 *                   candles) — the job behaved correctly, the data did not
 *  - `failed`       the job tried and errored. Always alerts.
 */
export interface RunAccounting {
  job: string;
  market?: "us" | "india" | "global";
  eligible: number;
  succeeded: number;
  expectedSkip: number;
  deferred: number;
  unavailable: number;
  failed: number;
  /** Free-form reason → count, for the alert detail only. Never a health input. */
  skipReasons?: Record<string, number>;
  /** Why nothing succeeded. Required to be meaningful when the run is blocked. */
  blockers?: string[];
  /**
   * Monotone progress marker this run advanced to (ISO date/timestamp or an id).
   * Reported for the human; the STALL detection is cross-run and lives in
   * freshness-contracts.ts, because a single run cannot know it is stuck.
   */
  highWatermark?: string | number | null;
  /** Telemetry only. Explicitly excluded from every health rule below. */
  businessMetrics?: Record<string, number>;
}

export interface RunVerdict {
  state: RunState;
  healthy: boolean;
  reconciles: boolean;
  findings: RunFinding[];
  /** One-line human summary, safe to store in agent_runs.result_summary. */
  summary: string;
}

const RUN_ACCOUNTING_KEY = "run_accounting";

function label(a: RunAccounting): string {
  return a.market ? `${a.job} (${a.market})` : a.job;
}

function counts(a: RunAccounting): string {
  return `eligible=${a.eligible} succeeded=${a.succeeded} expected_skip=${a.expectedSkip} `
    + `deferred=${a.deferred} unavailable=${a.unavailable} failed=${a.failed}`;
}

/**
 * Pure detector. Given one run's accounting, return its typed state and every
 * condition that should raise an alert.
 *
 * Alerts on, and ONLY on:
 *  1. any failed unit
 *  2. an impossible reconciliation (the eligible equation does not balance,
 *     or a count is negative)
 *  3. eligible > 0 && succeeded === 0 — reported WITH the blocker reason so the
 *     alert says why, not just that
 *
 * Never alerts on: zero eligible units (that is `no_work`, the healthy weekend
 * / empty-backlog case), or on any business metric being zero.
 */
export function evaluateRunAccounting(a: RunAccounting): RunVerdict {
  const findings: RunFinding[] = [];
  const fields = [a.eligible, a.succeeded, a.expectedSkip, a.deferred, a.unavailable, a.failed];

  if (fields.some((n) => !Number.isFinite(n) || n < 0)) {
    findings.push({
      code: "negative_counts",
      severity: "critical",
      title: `${label(a)}: run accounting is not a valid count set`,
      detail: `${counts(a)}. A negative or non-finite count means the job's own bookkeeping is broken; no health claim can be made from this run.`,
    });
  }

  const accountedFor = a.succeeded + a.expectedSkip + a.deferred + a.unavailable + a.failed;
  const reconciles = accountedFor === a.eligible;
  if (!reconciles) {
    findings.push({
      code: "reconciliation_mismatch",
      severity: "critical",
      title: `${label(a)}: ${Math.abs(a.eligible - accountedFor)} unit(s) unaccounted for`,
      detail: `${counts(a)}. Reasons sum to ${accountedFor} but ${a.eligible} were eligible. `
        + `The job silently dropped work — this is the shape of the failure that produced zero labels for 25 days behind a green response.`,
    });
  }

  if (a.failed > 0) {
    findings.push({
      code: "failed_units",
      severity: "critical",
      title: `${label(a)}: ${a.failed} unit(s) failed`,
      detail: `${counts(a)}. A failed unit is never healthy, regardless of how many succeeded alongside it.`
        + (a.blockers?.length ? ` Reported: ${a.blockers.join("; ")}` : ""),
    });
  }

  const blocked = a.eligible > 0 && a.succeeded === 0;
  if (blocked) {
    const why = a.blockers?.length
      ? a.blockers.join("; ")
      : "the job named no blocker — it processed nothing and could not say why";
    findings.push({
      code: "blocked_run",
      severity: a.failed > 0 ? "critical" : "warn",
      title: `${label(a)}: ${a.eligible} eligible, 0 succeeded`,
      detail: `${counts(a)}. Reason: ${why}.`
        + (a.skipReasons ? ` Skip breakdown: ${Object.entries(a.skipReasons).map(([k, v]) => `${k}=${v}`).join(", ")}.` : "")
        + ` Zero output is only healthy when zero units were eligible.`,
    });
  }

  let state: RunState;
  if (a.failed > 0 && a.succeeded === 0) state = "failed";
  else if (a.failed > 0) state = "partial";
  else if (a.eligible === 0) state = "no_work";
  else if (a.succeeded === 0) state = "blocked";
  else if (a.deferred + a.unavailable > 0) state = "partial";
  else state = "completed";

  const summary = `${label(a)} ${state}: ${counts(a)}`
    + (a.highWatermark != null ? ` watermark=${a.highWatermark}` : "");

  return {
    state,
    healthy: findings.length === 0,
    reconciles,
    findings,
    summary,
  };
}

/**
 * Envelope to store in `agent_runs.result_summary` so stale-check (and any
 * later reader) can re-derive the verdict without trusting `status`.
 * Callers keep their own free-form summary fields alongside it.
 */
export function runAccountingEnvelope(a: RunAccounting): Record<string, unknown> {
  const verdict = evaluateRunAccounting(a);
  return {
    [RUN_ACCOUNTING_KEY]: { schemaVersion: 1, ...a, state: verdict.state, healthy: verdict.healthy },
  };
}

/**
 * Recover a RunAccounting from whatever a job wrote into `result_summary`.
 * That column is a plain string for most jobs and JSON for a few, so accept
 * both and return null for anything that is not a well-formed envelope —
 * a missing envelope is "unknown", never "healthy".
 */
export function parseRunAccounting(value: unknown): RunAccounting | null {
  let obj: any = value;
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    if (!trimmed.startsWith("{")) return null;
    try { obj = JSON.parse(trimmed); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const a = obj[RUN_ACCOUNTING_KEY] ?? obj;
  if (!a || typeof a !== "object") return null;
  const nums = ["eligible", "succeeded", "expectedSkip", "deferred", "unavailable", "failed"];
  if (!nums.every((k) => typeof a[k] === "number")) return null;
  if (typeof a.job !== "string" || !a.job) return null;
  return {
    job: a.job,
    market: a.market,
    eligible: a.eligible,
    succeeded: a.succeeded,
    expectedSkip: a.expectedSkip,
    deferred: a.deferred,
    unavailable: a.unavailable,
    failed: a.failed,
    skipReasons: a.skipReasons,
    blockers: Array.isArray(a.blockers) ? a.blockers : undefined,
    highWatermark: a.highWatermark ?? null,
    businessMetrics: a.businessMetrics,
  };
}
