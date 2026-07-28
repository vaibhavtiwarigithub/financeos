# Feature Architecture: Purged Out-of-Sample IC Validation

## Status

Architecture status: Approved
Architecture approved: Yes
Approved scope: Build-order steps 2 and 3 ONLY - disable legacy-window promotion,
  repair policy/experiment schema semantics, and add the atomic promotion RPC.
Approved date: 2026-07-28
Implementation allowed: Steps 2-3 only. Steps 4-10 remain BLOCKED on the five
  Open Decisions For Approval at the end of this document (sample floors from a
  power analysis, calibration mode, false-discovery procedure, cost-adjusted
  portfolio test, and the PIT-universe/corporate-action policy per market).
  Nothing may claim out-of-sample evidence until those are answered and 4-10 ship.

## Implementation Status (2026-07-28)

Steps 2 and 3 are SHIPPED. Migration
`20260728090000_promotion_schema_repair_and_atomic_rpc.sql`, applied and verified
against production while `strategy_policies` and `backtest_experiments` were both
empty:

| Repair | State |
|---|---|
| `dsr` renamed `t_margin_vs_trials` (it was never a Deflated Sharpe Ratio) | done |
| `walk_forward_pass` renamed `ic_stability_pass` | done |
| `validation_mode` NOT NULL, CHECK in (`purged_temporal_oos`,`walk_forward`) | done - a legacy rolling-window result has no representable value, so it cannot be promoted |
| `experiment_id` NOT NULL FK to `backtest_experiments` | done |
| Mutation trigger compares whole rows minus `superseded_at` | done - the hand-listed column set left 7 fields silently mutable |
| `superseded_at` and experiment `policy_id` are write-once | done |
| `promote_strategy_policy()` RPC, SECURITY DEFINER, service-role only | done |
| Promote route calls the RPC instead of supersede-then-insert | done |
| `experiment_id` required; `variants_run` must be recorded | done - the old fallback chain substituted a flattering trial count when the run count was missing |

P0 proven in production 2026-07-28: inside one transaction, two promotions
produced `baseline` then `variant` with exactly one active row; a third
promotion was then forced to fail at insert AFTER its supersede, and the
incumbent survived unchanged. The whole block was rolled back, leaving both
tables at zero rows.

Promotion remains DORMANT at the route (`promotion_evidence_not_oos`, 503).
Steps 2-3 fixed how a policy would be written. They did nothing about whether
the evidence deserves to be written, which is steps 4-10.

## Decision

Build this before any `strategy_policies` promotion is allowed.

The current `edge_ic_history` rows are useful retrospective diagnostics, but
they are not promotion evidence. Splitting the same retrospective current-name
dataset into date ranges would not repair point-in-time universe bias,
experiment-selection bias, or the absence of a frozen train/test protocol.

Until this feature and the atomic promotion RPC are approved and shipped,
`POST /api/agents/backtest/promote` must remain operationally dormant. A later
approved implementation should make the route fail closed with
`promotion_evidence_not_oos` rather than treating three rolling windows as an
evidence minimum.

## Purpose

Create reproducible, market-local, point-in-time out-of-sample evidence for an
edge before it can become a policy. The system must answer:

1. What formula and trial family were fixed before evaluation?
2. What symbols and inputs were knowable on each as-of date?
3. Which observations trained or calibrated the formula?
4. Which later observations tested it without label overlap?
5. Does the combined out-of-sample evidence survive dependence, costs, and
   multiple testing?
6. Can promotion append a replacement policy atomically?

## Measured Current State

As of 2026-07-27:

| Fact | Production value |
|---|---|
| Rolling history per IC row | 1,000 calendar days |
| US rows per edge/horizon vs distinct end dates | 6 vs 4 |
| Span from first to last US end date | 16 calendar days |
| Approximate overlap | 98.4% |
| Best latest US market-wide t-stat | 1.73 |
| Best latest India observation | 1.57, Financials sector, only 2 windows |
| Active `strategy_policies` | 0 |
| `backtest_experiments` | 0 |
| Promotion-grade PIT universe | unavailable |
| Regime rows allowed by `edge_ic_history` schema | no |

