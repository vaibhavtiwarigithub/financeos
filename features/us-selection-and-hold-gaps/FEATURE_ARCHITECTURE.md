# Decision-Intent and Holding-Exit Integrity

> Status: **APPROVED FOR INTEGRITY BUILD; SCORE POLICY REMAINS MEASURE-ONLY.**
> Last revised: 2026-09-11.
> Live auto-trading remains disabled. No score weight, eligibility threshold,
> stop, target, sizing rule, or broker order is changed by this feature.

## Problem

The observation ledger mixed two decisions: an **entry candidate** considered
for a new position and a **holding review** produced because the symbol was
already owned. `entry_eligible=true AND direction='long'` cannot distinguish
them. Most US h10 rows in the disputed selection analysis were holding re-scores,
so it answered a hold/exit question and was described incorrectly as selection.
Consecutive h10 windows were also treated as independent, inflating t-statistics.

The same ambiguity reached execution: paper and live monitors loaded the latest
deterministic symbol score without proving it was a session-validated holding
review from the current position episode. A candidate score must never become
exit authority.

## Architecture

### 1. Immutable decision intent

`decision_observations.decision_context` records `entry_candidate` or
`holding_review` at write time. Historical rows remain NULL. Legacy readers may
use a small explicit `discovery_source` mapping; unknown sources fail closed.

All entry analytics use the shared `isEntryCandidateLong` predicate. Holding
analytics use `isHoldingReview`. The low-level score/direction predicate remains
only where intent is irrelevant.

### 2. Exit authority and persistence

Both paper and live monitors require:

1. `agent_signals.is_holding=true`;
2. `session_validated=true` and `score_source=deterministic_v1`;
3. signal timestamp at or after the position opened; and
4. normal freshness checks.

Loss of score conviction is not an immediate sale. The first qualifying holding
session arms the exit; only a strictly newer holding session below threshold
confirms it. Recovery disarms it. Stop and target protection remain independent.
The existing `direction_flip_armed_session` name is retained for compatibility,
but stores the broader conviction-exit persistence state.

### 3. Score-exit shadow

The daily `score-exit-shadow` route evaluates three predeclared holding-score
thresholds: entry threshold, entry threshold minus 10, and minus 20. It uses only
matured labels linked to session-validated holding signals. Results are immutable,
market-local, fingerprinted, and visible in Upgrade Path.

Each arm reports trigger count, clean trigger count, unresolved competing exits,
paired incremental return versus holding, avoided-loss share, foregone-gain
share, and worst paired outcome. A row whose MFE/MAE touches stop or target is
unresolved because excursions cannot establish event order.

Overlapping windows use `effective observations = distinct sessions / horizon
days`. Below 12 effective observations the status is `insufficient_evidence`;
no naïve significance claim or promotion is allowed.

### 4. Closed-lot high-water invariant

The exit RPC patch is retained, but a `BEFORE UPDATE OF closed_at` trigger also
enforces the invariant at the table boundary. Full, partial, and residual closes
are covered by a transaction-rolled-back SQL verification. Historical NULLs are
not reconstructed.

## Data contracts

- `20260911193121_decision_observation_intent.sql` adds nullable constrained
  `decision_context` without rewriting history.
- `20260911194022_enforce_closed_trade_high_water.sql` adds the high-water trigger.
- `20260911194147_score_exit_shadow_runs.sql` adds an append-only owner-readable
  evidence ledger and both-market weekday schedules.
- No money-path module may read `score_exit_shadow_runs`.

## Acceptance gates

- Candidate signals cannot arm or confirm a paper or live exit.
- A holding score needs two distinct fresh sessions to confirm an exit.
- Entry diagnostics use decision intent; unknown legacy sources fail closed.
- Full, partial, and residual closed lots retain verified high-water.
- Score-exit evidence appears daily in Upgrade Path but cannot affect trading.
- Any future policy change requires 12 effective observations, competing-risk
  and cost review, execution-faithful replay, and explicit owner approval.

## Superseded claims

The earlier `t=-5.42`, “US selector picks the worst names,” and related causal
claims are withdrawn. They used a mostly holding-review population and naïve
independence across overlapping windows. That population is relevant to exits,
so it is now measured by the dedicated shadow rather than reused as entry evidence.
