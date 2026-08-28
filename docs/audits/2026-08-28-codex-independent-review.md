# Codex independent review — 2026-08-17 through 2026-08-28

**Role:** Reviewer
**Scope:** Re-derive the claims in `2026-08-28-codex-review-brief.md` from current
source and production data. No strategy, sizing, exit, schema, or execution
change was made.

## Bottom line

The operational repair to `execute_paper_exit` is deployed and passed an
independent rollback test. The Alpha Diagnostic Lab is safely read-only, but its
current outputs are not reliable enough to diagnose selection, sizing, or exit
quality. Four defects can materially reverse or invalidate the headline:

1. A2 measures all scored observations, not eligible-long candidates.
2. A6 does not replay a valid equal-size portfolio or the opening book state.
3. A8 tests a pooled, duplicated statistic different from A2 and permutes across
   dates.
4. same-day reruns can return stale results because production `code_version` is
   NULL and the dataset fingerprint hashes counts/date endpoints, not the data.

Do not change weights, sizing, stops, targets, or exits from the current Lab.
Repair the measurement instrument first.

## Findings

### P1 — A2 uses the wrong cohort, and the corrected cohort reverses India

Architecture requires the earliest **eligible** observation for each
`(market, symbol, decision_date)`. The route does not select `entry_eligible` or
`direction`; it supplies every scored and matured observation to A2.

Production h10 re-derivation on 2026-08-28, with the same per-date Spearman and
minimum cross-section of five:

| market | cohort | dates | rows | mean rank IC | t-stat |
|---|---:|---:|---:|---:|---:|
| India | all scored | 22 | 351 | +0.107 | +2.24 |
| India | eligible long | 17 | 224 | **-0.005** | **-0.07** |
| US | all scored | 23 | 1,132 | -0.004 | -0.08 |
| US | eligible long | 21 | 507 | **-0.073** | **-1.46** |

The stored India A2 result (+0.105) is therefore not evidence that the entries
the system can take rank future returns. The US eligible cohort is more negative
than the stored all-scored result.

**Required repair:** select and persist the declared cohort fields, filter before
deduplication, and publish all-scored versus eligible-long as separately named
tests. Add a production-shaped fixture where those results have opposite signs.

### P1 — A6 is not a valid equal-size, finite-capital replay

The equal-size arm replaces entry quantity with `cashAllocation`, but retains
the original exit quantity. The simulator rejects an exit larger than the
resized holding; a smaller exit leaves an unintended residual. Thus entry and
exit quantities are not paired under the counterfactual.

The replay also:

- initializes cash from the first `paper_performance.nav` row (portfolio
  inception), not NAV at the first marked session;
- drops every position opened before the mark ledger began on 2026-08-17;
- consequently starts with full cash and no carried book, then calls that arm
  `actual`.

The stored nine-session returns, drawdowns, cash utilization, and equal-size
difference are not interpretable. Matching rejection counts do not validate the
replay; rejection reasons are not surfaced.

**Required repair:** seed the first-session cash and carried positions from a
reconciled opening snapshot; assign a counterfactual quantity at entry and use
that exact remaining quantity for every subsequent partial/full exit. Test
resized entry followed by partial and full exits.

### P1 — A8 does not falsify the A2 statistic

A2 computes mean per-date cross-sectional rank IC after symbol/date deduplication.
A8 instead computes one pooled Spearman over the undeduplicated rows and shuffles
outcomes globally across dates. That changes both the sample and the estimand,
and it destroys date/regime structure.

A8 also omits `horizonDays` from `sampleStatus`. At 60 dates and h10 the effective
independent count is about six, below the contract's floor of 12, but A8 could
still clear its date gate.

**Required repair:** pass the exact deduped A2 sample into A8; recompute the exact
mean daily IC statistic for every placebo; permute within date (or use a declared
date-block procedure); apply the h10 overlap/effective-observation gate. Increase
permutations enough to resolve the multiple-test-adjusted alpha.

### P1 — run identity can silently reuse stale results

Production's latest US and India Lab rows both have `code_version = NULL`.
Because `plan_fingerprint` is unique and the route returns the existing run on a
collision, multiple code revisions on the same day can reuse the first answer.

The dataset fingerprint hashes only trade/performance row counts and the first
and last performance dates. A correction to NAV, benchmark, labels, marks, P&L,
or geometry that preserves those counts/endpoints produces the same identity.

**Required repair:** require a non-null deploy/build identity (with an explicit
local source hash); hash canonical row content or immutable ledger high-water
marks for every input table; include cohort and metric versions. Never describe
a reused result as an identical dataset unless this identity matches.

### P1 — A0 passes incomplete data and is narrower than its label

A0 checks four conditions only: cash plus positions equals NAV, positive NAV,
benchmark session equality when a benchmark exists, and provenance when a
benchmark exists. It does not require benchmark coverage. Production US passed
A0 with one of 22 clean performance rows missing `bench_nav`.

It also excludes already-tainted NAV rows before the check (17 US and two India)
and reports coverage as 100% for any non-empty clean input. It does not perform
the fill/P&L/cash, mark uniqueness/freshness, lot/position, currency, or return
recomputations specified by the architecture.