The current universe is documented in migration 132 and the EdgeIC response as
a current-liquid snapshot. Replaying today's survivors through old dates is not
point-in-time validation.

## Corrections To The Previous Draft

1. **Disjoint test slices are not automatically walk-forward.** For a fixed,
   never-refit formula they are purged temporal out-of-sample folds. The term
   walk-forward is reserved for a protocol that freezes each fold's formula or
   parameters using only its earlier training/calibration interval and then
   evaluates a later test interval.
2. **Purge is measured in market sessions, not calendar days.** For horizon
   `H`, no test origin may have a forward-return label extending beyond its test
   interval. Training observations whose labels touch the test interval are
   purged; an embargo is added only when the feature construction requires it.
3. **A boolean `is_disjoint` is not proof.** Boundaries, label end dates,
   fingerprints, and non-overlap validation are durable facts. The gate
   recomputes their consistency.
4. **Fold index is not a global identity.** It is unique only inside a frozen
   experiment/validation plan.
5. **Current-universe history cannot promote.** Point-in-time membership,
   delistings, symbol changes, corporate-action adjustment policy, and input
   availability are required.
6. **Fold-over-fold endpoint decay is not the primary statistic.** The primary
   evidence is the predeclared aggregate out-of-sample date-level rank-IC series
   with a dependence-robust uncertainty estimate. Fold sign consistency and a
   worst-fold guard are secondary diagnostics.
7. **The current `t - expectedMaxT` value is not the Bailey/Lopez de Prado
   Deflated Sharpe Ratio.** It is a trial-count-adjusted t margin. DSR also
   accounts for sample length and non-normality of strategy returns. IC
   discovery should use a declared multiple-testing procedure; DSR belongs on
   cost-adjusted strategy-return evidence.

## Statistical Contract

### Unit of observation

- Primary series: one cross-sectional rank IC per eligible market session/as-of
  date.
- The same-market cross section must meet a predeclared minimum symbol count.
- US and India observations, calendars, universes, currencies, benchmarks, and
  results are never pooled.
- Sector evidence is a separate plan and must meet stricter sample floors.
- Regime evidence is unavailable until a separate approved, PIT-safe regime
  label exists. It must not silently fall back to market-wide evidence.

### Frozen plan

Before any result is computed, an immutable experiment records:

- `edge_id` and exact `formula_version`
- market, horizon, and exactly one segment dimension
- trial-family identifier and total challengers considered since the current
  champion was promoted
- point-in-time universe policy/version and snapshot fingerprint
- feature/input availability policy and adjustment policy
- train/test boundaries expressed as market sessions
- step size, purge sessions, optional embargo sessions, fold count
- minimum as-of dates and minimum cross-section size
- primary statistic, secondary diagnostics, and pass thresholds
- data cutoff and code/config fingerprint

Changing any field creates a new experiment. It never edits a completed one.

### Fold construction

For fold `k`:

1. Build or calibrate only from sessions at or before `train_end[k]`.
2. Purge training origins whose `H`-session labels overlap the test interval.
3. Freeze the selected formula/parameters.
4. Evaluate consecutive later sessions from `test_start[k]` through
   `test_end[k]`.
5. Require every label to mature by `label_end[k] <= data_cutoff`.
6. Append immutable date-level IC observations and one fold summary.

Test intervals do not overlap. Their label intervals do not cross fold
boundaries. Folds are generated from an anchored plan, never from the cron's
wall-clock execution date.

If there is no training or calibration step because the formula was fixed
externally before all folds, label the mode `purged_temporal_oos`, not
`walk_forward`.

### Aggregation and pass criteria

The gate consumes all matured OOS date-level IC observations for one frozen
plan:

- minimum 3 completed test folds
- minimum 24 eligible as-of dates per fold, subject to power analysis before
  approval
- minimum cross-section size per as-of date; sparse dates are excluded and
  counted, never converted to zero IC
