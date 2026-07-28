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

---

# Annex A — Open Decisions #1 and #5: options with arithmetic (2026-07-28)

Prepared for owner decision. Nothing here is approved or implemented.

## Measured inputs (production, not assumed)

Effective IC standard deviation backed out of Kairos's own rows, using
`sigma = mean_ic * sqrt(as_of_dates) / t_stat` on the latest window of each
market-wide edge/horizon:

| Market | Horizon | Universe | As-of dates | Implied sigma_IC | Mean abs IC | Best abs IC |
|---|---|---|---|---|---|---|
| US | 5 | 40 | 96 | 0.318 | 0.0192 | 0.0403 |
| US | 10 | 40 | 96 | 0.364 | 0.0279 | 0.0625 |
| US | 20 | 40 | 96 | 0.438 | 0.0308 | 0.0612 |
| India | 5 | 39 | 120 | 0.222 | 0.0133 | 0.0325 |
| India | 10 | 39 | 120 | 0.264 | 0.0127 | 0.0461 |
| India | 20 | 39 | 120 | 0.307 | 0.0203 | 0.0561 |

The theoretical cross-sectional rank-IC standard deviation for `n` names is
approximately `1/sqrt(n-3)`; at n=40 that is **0.164**. US h20 shows **0.438**,
an inflation of ~2.7x. With `step_days = 5` against a 20-day horizon each label
overlaps four as-of dates, and `sqrt(4) = 2` accounts for most of it. The
inflation is overlap, not mystery.

## Decision #1 — sample floors

Required as-of dates for a target IC at hurdle T:

```
N = ( T * sigma_IC / IC_target )^2
```

Two independent levers, and they are not equally priced.

**Lever 1 — remove label overlap** (`step_days >= horizon`). sigma falls 0.438 ->
~0.164, cutting N by ~7.1x. But available dates/year falls from ~50 to ~12.5,
costing 4x. **Net gain only ~1.8x.**

**Lever 2 — enlarge the universe.** sigma ~ `1/sqrt(n-3)`, and N scales with
sigma², so N falls *linearly* in n. This costs **no calendar time at all**.

| n | sigma_IC | vs n=40 |
|---|---|---|
| 40 | 0.164 | 1.0x |
| 100 | 0.101 | 2.6x fewer dates |
| 200 | 0.071 | 5.3x fewer dates |
| 400 | 0.050 | 10.7x fewer dates |

Years of history required, non-overlapping (step=horizon=20, ~12.5 dates/year),
at T=2.0:

| True IC | n=40 | n=100 | n=200 | n=400 |
|---|---|---|---|---|
| 0.03 | 9.6 yrs | 3.6 yrs | 1.8 yrs | 0.9 yrs |
| 0.05 | 3.4 yrs | 1.3 yrs | 0.7 yrs | 0.3 yrs |
| 0.06 (best observed) | 2.4 yrs | 0.9 yrs | 0.5 yrs | 0.2 yrs |

At T=3.0 (Harvey/Liu/Zhu for newly proposed factors) multiply every cell by
2.25.

**The conclusion is blunt: at n=40 nothing in the current registry is provable
this decade. Universe size is the dominant lever and it is free.**

### Options

| Option | Floors | Consequence |
|---|---|---|
| **1A Keep n≈40** | any | Rejected. Even IC=0.06 needs 2.4 yrs at T=2.0 and 5.4 yrs at T=3.0. Weak edges are permanently unprovable. |
| **1B n>=100, 12 dates/fold, 3 folds** | 36 dates, ~2.9 yrs | Detects IC>=0.05 at T=2.0. Marginal at T=3.0. |
| **1C n>=200 US / n>=100 India, 12 dates/fold, 3 folds (RECOMMENDED)** | 36 dates, ~2.9 yrs | Detects IC>=0.035 at T=2.0 and IC>=0.05 at T=3.0. Reachable with existing free data. |
| **1D n>=400, 8 dates/fold, 3 folds** | 24 dates, ~1.9 yrs | Strongest, but 400 liquid US names stretches "liquid" and multiplies fetch cost. |

