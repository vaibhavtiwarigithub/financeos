# Weekend Research Catch-up and Agent Capacity

Status: APPROVED by owner on 2026-07-19 ("do it")

## Problem

The US and India research queues can contain more symbols than one weekday
ResearchAgent run can finish. Provider quotas reset on Saturday and Sunday, but
the current weekend jobs only warm evidence caches. They do not finish scoring,
write a safely reusable staged result, or reduce the Monday scoring workload.
The app also does not show queue depth, throughput, or estimated time to clear.

## Decision

Use weekend quota for full deterministic research catch-up, but make every
weekend result non-executable until the same market completes a weekday/session
revalidation. Keep paper and live trading weekday-only. Display honest backlog
and capacity telemetry for queue-backed and workload-backed agents.

## Signal State Machine

```mermaid
stateDiagram-v2
  [*] --> weekend_staged: Weekend catch-up scores symbol
  weekend_staged --> superseded: Newer weekend score replaces it
  weekend_staged --> revalidated: Weekday ResearchAgent successfully re-scores symbol
  revalidated --> [*]
  [*] --> pending: Normal session-validated research score
  pending --> paper_traded: PaperTrader fills
  pending --> expired: Trading-day freshness expires
  pending --> rank_rejected: Cross-sectional gate rejects entry
```

Every `weekend_staged` row has `session_validated=false` and an
`as_of_session` equal to the last completed market session. A normal weekday
score has `session_validated=true`. A successful weekday score marks older
staged rows for that market/symbol `revalidated`; the newly inserted `pending`
row is the only entry candidate.

## Downstream Behavior

- **PaperTrader:** positive allowlist requires `pending`,
  `deterministic_v1`, and `session_validated=true`. It never fills staged rows.
- **TraderAgent/live proposals:** same positive allowlist. It never creates a
  proposal from a staged row.
- **PositionMonitor:** mechanical price stops, targets, trailing stops, and time
  stops remain independent. Score/direction exits may only read
  `session_validated=true` signals; staged scores cannot force a sale.
- **LearnerAgent:** staged rows remain measurement evidence, but cannot become
  filled-trade outcomes. Existing observation-ledger rules remain unchanged.
- **ResearchAgent weekday run:** holdings remain first-class and cap-exempt. A
  successful re-score produces the fresh decision for that session. A failure
  leaves the staged row informational only.

## Weekend Scheduling

Add one bounded catch-up run per market on both Saturday and Sunday, after that
market's prewarm window. The route uses the existing research wall-clock budget,
provider pacing, candidate cap, per-market scope, and idempotency guard. It does
not chain PaperTrader or TraderAgent.

Weekend candidate scores are retained in `research_queue` for weekday
revalidation. Held symbols do not need queue retention because holdings are
always gathered. Repeated weekend runs supersede the prior staged row rather
than creating multiple active staged decisions.

## Data Model

Add to `agent_signals`:

- `session_validated boolean not null default true`
- `as_of_session date null`
- `staged_at timestamptz null`
- CHECK: `status='weekend_staged'` implies `session_validated=false`
- one active `weekend_staged` row per `(market,symbol)`

No order, position, portfolio, or broker schema changes.

## Agent Capacity View

The Agents dashboard gets a **Capacity** tab, scoped by the global market
switcher. Each row declares its workload type so a workload is not mislabeled as
a durable queue:

- ResearchAgent: `research_queue` depth, oldest age, staged count, recent median
  successful throughput/day, and estimated clearing days.
- PaperTrader: fresh validated pending longs; configured per-run selection cap.
- PositionMonitor: currently open paper positions; all are expected per run.
- LearnerAgent: report unavailable when a defensible queue cannot be derived;
  never fabricate a backlog.

Capacity uses the median of recent completed per-market runs where possible.
Environment caps are shown as configured ceilings, not achieved throughput.
`estimated_days = ceil(backlog / max(1, observed_daily_capacity))`; null is shown
when no defensible estimate exists.

## Failure Rules

- Missing migration makes the new positive eligibility query return no entry
  candidates (fail closed).
- Weekend scoring failure re-defers the symbol and writes the normal run error.
- Queue telemetry failure shows unavailable; it never blocks any agent.
- A staged row can never be mutated into `pending`; revalidation writes a fresh
  row, preserving point-in-time history.
- US and India remain fully separate. No queue, throughput, score, or estimate is
  cross-summed.

## Acceptance Criteria

1. Saturday/Sunday catch-up writes `weekend_staged` signals and no trade/proposal.
2. PaperTrader and TraderAgent reject staged/unvalidated signals even at score 100.
3. PositionMonitor ignores staged scores for score/direction exits.
4. Weekday success writes a new validated signal and closes prior staged state.
5. Failed weekday revalidation cannot make the staged result executable.
6. Weekend candidate remains queued for weekday revalidation without increasing
   its failed-attempt count.
7. Capacity UI is market-scoped and labels queue versus workload honestly.
8. Existing weekday research-to-paper flow remains unchanged for validated rows.

## Disable / Rollback

Unschedule the two weekend catch-up crons. Existing staged rows remain inert and
may be marked `superseded`. The additive columns can stay; their defaults preserve
the pre-feature weekday behavior.