- aggregate mean rank IC above the approved floor
- Newey-West/HAC t-stat on the concatenated chronological OOS IC series above
  the approved hurdle
- positive fold sign in a predeclared majority and no catastrophic worst fold
- multiple-testing control against the complete frozen trial family
- cost-adjusted long-only bucket test and benchmark comparison before policy
  promotion
- no unresolved PIT, provider, adjustment, or provenance degradation

No single latest fold, maximum fold t-stat, or pooled standard error from
overlapping windows may decide promotion.

For factor discovery, use a predeclared false-discovery method appropriate to
the trial dependence. Do not label the current expected-max-t subtraction as
DSR. If DSR is later used, compute it from the strategy-return series with the
paper's sample-length, skewness, kurtosis, and trial-selection inputs.

## Data Architecture

### Reuse the existing lineage

Do not create a third experiment/provenance truth layer.

Extend `backtest_experiments` to be the immutable plan header with:

- `edge_id`, `formula_version`, `horizon`
- `validation_mode`
- `trial_family_id`, `trials_considered`
- `universe_policy_version`, `universe_fingerprint`
- `dataset_fingerprint`, `code_version`
- `validation_spec` JSONB with a schema/version CHECK
- `data_cutoff`

The plan references existing `edge_signal_inputs`, `edge_universe_members`, and
evidence/provider fingerprints. It does not copy or reinterpret their
provenance.

### New result tables

`edge_ic_fold_results`:

- `experiment_id`, `fold_index`
- train, purge, test, and label-end session boundaries
- formula and dataset fingerprints
- `as_of_dates`, `min_cross_section_n`, `excluded_dates`
- mean IC, IC IR, HAC t-stat, confidence interval
- status and machine-readable refusal reasons
- unique `(experiment_id, fold_index)`
- service-role only, append-only

`edge_ic_oos_observations`:

- `experiment_id`, `fold_index`, `as_of_date`
- rank IC, cross-section count, input/universe fingerprint
- unique `(experiment_id, as_of_date)`
- service-role only, append-only

`edge_ic_history` remains the retrospective diagnostic ledger. Do not add
`is_disjoint` to it and then treat the same current-universe reconstruction as
promotion-grade.

### Strategy-policy schema repair

The promotion migration must:

1. add the correctly named `ic_stability_pass` and explicit
   `validation_mode`; deprecate `walk_forward_pass`
2. stop describing the trial-adjusted t margin as `dsr`
3. harden the mutation trigger so every field except a one-way
   `superseded_at: null -> timestamp` transition is immutable
4. bind each policy to its exact experiment and fold result set
5. make experiment `policy_id` a one-way null-to-value transition

Production currently has zero policy rows, so this is the lowest-risk time to
repair the schema semantics.

## Atomic Promotion Boundary

Supersede and insert must occur in one database transaction. A partial unique
index prevents two active rows but cannot prevent zero active rows after
supersede succeeds and insert fails.

Add a service-role-only database RPC modeled on
`promote_strategy_champion`:

1. validate the experiment, segment, formula, market, horizon, trial family,
   matured folds, and gate result inside the transaction
2. acquire a transaction advisory lock for the exact policy segment
3. lock the incumbent row
4. append the new policy
5. supersede the incumbent
6. bind the experiment to the new policy
7. return both IDs

Revoke execution from `public`, `anon`, and `authenticated`; grant only the
service role. The HTTP route remains cron-or-confirmed-owner gated and calls
only this RPC.

## Module Inventory

| Module | Approved future change |
|---|---|
| `lib/edges/ic.ts` | Pure fold evaluator over frozen observations |
| `lib/edges/validation-plan.ts` | Session-aware plan validation and fingerprints |
| `app/api/agents/edge-ic/route.ts` | Keep retrospective diagnostics; do not overload it |
| new validation route/worker | Execute approved frozen plans and append OOS results |
| `lib/gates/promotion-gate.ts` | Consume aggregate OOS result, not rolling windows |
| `app/api/agents/backtest/promote/route.ts` | Validate request, require bound experiment, call atomic RPC |
| `supabase/migrations/*` | Extend lineage, add immutable results, repair policy semantics, add RPC |
| `docs/arch/04-database-schema.md` | Canonical schema and immutability contract |
| `docs/arch/09-learning-loop.md` | Discovery -> OOS validation -> promotion sequence |
| `public/agent-diagrams/system-map.json` | Remove all current walk-forward/DSR overclaims |