Recommended floors under 1C: `min_symbols_per_as_of_date` 200 US / 100 India;
`min_as_of_dates_per_fold` 12; `min_folds` 3; `step_days = horizon`; declared IC
floor **0.04**, replacing the current 0.02 — which the table shows is below the
detection limit at any realistic sample.

**Verify before adopting:** the system map records Yahoo at "251 bars" while
`edge_ic_history.history_days` is 1000. 1C needs ~3 years of daily candles for
200 US names. If the 251-bar cap is real, deeper history must be sourced first
and 1C is blocked until then.

## Decision #5 — point-in-time universe

The current list is a hand-picked, current-liquid snapshot
(`lib/edges/universe.ts` says so in its own header). Replaying today's survivors
through past dates is survivorship bias, and it cannot be fixed by waiting.

| Option | Survivorship fixed? | Cost | Notes |
|---|---|---|---|
| **5A Massive PIT tickers (RECOMMENDED, US)** | Yes | MCP already connected; plan limits unverified | `GET /v3/reference/tickers` takes `date` (membership as of that date) and `active=false` (delisted names). `/vX/reference/tickers/{id}/events` covers renames. This is a real PIT source already wired in. |
| **5B Reconstructed liquidity screen** | **No** | Free | Rank by trailing dollar volume using only data <= as-of date, take top N. Removes *selection* hindsight but NOT delisting survivorship — the dead names are absent from the symbol list to begin with. **Only sound layered on top of 5A.** |
| **5C Freeze-forward (run in parallel)** | Yes, by construction | Free, already running | `edge_universe_members` has snapshotted since 2026-07-09 (805 rows, 9 dates). Validate only on data at/after the first snapshot. Zero bias, but ~19 days of history today, so first promotable evidence is years away. |
| **5D Index-membership history** | Yes | Free-ish for NIFTY via NSE archives; S&P harder | Manual/scraped, ongoing maintenance. Fallback for India if 5A lacks NSE coverage. |

Recommended: **5A + 5B for US** (PIT membership, then a PIT liquidity rank
within it), **5D for India** if Massive's NSE coverage is thin, and **5C running
in parallel indefinitely** as the unimpeachable ground truth that eventually
supersedes the reconstruction. Any disagreement between 5C and 5A/5B once they
overlap is a bug in the reconstruction and must fail closed.

**Verify before adopting 5A:** Massive plan limits for `/v3/reference/tickers`
with `active=false`, and whether NSE/India is covered at all. Both are unknown.

## What these two decisions do NOT settle

Even at 1C + 5A, the binding constraint stays the t-hurdle. Best current
latest-window t is 1.73 (US) / 1.04 (India). A larger universe and clean PIT
data change the *precision* of the estimate, not its *sign* — they make a real
edge provable and a fake edge refutable. Neither manufactures an edge that is
not there.

---

# Annex B — Verification of the two unknowns (2026-07-28)

Both open questions from Annex A were tested against the live providers. One
blocker is real, one dissolved, and a third problem surfaced that Annex A missed.

## B1. Candle depth — RESOLVED, and the fix already exists

**Massive (Polygon-backed) has a hard 2-year lookback wall on the current plan.**

- `/v2/aggs/ticker/AAPL/range/1/day/2022-07-01/2026-07-27` with `limit=5000`
  returned exactly **500 bars, 2024-07-29 → 2026-07-27**.
- Requesting only the older window `2022-07-01 → 2023-07-01` returned
  **HTTP 403 `NOT_AUTHORIZED` — "Your plan doesn't include this data timeframe."**

This matters because `resolveCandles()` routes **US** through Massive first
(`lib/edges/data.ts`), so US IC history is capped at ~2 years. Net of a 252-day
feature lookback (12-1 momentum), that leaves only ~12 usable non-overlapping
20-day as-of dates. 1C would have been unbuildable on US.

**However — Yahoo's auth-free chart endpoint serves 5 years for BOTH markets,
free, and Kairos already has the code.** Measured:

| Symbol | range=5y | range=3y |
|---|---|---|
| AAPL | 1254 bars, from 2021-07-28 | 751 bars, from 2023-07-28 |
| RELIANCE.NS | 1239 bars, from 2021-07-27 | 742 bars, from 2023-07-27 |

`fetchIndiaCandles(symbol, range)` in `lib/india-data.ts` is a **generic Yahoo
chart fetcher**. It is India-only by naming accident, not by capability — it
takes any symbol and any range, and `indiaRange()` already maps >900d → `3y` and
>1400d → `5y`. The 251-bar figure in the system map is simply the 1y default.

**Proposed (NOT approved, step 4 scope):** rename it to `fetchYahooCandles` and
use it as the DEEP-HISTORY source for both markets in the validation path, while
Massive stays primary for recent/live US data. No new provider, no new key, no
cost.

Recomputed 1C feasibility with 5 years (~1254 sessions, minus a 252-day feature
lookback, non-overlapping at h20 → ~50 as-of dates):

| n | Detectable IC at T=2.0 | at T=3.0 |
|---|---|---|
| 100 | 0.029 | 0.043 |
| 200 | 0.020 | 0.030 |

**1C becomes fully buildable: 3 folds x 16 dates, comfortably above the 12/fold
floor, with the proposed 0.04 IC floor safely above the detection limit.**

## B2. Massive PIT coverage — CONFIRMED for US, ABSENT for India

**US: works.** `GET /v3/reference/tickers` with `date=2023-06-30` and
`active=false` returned genuine delisted names with `delisted_utc` timestamps
(e.g. Altaba, delisted 2019-10-07; Advanced Accelerator Applications, 2018-02-12).
This is a real point-in-time membership source with survivorship intact, already
connected, no new vendor.

**India: not covered.** Searching `RELIANCE` returned only US-listed and OTC
instruments — Reliance Global Group (NASDAQ), Reliance Inc (NYSE), and OTC GDRs.
No NSE listings. Massive is US-equities-only for this purpose.

## B3. Consequence Annex A did not anticipate

The two markets have **opposite** gaps:

| | PIT universe source | Deep candle history |
|---|---|---|
| US | 5A Massive — **yes** | Massive capped at 2y; **Yahoo 5y fixes it** |
| India | Massive — **no**, needs 5D | Yahoo — **yes, 5y** |

Neither market has both from one provider. The recommended pairing is therefore
**asymmetric by necessity**, not by preference:

- **US:** 5A (Massive PIT tickers) for membership + Yahoo 5y for candles + 5B
  liquidity rank within the PIT set.
- **India:** 5D (NSE index-membership archives) for membership + Yahoo 5y for
  candles. Until 5D exists, India has **no** PIT universe and therefore cannot
  produce promotion-grade evidence at all — it stays diagnostic-only.
- **Both:** 5C freeze-forward continues in parallel as ground truth.

This means US reaches promotable evidence materially before India. That is an
honest consequence of the data available, not a choice — and it should be
recorded rather than papered over by letting India promote on a survivorship-
biased universe.

## Revised recommendation

Adopt **1C + 5A/5B (US) + 5D (India, blocked until built)**, with the Yahoo
deep-history change as a prerequisite for both. Do not relax the fold floors to
accommodate the 2-year Massive wall — the wall is removable for free, and
lowering statistical floors to fit a provider limit would be exactly the kind of
accommodation this whole feature exists to prevent.

## B4. Why the brokers (Robinhood / Webull / Kite) do not solve either problem

Asked during review: can the broker APIs supply what is missing?

**For #5 (PIT universe) — structurally impossible, not a plan limitation.**
A broker API lists instruments you can trade *today*. That is the literal
definition of a survivorship-biased universe. Robinhood has no reason to serve
a name that delisted in 2019, and does not. `active=false` on the Massive
reference endpoint exists precisely because a *market-data* vendor has an
incentive to retain dead tickers, while a *broker* has none. No broker
integration can fix survivorship bias, regardless of entitlement or plan.