**Required repair:** rename this narrow check or implement the declared ledger
invariants. Report clean/tainted/missing coverage separately and make benchmark
coverage an explicit invariant. Downstream tests should name exactly which A0
invariants gated them.

### P2 — A9 measures trailed, current stops as if they were entry geometry

The route reads mutable `paper_positions.stop_loss`; PositionMonitor raises that
field as a trailing stop. A9 then discards non-positive stop distances, which
would exclude positions trailed to or above cost. It does not read
`initial_stop_loss`.

Production comparison:

| market | lots | current stop | initial stop | target | current R:R | initial R:R |
|---|---:|---:|---:|---:|---:|---:|
| India | 14 | 3.82% | 5.01% | 14.52% | 6.12 | 2.98 |
| US | 9 | 5.12% | 6.87% | 7.50% | 1.37 | 1.09 |

The cross-market divergence is real even on initial levels, but the published
magnitude and “entry vintage” label are wrong. Publish initial geometry and
current/trailing geometry as separate measures, with complete coverage.

### P2 — the Lab overstates independent dates and implements no path analysis

A3/A4/A5/A7 assign `nDates = lots.length`. In production, India reports 98
“independent dates” from 24 distinct learning-cohort entry dates; US reports 48
from 14. The UI repeats the false “independent dates” label.

The route also hardcodes every closed lot's MFE and MAE to NULL. A3 capture and
giveback are therefore unavailable, and A4 classifies every lot as
`neither_touched` while reporting 100% resolvable coverage. This is absence of
path data, not evidence that barriers were untouched.

**Required repair:** carry entry/exit dates in the lot contract, define the
independence unit per test, join the matched `observation_labels`, and make NULL
MFE/MAE `unavailable` rather than `neither_touched`.

### P2 — the UI hides the main selection result and renders missing values as zero

There is no A2 metrics branch in `TestMetrics`, so the Lab's selection IC and
spread are absent from the dashboard. A1 renders NULL stage returns as 0%, and
A3 renders a missing win rate as zero. The display can therefore turn missing
evidence into neutral/bad evidence while showing invalid lot counts as
independent dates.

**Required repair:** render A2, show em-dash/“unavailable” for NULL, and label the
actual sampling unit. Dimmed output should remain readable as diagnostic data
but must not look like a measured zero.

## Claims independently confirmed

- `execute_paper_exit(uuid,numeric,text,numeric,numeric)` is deployed as
  `SECURITY DEFINER` with EXECUTE granted to `service_role` only (not `anon` or
  `authenticated`).
- A production transaction tested full exit capture (`stop=93`, `target=120`)
  and a repeated-partial case where the new residual stop (`118`) must override
  the old lot stop (`90`). The deliberate exception rolled the statement back;
  zero `ZZCX_%` trade or position rows remained.
- Every closed lot has `fill_price`; legacy `entry_price` NULLs did not erase
  entry prices. Historical stop/target values remain absent, as documented.
- The quote dispute deletion from `priceMap` is before the real exit loop and an
  unpriced symbol skips all exits. Coverage is conditional: Yahoo-primary US
  marks have no same-run independent cross and remain explicitly
  uncorroborated.
- Rotation remains disabled for execution: both markets and both paper/live
  books have `rotation_paper_execute_enabled=false`,
  `rotation_live_proposals_enabled=false`, and
  `rotation_allow_score_only_paper=false`; shadow measurement is enabled.
- The covariance cross-term in `constructor.ts` is algebraically correct. The
  production config fields are NULL and defaults apply. There were zero
  `vol_budget` adjustments among 1,520 constructor events in the last 60 days.
  The stronger claim that the cap is universally unreachable is not established:
  existing-book vol falls back to 2%, while candidate vol can be measured and
  exceed it. Persist input-vol provenance and estimated portfolio vol before
  changing this money-path threshold.

## Recommended order

1. Freeze interpretation of A2/A6/A8 and remove any recommendation derived from
   them.
2. Architect one measurement-integrity repair covering cohort identity, opening
   portfolio state, quantity pairing, exact-statistic placebo, fingerprints,
   and truthful sample units.
3. Add adversarial fixtures that reproduce each failure above, then re-run both
   markets from production ledgers.
4. Only after the corrected tests mature: diagnose selection first, then payoff
   paths, then sizing. Do not tune all three from the same immature window.
5. Keep the exit RPC fix and dispute-gate placement. Add coverage telemetry for
   corroborated versus uncorroborated exit prices.

## Verification performed

- Current source and relevant commits inspected across the full requested arc.
- Production SQL re-derived A2 cohorts, A9 initial/current geometry, sample-unit
  counts, A0 missing coverage, run identity, rotation flags, constructor events,
  function ACL, and historical entry/stop/target completeness.
- 117 focused analytics/mark/position-monitor contract tests passed.
- `npx tsc --noEmit` is not clean: the existing
  `tests/settle-check.test.ts:69` uses a regex flag unavailable under the current
  TypeScript target. No source changes were made for that unrelated failure.