## Failure Modes And Required Refusals

| Failure | Required outcome |
|---|---|
| Current-day universe replayed historically | refuse `universe_not_point_in_time` |
| Feature observed/revised after as-of date | refuse `input_not_point_in_time` |
| Formula/config changed after plan creation | refuse `plan_fingerprint_mismatch` |
| Label crosses test boundary or is immature | refuse `label_overlap_or_immature` |
| Fold/test range overlaps another result | refuse `test_fold_overlap` |
| Too few dates or symbols | refuse `sample_floor_not_met` |
| Experiment segment differs from request | refuse `experiment_scope_mismatch` |
| Trial count absent or lower than family ledger | refuse `trial_family_incomplete` |
| Any India/US mixing | refuse `market_scope_mismatch` |
| Promotion insert/bind fails | transaction rolls back; incumbent remains active |

## Validation Plan

### Pure tests

- US and India session calendars, including holidays
- horizon-label purge at every fold boundary
- no overlap in test origins or label intervals
- immature labels rejected
- exact rerun idempotency
- changed formula/universe/config creates a different plan
- sparse fold rejection
- aggregate HAC statistic uses chronological OOS observations
- no max-t or latest-fold cherry-pick
- malformed/mismatched trial family fails closed

### Database tests

- anon/authenticated cannot read or mutate plan/results
- result rows cannot update/delete
- experiment and policy bindings are one-way
- concurrent promotion leaves exactly one active policy
- forced insert failure preserves the incumbent
- null/value segment branches match the unique-index key exactly

### Acceptance

1. A synthetic known-positive factor passes only under clean PIT OOS data.
2. The same factor fails when its universe or labels are contaminated.
3. A known-null factor does not pass under repeated trial families.
4. No policy can be created from legacy `edge_ic_history` alone.
5. Full typecheck, tests, build, schema verification, RLS checks, and production
   dry-run pass before activation.

## Build Order

1. Approve this architecture and thresholds/power analysis.
2. Disable legacy-window promotion explicitly while the policy table is empty.
3. Repair policy/experiment schema semantics and add the atomic RPC.
4. Establish PIT universe and input eligibility for US and India separately.
5. Extend the existing experiment lineage and add immutable OOS results.
6. Build the session-aware fold engine and synthetic leakage tests.
7. Backfill diagnostics only; never relabel legacy rows as OOS.
8. Run paper-only validation plans and review at least one complete trial family.
9. Wire the promotion route to the atomic RPC.
10. Consider policy consumption only under a separate approved architecture.

## Open Decisions For Approval

1. Minimum dates and symbols per fold, determined by power analysis rather than
   an arbitrary `fold_days`.
2. Expanding-window calibration versus externally fixed formula mode.
3. False-discovery procedure for correlated edge families.
4. Required cost-adjusted portfolio test and benchmark.
5. PIT-universe source and delisting/corporate-action policy for each market.

## References

- Bailey and Lopez de Prado, *The Deflated Sharpe Ratio: Correcting for
  Selection Bias, Backtest Overfitting and Non-Normality*:
  https://ssrn.com/abstract=2460551
- Bailey, Borwein, Lopez de Prado, and Zhu, *The Probability of Backtest
  Overfitting*: https://ssrn.com/abstract=2326253
- Harvey, Liu, and Zhu, *... and the Cross-Section of Expected Returns*:
  https://www.nber.org/papers/w20592

These sources support multiple-testing and backtest-overfitting controls. The
specific Kairos schema, market isolation, PIT requirements, and fail-closed
design above are architectural decisions derived from the current code and
production schema.
