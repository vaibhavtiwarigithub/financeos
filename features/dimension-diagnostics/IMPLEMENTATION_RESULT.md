# Dimension Diagnostics P0 Implementation Result

> Shipped: 2026-08-06
>
> Scope: P0 measurement and visibility only. P1 candidate creation, P2 sealed
> replay, P3 forward shadow, and P4 promotion remain blocked by their separate
> evidence and governance gates.

## Delivered

- `dimension_diagnostic_runs` and `dimension_diagnostic_findings`: append-only,
  RLS-enabled, service-only diagnostic index tables.
- `/api/agents/dimension-diagnostics?market=us|india`: owner-readable and
  cron-callable deterministic runner/read model.
- Weekday post-label pg_crons: `kairos-dimension-diagnostics-us` at 23:20 UTC
  and `kairos-dimension-diagnostics-india` at 23:25 UTC.
- Market-local availability and descriptive session-level rank-IC findings for
  every existing score dimension and horizon (2/5/10/20 sessions).
- Agent contribution records plus an explicit
  `unattributable_no_paired_shadow` collaboration result.
- Upgrade Path registration and Learning page summary. Both surfaces are
  read-only and make no provider or LLM call.

## Hard boundaries verified in implementation

- Reads only `decision_observations`, `observation_labels`, and signal labels.
- Does not import ResearchAgent scoring, PaperTrader, PositionMonitor, strategy
  mutation, proposal, broker, or provider modules.
- Results below 20 qualifying daily cross-sections of at least five names are
  marked `insufficient_evidence`; no repair candidate is created.
- US and India are separate route invocations, separate rows, separate cron jobs,
  and separate UI queries.
- Collaboration is deliberately not assigned credit from shared workflow output.
  It remains unattributable unless a future paired market-local shadow exists.
- The initial `dimension_diagnostics_p0_v1` rows remain immutable. The active
  `dimension_diagnostics_p0_v2` plan records agent contribution by agent label
  plus the decision's code version, so a deployment cannot silently blend an
  agent's historical behavior across versions.

## Verification

- Focused Vitest: dimension diagnostics and shadow-registry contracts.
- TypeScript check.
- Production migration: RLS enabled with no browser policy/grant, append-only
  triggers present, and both pg_cron jobs active.

## Not shipped

No score/weight/threshold change, agent reward/punishment, agent configuration
mutation, candidate creation, replay, shadow strategy, promotion, paper/live
trade, exit, sizing, provider call, LLM call, or broker action.