**For #1 (candle depth) — possible in principle, unnecessary in practice, and
poorly shaped for it.**
- Broker historicals are entitled and rate-limited for a personal account, not
  for a 200-symbol nightly backfill across 5 years.
- Robinhood MCP requires an interactive OAuth session; the token is not
  available to unattended validation jobs on the same terms as an open HTTP
  endpoint.
- Webull's data tools are recorded in this repo as requiring
  `category:US_STOCK`, returning quarterly fractions, being cron-entitled, and
  the adapter is currently dead.
- Kite is India-only and account-scoped.
- Yahoo already supplies 5 years for both markets, free, keyless, with existing
  code (B1). Adding a broker dependency to solve a solved problem would trade a
  keyless endpoint for an entitled, rate-limited, auth-bound one.

**Conclusion:** the brokers stay what they are — execution and live account
state. They are not a research-data source, and routing validation evidence
through them would couple the evidence layer to trading entitlements. The
existing separation is correct and should not be relaxed.

---

# Annex C — Correction to Annex B, and the step-4 scope boundary (2026-07-28)

## C1. Annex B overstated the Massive dependency — corrected

Annex B said "`resolveCandles()` routes US through Massive first, so US IC
history is capped at ~2 years." That is true **only of the edge/IC path**. It is
not true of US candles generally, and the difference matters.

There are two separate US candle resolvers:

| Resolver | Used by | US order | Depth |
|---|---|---|---|
| `resolveCandles()` in `lib/edges/data.ts` | edge lab / IC | Massive → EODHD → TwelveData | **capped at 2y by the Massive plan** |
| `fetchUsCandles()` in `lib/data/candles.ts` | main research path | **Yahoo first**, then Massive → EODHD → TwelveData → AV | governed by the range passed |

So the main US path was already Yahoo-first. Only the edge/IC path — the one
this feature depends on — goes to Massive first and hits the 2-year wall. The
Annex B conclusion for step 4 stands; the general claim about "US candles" did
not, and is withdrawn.

## C2. A second under-service, same class as the yahooRange defect

`fetchUsCandles()` calls `fetchYahooCandles(symbol)` with **no range argument**,
so it takes the `"6mo"` default — roughly 125 sessions. `minCandles` defaults to
60, so that passes the acceptance check and the shallow series is used.

125 sessions is below the 273 needed for 12-1 momentum (252 + 21), the same
failure mode as the `indiaRange` defect fixed in `5d48bd0e`, on the US side and
in the live research path rather than the measure-only edge lab.

**Not fixed here.** Changing the depth of the main US research path changes
`analyst_score` inputs and therefore what gets traded. It needs its own
architecture decision, and it is not part of this feature. Recorded so it is not
rediscovered a third time.

Related: the `YAHOO` node in `system-map.json` claimed "251 adjusted bars",
which does not match the `"6mo"` default in the code. Node corrected.

## C3. Step 4 is NOT unblocked by the 1C + 5A/5B approval alone

Owner approved **1C** (sample floors) and **5A/5B** (PIT universe source) on
2026-07-28. Those answer Open Decisions **#1** and **#5**.

Three remain open, and the approved scope line at the top of this document says
steps 4-10 are blocked on **all five**:

| # | Decision | Blocks |
|---|---|---|
| 2 | Expanding-window calibration vs externally fixed formula | Fold construction — whether a fold has a train segment at all, and therefore whether the mode is `walk_forward` or `purged_temporal_oos` |
| 3 | False-discovery procedure for correlated edge families | Aggregate pass criteria (step 8) |
| 4 | Required cost-adjusted portfolio test and benchmark | Final promotion criteria (step 9) |

**#2 genuinely blocks step 4.** Whether folds carry a training segment
determines the fold boundary layout, the purge rule, and which `validation_mode`
value the schema will accept — all of which step 4 must fix before any universe
snapshot is keyed to a plan.

**#3 and #4 do not block step 4.** They gate steps 8-9. Step 4 could proceed
once #2 is answered.

Recommendation: answer #2 before step 4 starts; #3 and #4 can be decided while
steps 4-7 are built.
