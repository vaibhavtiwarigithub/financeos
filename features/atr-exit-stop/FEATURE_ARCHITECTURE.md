# ATR-scaled exit stop — shadow arm

> Status: **Producer deployed; first post-deploy run/evidence pending.** Production has two paired US snapshots (seed 2026-09-25, latest 2026-09-28) and no attribution row yet; the producer requires 20 complete market sessions (two non-overlapping 10-session blocks). The last pre-deploy collector was blocked because the 2026-09-29 bar was unavailable. PR #29 is merged to `main`, deployment `dpl_AKQ3oM9QEHVAtMztLiLHBpFXVius` is READY, and the attribution-basis migration is applied.
> The old header saying “no code written” was stale. This remains measure-only; no stop,
> target, score, sizing, paper/live behavior, or strategy promotion is authorized here.
>
> Evidence: `docs/audits/2026-09-01-exit-geometry-diagnosis.md` (frozen).

## Implementation truth (2026-09-27)

`app/api/agents/exit-stop-shadow` supports persisted market-local POST runs and
writes `exit_stop_shadow_runs`. Production was queried on 2026-09-27: both US
and India cron jobs are active, with weekly Sunday runs at 04:20 and 04:30 UTC;
the latest `job_run_details` show successful invocations on 2026-09-27.
Migration `20260928101500_schedule_exit_stop_shadow` records that production
cadence in repository source control; it is local and unapplied. The route
compares the current mandate stop with a 2.8-ATR
stop at the **decision/label level**, using matured MFE/MAE and the h10 forward
return when neither barrier is touched. That h10 return is an observation
endpoint, not an executable sale: the unconditional time stop was removed on
2026-09-10. MFE/MAE also cannot reveal intrabar barrier ordering. Therefore
these rows are descriptive hypothesis evidence only—not current-policy P&L,
not a portfolio replay, and not a promotion result.

A portfolio-level producer still needs to replay the current score/target/
trailing-stop exit path (with no clock exit) against the 2.8-ATR stop variant,
using identical entries/sizing, complete chronological OHLC and costs. Do not
use the old “time stop unchanged” text below as a current production contract.

**Data prerequisite repaired 2026-09-27:** production migration
`20260927212654_capture_entry_risk_levels_for_attribution` now persists the
exact initial stop and target passed to `execute_paper_fill` on each new
`paper_trades` entry lot. It intentionally does not reconstruct old NULL levels.
This is not an exit replay: daily stop/trail evolution, executable OHLC ordering,
partial-lot cashflows, and an independent portfolio-level baseline/variant
producer are still required.

**Replay timing guard added 2026-09-27 (local only):** the lot-event adapter now
retains exact entry/sale timestamps and the replay verifies that each timestamp
belongs to its declared exchange session. A same-session sale that precedes or
interleaves a same-symbol entry is rejected. If a same-session external sale and
daily OHLC both touch a mechanical barrier, the replay refuses the date because
daily bars cannot establish intraday event order. These are correctness guards
in the isolated replay core; they do not constitute a scheduled producer or
prove any portfolio-level result.

**Corporate-action coverage prerequisite (2026-09-27, local only):** the
corporate-actions collector now validates complete Alpha Vantage split/dividend
payloads against the original `av_cache.fetched_at`, records per-symbol/per-type
coverage outcomes (including validated empty results), processes the complete
validated event list, and rotates through symbols in bounded five-symbol runs.
Malformed, stale, missing, and failed responses remain explicit blockers. The
append-only coverage-ledger migration is locally generated but unapplied; there
is no production collector run or proof of coverage for any ATR replay window.
This fixes the distinction between “no event reported” and “not fetched,” but
does not yet reconcile Yahoo replay actions to an authoritative coverage window
or produce ATR portfolio P&L.

**Seed reconciliation helper (2026-09-27, local only):**
`lib/shadows/atr-replay-seed.ts` builds a market-local initial book only when
cash plus marked positions reconcile to reported paper NAV and every aggregate
position quantity reconciles to the sum of its open `paper_trades` lots. It
requires a valid persisted high-water mark, preserves legacy NULL stops/targets,
and derives `partialTaken` from the documented `partial_exit_lot=true` residual
lot written by `execute_paper_exit`. It rejects duplicate role/symbol states the
current replay model cannot represent. This resolves one seed-state unknown,
but is still only a pure adapter: no route, scheduled forward stepping, or
portfolio attribution result exists yet.

## The one hypothesis

Everything below tests exactly one claim, declared before any arm is built:

> **H1 — Replacing the market-local mandate stop with a 2.8x ATR stop may reduce premature
> stop-outs. The mandate target is held constant. The legacy h10 label comparison is a
> screening statistic only; a current-policy portfolio replay is still required.**

Declared **directional** (ATR stop >= fixed stop) and **single**. This is deliberate: the
diagnosis came from a 14-arm grid, and the whole risk here is re-testing the grid and
calling the winner a finding.

**Not being tested, and explicitly out of scope:** changing the target, adding a clock-based
exit (the unconditional time stop has been removed), changing position sizing, or changing
eligibility.

## Why the stop and not the target

