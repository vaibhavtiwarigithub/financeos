# Edge Calibration Readiness Monitor

**Status:** Approved
**Owner:** Kairos
**Decision date:** 2026-07-21
**Scope:** Deterministic, measure-only US and India evidence governance

## 1. Problem

Weekly EdgeIC runs collect immutable factor evidence, but Kairos does not currently
answer three operational questions reliably:

1. How many independent weekly windows have accumulated for each factor, market,
   and horizon?
2. Has collection stalled or degraded?
3. When is the evidence sufficient to build the next validation phase or request a
   shadow review?

Relying on a human to remember to check in six to eight weeks is fragile. Treating a
single `shadow_eligible` IC row as readiness is worse: it ignores stability,
point-in-time quality, costs, turnover, and multiple testing.

## 2. Decision

Build a deterministic readiness monitor over the existing append-only
`edge_ic_history` ledger. It publishes progress to the Edge dashboard and emits a
one-time informational notice when a factor crosses a governance milestone.

It has no LLM and no authority over scoring, signals, mandates, positions, cash,
proposals, brokers, or orders.

## 3. Milestones

### 3.1 `collecting`

Fewer than six independent market-wide windows exist. Windows use the latest
snapshot for each `window_end` and must be at least five calendar days apart, so
manual reruns and provider corrections do not inflate progress.

### 3.2 `needs_stability`

Six windows exist, but the bounded historical diagnostic does not satisfy every
Kairos policy gate:

- minimum observation count of 72 in every selected window;
- positive IC in at least five of six windows;
- median IC at least 0.02; and
- median Newey-West t-statistic at least 1.5.

These thresholds are conservative Kairos governance policy, not a claim of universal
statistical truth. They may be versioned later; old results remain immutable.

### 3.3 `ready_for_validation_build`

The historical stability gates pass, but fewer than four independent rows carry the
future evidence quality `pit_walk_forward_cost_adjusted_fdr` with non-null turnover
and net-of-fee IC. This milestone means only: build or run the point-in-time,
walk-forward, cost-adjusted, multiple-testing-controlled validation layer.

### 3.4 `ready_for_shadow_review`

At least four independent validation windows exist and all of these gates pass:

- evidence quality is exactly `pit_walk_forward_cost_adjusted_fdr`;
- net-of-fee IC is positive in at least three of four windows;
- median net-of-fee IC is at least 0.01; and
- turnover is finite and non-negative in every validation window.

This remains a review milestone. It never changes an Edge lifecycle state and never
grants production, paper, or live trading permission.

## 4. Data Model

`edge_readiness_status` is a latest-state projection keyed by
`(edge_id, market, horizon)`:

- stage and policy version;
- observed/required windows and positive-window count;
- median IC/t-stat, minimum observations, latest window/session;
- validation-window counts and median net-of-fee IC;
- deterministic gate details;
- separate first-notified timestamps for each readiness milestone; and
- evaluation timestamp.

The immutable source remains `edge_ic_history`. The projection may be updated because
it is not an evidence ledger. RLS is enabled and access is service-role only, matching
`edge_market_status`.

## 5. Scheduling And Alerts

A provider-free daily cron runs after the Monday EdgeIC time slot. It:

1. reads only market/all rows;
2. collapses same-window provider revisions to the latest snapshot;
3. evaluates every factor/market/horizon independently;
4. upserts the latest projection;
5. emits at most one batched informational notice per market/milestone/run for newly
   qualifying factor-horizons;
6. emits a warning when a market has no successful IC snapshot for more than ten
   days; and
7. resolves the stall warning after recovery.

Daily evaluation is deliberately cheap and idempotent: it reads only Supabase rows
and makes no market-data request. This lets a missing weekly IC run become visible on
day 11 rather than waiting for another weekly monitor invocation.

One-time readiness notices use separate milestone timestamps in the projection.
Dismissing a notice does not cause it to reopen every week, and a regression from a
later milestone cannot re-notify an earlier one. A later policy/formula version gets
a new identity and can notify independently.

## 6. Dashboard

The Edge page shows:

- market and horizon;
- stage;
- weekly-window progress;
- positive-window count;
- median IC and minimum sample;
- validation-window progress; and
- the next required action.

No visible status may use the phrase “trade ready.” Empty or failed reads render as
unavailable, never as zero evidence or ready.

## 7. Safety And Failure Modes

- US and India are never combined.
- Sector rows are diagnostic and never satisfy market readiness.
- Same-window reruns cannot increase the weekly-window count.
- Legacy/unverified rows may count only as retrospective diagnostics, never as
  validation windows.
- Null/NaN metrics fail their gate.
- A route or DB failure reports a monitor warning but cannot affect EdgeIC itself.
- Readiness alerts are informational; stalled collection is warning severity.
- No provider calls are made by the monitor.

## 8. Acceptance Criteria

- Pure evaluator tests cover deduplication, weekly spacing, thin samples, unstable
  signs, historical readiness, validation readiness, market isolation, and nulls.
- Route source contains no score, signal, mandate, position, cash, proposal, broker,
  or order write.
- One-time notification state survives alert dismissal.
- Dashboard exposes truthful progress and the next gate.
- Cron, migration, RLS, TypeScript, tests, production build, and live smoke pass.