From the frozen diagnosis: the winning arm exits on target 10 times in 900 and times out
706 times — MORE than baseline's 683. Its entire advantage comes from stopping out 131
times instead of 185. Tightening the target ranked LAST in all four cohorts. The target is
not the lever.

## What the shadow arm does

`exit_stop_shadow` — measure-only, one arm, no grid.

1. For each **entry-eligible long** decision with a matured h10 label and ATR available,
   evaluate two geometries only: **baseline** (the current market mandate stop/target) and
   **candidate** (stop 2.8ATR, the same mandate target).
2. Record per decision date: resolution (stop / target / timeout / ambiguous), realized
   benchmark-neutral label return under each arm, and the paired difference. `timeout` means
   the h10 observation window ended without a barrier; it is a mark, not an executed exit.
3. Refuse the date when ATR is missing or the resolution is ambiguous under either arm.
   Ambiguity is not resolved in the candidate's favour.
4. Write to `exit_stop_shadow_runs`. Nothing reads it but the report. This table does not
   contain a portfolio-level replay.

Reuses `lib/trading/exit-geometry-shadow.ts` (`evaluateGeometry`) rather than adding a
second implementation of barrier resolution.

## Statistics, declared in advance

- **Paired test.** Both arms evaluate the SAME decisions, so the statistic is the mean
  paired difference, not two independent means.
- **Date-clustered.** One observation per decision date; symbols within a date are not
  independent draws.
- **Overlap correction.** `nEffective = nDates / horizonDays`, the existing
  `effectiveObservations` contract. At h10, 26 dates is 2.6 effective observations — far
  below `MIN_EFFECTIVE_OBSERVATIONS = 12`. **The current data cannot clear this floor.**
  That is the expected initial verdict and it is correct.
- **Multiplicity.** Although only one arm is promoted-eligible, the hypothesis was selected
  from a 14-arm grid. The family alpha is therefore Sidak-adjusted for m = 14:
  `alpha_per_test = 1 - (1 - 0.05)^(1/14) = 0.00366`. A nominal p of 0.04 does not pass.
- **Per market.** US and India are proved separately. India recorded zero target hits and
  is a different regime; a US result does not transfer.

## Promotion gates — all must hold

1. `nEffective >= 12` per market (needs ~120 distinct h10 decision dates).
2. Mean paired difference positive with Sidak-adjusted significance at 0.00366.
3. Holds at h5 as well as h10, or the h5 divergence is explained. A retrospective h5/h10
   label comparison is not forward evidence.
4. Forward shadow period with no peeking at the grid, on decisions made after the arm is
   declared, followed by a portfolio-level current-policy replay.
5. Stop-out reduction confirmed as the mechanism — if the gain appears without fewer
   stop-outs, H1 is wrong even if returns improved.

Failing any gate leaves the arm in shadow. There is no partial promotion.

## What would falsify H1

- Stop-out counts converge between arms while returns still differ (mechanism wrong).
- The US h5 loss persists or widens as data matures.
- ATR coverage falls below ~90%, making the candidate a different cohort from baseline.
- Gain concentrates in a single sector — the current US book is heavily gold, and a
  volatility-scaled stop flatters a trending sector.

## Risks worth stating

- **Selection.** H1 was chosen by looking at the grid. The forward shadow is the only real
  test; the retrospective margin should be treated as an upper bound, not an estimate.
- **A wider stop increases per-trade loss when it does fire.** Mean return can rise while
  tail loss worsens. The report must carry max adverse excursion and worst-lot loss, not
  just the mean.
- **ATR is itself estimated** and regime-dependent. A stop that widens in high volatility
  widens exactly when losses are largest.

## What this does NOT propose

- No live stop change. No target change. No time-stop change.
- No grid search. One arm, one hypothesis, one direction.
- No claim that H1 is true. The frozen evidence supports testing it, nothing more.

## Sequencing

1. The decision-level shadow, table and weekly schedules are implemented.
2. Continue weekly market-local label measurement, measure-only.
3. Revisit label evidence at `nEffective >= 12`, then require a separate forward
   portfolio replay and owner decision before any exit-policy proposal.

At the current rate of ~26 dates per 6 weeks, that is approximately **2027-Q1**. Stating
this plainly so the timeline is not a surprise: this is a slow instrument, and building it
now is worthwhile only because the data accrues whether or not anyone is watching.

## Persisted paired-book attribution producer (2026-09-30; release pending)

The scheduled ATR forward collector now reads its append-only daily paired-book
snapshots and validates the seed NAV, same-session marks, market calendar,
complete session sequence, stable policy/cost versions, cumulative matched
decision population, snapshot hashes, and NAV reconciliation before attribution.
It writes a net-only attribution row only after two complete non-overlapping
ten-session return blocks. Before that threshold, Upgrade Path reports the
exact collecting count; a missing row after the threshold is an invalid producer
state, not endless collecting.

`return_basis='net_only'` is explicit. The existing execution ledger records
fills after modeled execution costs, so this producer will not reverse-engineer
gross returns. Gross return columns are NULL. Its confidence interval and t-stat
describe non-overlapping paired block deltas; they are descriptive evidence, not
the separate effective-sample, validation-window, FDR, cost, and owner gates
needed for promotion. No scoring, stop/target, sizing, trading, or live behavior
changes. India remains blocked until a valid market-local paired-book source and
producer exist.
