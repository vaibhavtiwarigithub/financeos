# Alpha Diagnostic Lab

> **2026-08-28 v2 amendment:** P0 implementation defects found by the independent
> review are governed by
> `MEASUREMENT_INTEGRITY_REPAIR_ARCHITECTURE.md`. That approved amendment
> supersedes conflicting cohort, replay, robustness, fingerprint, sample-unit,
> path-availability, and UI details below. The read-only safety boundary remains
> unchanged.

> Status: **APPROVED 2026-08-27 — IMPLEMENTATION IN PROGRESS**
>
> Reviewed and corrected before build: four factual claims re-verified against
> production, one found inverted (target_pct), one dependency found untracked.
> See section 2 and the preconditions in section 13.
>
> Architect: Codex / GPT-5, explicitly authorized by Vaibhav on 2026-08-27
>
> Influence: read-only diagnostics only. No score, eligibility, sizing, exit,
> paper/live portfolio, strategy promotion, proposal, order, or broker path may
> consume this feature.

## 1. Decision

Kairos will build one owner-only, market-local Alpha Diagnostic Lab that explains
portfolio underperformance as a reproducible funnel:

`data truth -> candidate opportunity -> entry selection -> fill conversion -> sizing -> exit path -> cash/redeployment -> costs -> net benchmark-relative return`.

The owner approved three defaults:

1. The primary objective is **net excess return against the governed primary
   benchmark, subject to a drawdown non-inferiority constraint**. Absolute return,
   win rate, and "win big / lose small" are supporting diagnostics, not the
   promotion objective.
2. Portfolio counterfactuals redeploy cash released by an exit into the next
   eligible candidate under deterministic same-session ordering: exits first,
   then entries ranked by the frozen candidate policy, then lexical symbol/id as
   the final tie-breaker.
3. Accounting truth includes every real paper trade, including tainted rows.
   Learning and policy comparisons use a separate clean cohort that excludes
   tainted or `excluded_from_learning` rows. Both cohorts are displayed together;
   neither may silently substitute for the other.

## 2. Why this feature exists

The paper portfolios do not consistently beat their governed primary benchmarks,
but a single headline alpha number cannot identify the cause. The same visible
gap can come from:

- incorrect NAV or benchmark alignment;
- a candidate universe with no benchmark-relative opportunity;
- a useful candidate pool but poor ranking or downstream selection;
- good selected names damaged by size allocation;
- winners surrendered or losers held by the exit path;
- uninvested cash in a rising benchmark;
- costs, stale prices, capacity limits, or failed fills;
- one market or regime being pooled with another; or
- a retrospective result selected from too many trials.

Existing production evidence makes diagnosis urgent but does not license a money-
path change.

**Motivating figures re-verified 2026-08-27 after the benchmark-provenance fixes
landed the same day.** Two of the numbers this section originally carried were
computed on a contaminated series and are corrected here; the correction does not
weaken the case for the Lab, it demonstrates why the Lab must gate every
conclusion on A0 data truth.

| claim | as drafted | re-verified | note |
|---|---|---|---|
| US 1M excess | ~-0.53 pp | **-0.67 pp** | window boundary; restate with the window pinned |
| India 1M excess | ~-1.76 pp | **-0.68 pp** | drafted on the Yahoo-contaminated NIFTY series; recomputed on settled Upstox closes |
| clean profit factor < 1 both markets | asserted | **confirmed** — US 0.735, India 0.906 | currency profit factor, clean cohort |
| live target vs h10 p75 MFE | "+20% target sits far beyond" | **STALE — live target is 8%** | `trading_mandates.target_pct = 8` for BOTH markets since 2026-08-03; the code fallback also read 20 until it was corrected 2026-08-27 |

The target premise is not merely stale, it is **inverted**: against an h10 p75 MFE
of ~7.75% (US) and ~8.93% (India), an 8% target is well calibrated, not far
beyond reach. A3/A4 must therefore test whether the target is reached and given
back, NOT assume it is unreachable. Any residual "+20%" evidence in older
artifacts describes a policy that is no longer live.

Since-inception, on settled benchmark data: India **+0.60 pp** ahead of NIFTY 50,
US **-0.74 pp** behind VOO (both from 2026-07-06, 38-39 sessions). India is not
uniformly behind, which is itself a reason to diagnose per market rather than
pool.

These are hypotheses about where the damage occurs, not permission to tune the
policy to this sample.

## 3. User and product value

**User:** the single owner/operator of Kairos.

**Pain:** the app reports whether the portfolio is ahead or behind, but it does
not give one reproducible answer to *why*, nor show which proposed repair survives
capital constraints, redeployment, costs, and benchmark-relative evaluation.

**Expected value:** shorten the loop from "portfolio lagged" to a falsifiable,
market-local diagnosis; prevent random score/stop/target changes; and focus future
build effort on the stage that actually destroys alpha.

## 4. Scope

### In scope

- Paper books only in the first release.
- US/USD and India/INR as fully separate runs.
- Governed primary benchmark only for pass/fail: VOO for US, NIFTY 50 for India.
- Secondary benchmarks as display-only context.
- Persisted production ledgers as the data source; no provider call from a
  diagnostic run.
- Accounting and clean-learning cohorts.
- Data-truth, alpha-funnel, selection, payoff-path, sizing, portfolio/cash,
  execution-cost, and robustness tests.
- Immutable experiment identity, dataset/run fingerprints, and trial accounting.
- Owner-triggered runs plus scheduled read-only refreshes.
- A compact Portfolio performance surface with drill-down into the test results.

### Out of scope

- Any automatic strategy, weight, threshold, stop, target, horizon, sizing, or
  universe change.
- Live portfolio evaluation or live-order behavior in P0.
- LLM-authored numeric conclusions or policy parameters.
- Intraday fills inferred from daily candles when event ordering is unknowable.
- Pooling USD and INR, or borrowing evidence from one market to configure another.
- Benchmark shopping: a display comparator cannot become the governed objective.
- New market-data providers or npm packages.
- Automatic promotion. A diagnostic verdict may only recommend continued
  collection, rejection, or submission for owner review.

## 5. Existing components to reuse

| Need | Existing authority |
|---|---|
| Portfolio/benchmark scorecards | `benchmark_scorecard`, `lib/analytics/benchmark-alpha.ts` |
| NAV, expectancy, drawdown, costs | `paper_performance`, `paper_trades`, `lib/analytics/performance-metrics.ts` |
| Candidate decisions and PIT features | `decision_observations` |
| Forward, benchmark-neutral, MAE/MFE labels | `observation_labels` |
| Dimension and agent diagnostics | `dimension_diagnostic_runs/findings`, `lib/learning/dimension-diagnostics.ts` |
| Exit counterfactual outcomes | `observation_labels.atr_exit_outcomes`, `lib/learning/atr-exit-evidence.ts` |
| Horizon extension evidence | `horizon_extension_shadow` |
| Frozen replay boundary | `lib/replay/sealed-accessor.ts`, `lib/replay/cursor.ts` |
| Portfolio accounting simulation | `lib/simulation/portfolio-simulator.ts` |
| Immutable experiment lineage | `backtest_experiments` |

The Lab must call or compose these authorities. It must not reimplement a second
version of benchmark alignment, label math, technical scoring, or paper accounting.

## 6. Objective and cohort contracts

### 6.1 Primary objective

For a fixed market, calendar window, starting capital, and primary benchmark:

`net_excess_return = portfolio_total_return_after_costs - benchmark_total_return`

A candidate is directionally better only when paired net excess return is
positive against the incumbent on the same sessions. It is not promotion-eligible
unless maximum drawdown is non-inferior within a predeclared tolerance and all
coverage/robustness gates pass.

Information ratio, daily excess hit rate, turnover, cash utilization, and tail
loss are reported. They do not replace the primary paired comparison.

### 6.2 Accounting cohort

Includes every real closed paper lot and every portfolio/NAV effect, including
tainted or excluded rows. It answers: "What happened to the book?"

### 6.3 Learning cohort

Requires all of:

- `tainted = false`;
- `excluded_from_learning = false`;
- valid market-local fill and exit prices;
- known code/mandate lineage where the test depends on it;
- sufficient benchmark and label provenance for the requested metric.

It answers: "What evidence may be used to compare policies?" Excluded counts and
reasons are mandatory output fields.

## 7. Repeatable diagnostic suite

Every finding carries `market`, `test_id`, `cohort`, `window`, `n_rows`,
`n_dates`, `n_symbols`, coverage, metric version, and a deterministic status of
`pass | fail | insufficient_evidence | data_invalid | descriptive_only`.

### A0 — Data truth and reconciliation

Before any performance conclusion, assert:

- market NAV equals cash plus one mark per open quantity within rounding tolerance;
- fills, realized P&L, lot quantity, and portfolio cash reconcile;
- benchmark close belongs to the same exchange session as the portfolio point;
- portfolio and benchmark returns recompute from their stored levels;
- missing/stale/tainted marks are counted and visible;
- exit rows retain required provenance and no cross-market currency is mixed.

Any failed invariant sets the whole run to `data_invalid`. Downstream values may
be shown for debugging but cannot receive a pass/fail interpretation.

### A1 — Alpha funnel

Per decision session, count and compare:

`scored -> entry_eligible -> selected/claimed -> filled -> closed`.

For each stage, calculate equal-weight benchmark-neutral return at h5/h10/h20,
coverage, and the deterministic reason for attrition. Required comparisons:

- all scored candidates;
- all eligible-long candidates;
- selected candidates;
- actual fills;
- eligible but capacity/cash/name-cap rejected candidates.

This test locates whether alpha is absent at discovery, lost in ranking, or lost
between eligibility and execution.

### A2 — Entry selection and calibration

Use one observation per `(market, symbol, decision_date)`, earliest eligible row
of the day. Report:

- date-clustered rank IC by horizon;
- top-minus-bottom quintile benchmark-neutral spread;
- monotonicity across frozen score bands;
- excess-return hit rate;
- analyst-score calibration and sample per bin;
- results by setup, regime, instrument family, and discovery source only when
  the cohort floor is met.

Frozen comparisons are incumbent, equal dimension weights, each dimension alone,
and leave-one-dimension-out. Each is one declared trial. No ad hoc combination is
generated after results are observed.

### A3 — Payoff path: "win big, lose small"

For matched closed trades and matured labels, report:

- win rate, average/median winner, average/median loser, payoff ratio;
- percentage-return profit factor (policy quality independent of size);
- currency-P&L profit factor (real capital outcome);
- MFE and MAE distributions;
- `realized_return / MFE` capture ratio where MFE is positive;
- `MFE - realized_return` giveback;
- share of realized losers that were previously positive;
- share of winners/losses contributed by the top/worst five trades;
- results by exit reason and holding period.

Both percentage and currency profit factors are required because a positive
average trade with a negative currency profit factor is direct evidence that
sizing damaged the book.

### A4 — Exit precedence and counterfactual paths

Replay completed daily bars with the actual entry, stop, target, score-exit,
partial-exit, time-stop, and cost conventions. Record when multiple exit
conditions were true on the same evaluation session; the incumbent's real
precedence decides the reproduced fill and a separate overlap field exposes the
classification effect.

Candidate families must be predeclared. MFE/MAE-only rows may measure reachability
but cannot infer the order of two barriers touched in the same window. Such rows
are `ambiguous`, never silently assigned a favorable fill.

### A5 — Sizing attribution

Replay the same selected trades under:

1. actual historical sizing;
2. equal notional per available slot;
3. capped volatility-normalized sizing;
4. the incumbent size rule with all other policy fields frozen.

Report return and currency P&L by entry-notional quartile, Spearman correlation
between notional and later return, concentration, marginal contribution, profit
factor, drawdown, and net excess return. The test diagnoses sizing; it does not
select a new sizing formula.

### A6 — Portfolio construction, cash, and redeployment

Extend the deterministic simulator to produce daily marked NAV, open-position
value, cash utilization, benchmark NAV, drawdown, turnover, and rejected-event
reasons. Run the same calendar under:

- actual entries/exits/sizes;
- actual selection with equal sizing;
- eligible-candidate equal weight subject to the same name cap;
- actual policy with cash released by exits redeployed into the next eligible
  candidate;
- an explicit cash sleeve so the cost of abstention is measured rather than
  assumed.

Ordering is deterministic: exits, then ranked entries, then lexical tie-breaker.
Cash cannot be spent twice and never becomes negative.

### A7 — Execution and cost stress

Evaluate the incumbent and every candidate at:

- recorded modeled costs;
- 10, 25, and 50 basis-point round-trip stress;
- next-session-open entry where supported by point-in-time bars;
- stale quote rejection;
- gap-through-stop behavior without assuming a fill better than the observable
  price convention;
- no same-session redeployment as an adverse operational case.

Report cost drag, turnover, rejected fills, and the fraction of gross alpha that
survives after cost.

### A8 — Robustness and falsification

- Sealed point-in-time inputs; any future-dated item aborts the run.
- Purged/embargoed walk-forward evaluation for overlapping labels.
- Date-block bootstrap or date-clustered inference; raw row count is never
  presented as independent sample size.
- Regime holdout and market-local evaluation.
- Label-permutation placebo: a policy must not appear similarly successful on
  shuffled outcomes.
- Trial-family accounting and a multiple-testing-adjusted review hurdle.
- Re-run identity: identical plan, dataset, and code fingerprints produce the
  same result document byte-for-byte. This requires a CANONICAL serialization —
  sorted object keys and fixed-precision numeric formatting — because JSON key
  order and float repr are otherwise free to vary between runs. Fingerprints are
  computed over the canonical form, never over `JSON.stringify` default output.

## 8. Persistence design

Do not create a parallel experiment registry. Extend the existing
`backtest_experiments.experiment_type` constraint with `alpha_diagnostic`.

Each diagnostic run inserts its immutable plan row **before loading the evaluation
dataset**. Reuse these columns:

- `market`, `data_cutoff`, `code_version`;
- `trial_family_id`, `trials_considered`, `variant_budget`, `variants`;
- `validation_mode`, `validation_spec`, `plan_fingerprint`;
- `universe_fingerprint`, `dataset_fingerprint`, `run_fingerprint`;
- `started_at`, `completed_at`, `result_summary`.

`result_summary` uses `schemaVersion: 1` and this shape:

```text
{
  status,
  objective,
  benchmark,
  accountingCohort,
  learningCohort,
  coverage,
  tests: { A0, A1, A2, A3, A4, A5, A6, A7, A8 },
  diagnosis: [{ stage, contributionPp, confidence, evidence }],
  verdict: "data_invalid" | "collect_more" | "reject_candidate" | "owner_review"
}
```

The migration must preserve existing append-only/write-once guards, service-only
grants, and RLS. It must not add a browser write policy. A failed run writes a
bounded failure result once; a retry is a new experiment with its own run id.

## 9. API and UI contracts

### API

- `GET /api/analytics/alpha-diagnostics?market=us|india`
  - owner-only;
  - returns the latest completed run and bounded history;
  - never calls a provider or mutates strategy state.
- `POST /api/analytics/alpha-diagnostics?market=us|india`
  - owner or cron;
  - inserts the immutable plan, runs A0 first, then remaining tests only if data
    truth passes;
  - returns run id, coverage, diagnosis, and influence=`none`.

### UI

Add `AlphaDiagnosticLab` inside the existing Portfolio performance surface below
`PerformanceTruth`; do not add a new main-navigation destination.

The compact view shows, separately for US and India:

- primary benchmark excess over 1W/1M/3M/120-session windows with confidence;
- accounting versus learning-cohort trade counts;
- payoff ratio and both profit factors;
- MFE capture/giveback;
- sizing contribution, cash contribution, exit contribution, and cost drag;
- the first failing funnel stage;
- `insufficient evidence` rather than a directional verdict when floors fail.

Drill-down shows the nine test cards, their exact sample dimensions, run/data/code
fingerprints, exclusions, and candidate trial count.

## 10. Cadence

- **Daily after canonical marks and labels settle:** A0 data truth and compact
  accounting refresh.
- **Weekly after dimension diagnostics:** A1-A7 descriptive attribution, skipped
  when the dataset fingerprint is unchanged.
- **Monthly or when a predeclared evidence floor is crossed:** A8 robustness and
  candidate reviewability.

The scheduler records expected idle windows in shadow-liveness. A missing run is
an observability issue; it never triggers a policy fallback or automatic change.

## 11. Evidence and promotion gates

Descriptive findings may appear with smaller samples, always carrying `n_dates`.
A candidate cannot become `owner_review` unless all hold:

- at least 60 qualifying decision dates and the applicable existing effective-
  observation floor;
- positive paired net excess return versus incumbent on the same sessions;
- drawdown non-inferiority under the predeclared tolerance;
- no material turnover/cost regression;
- survival under cost stress and the label-permutation placebo;
- multiple-testing adjustment for every configuration tried;
- separate US or India result; no pooled promotion;
- prospective forward-shadow confirmation;
- explicit owner approval through the existing governed promotion path.

The Lab itself cannot promote. Its strongest output is `owner_review`.

## 12. Failure and edge cases

- Missing benchmark session, stale mark, or NAV mismatch -> entire run
  `data_invalid`.
- Too few independent dates -> `insufficient_evidence`, never zero or neutral.
- No eligible candidates -> valid funnel result, but no selection conclusion.
- No matched MAE/MFE -> payoff totals remain visible; path metrics unavailable.
- Duplicate symbol/date decisions -> earliest eligible decision only for
  cross-sectional tests; duplicates remain in the accounting audit.
- Partial exits -> simulate quantity and residual state; do not count residual
  lots as independent entries.
- Same-day exit and entry -> exit first, cash released once.
- Open positions at cutoff -> mark to the cutoff; never fabricate an exit.
- Candidate requiring unavailable data -> abstain with reason.
- Existing tainted history -> included in accounting, excluded from learning.
- Secondary benchmark selected in UI -> display changes only; diagnostic
  objective remains the governed primary.

## 13. Files expected in implementation

### Create

- `lib/analytics/alpha-diagnostics.ts`
- `lib/analytics/alpha-diagnostics.test.ts`
- `lib/analytics/alpha-diagnostic-contract.ts`
- `app/api/analytics/alpha-diagnostics/route.ts`
- `components/dashboard/AlphaDiagnosticLab.tsx`
- one Supabase migration generated through the approved migration workflow to
  admit `alpha_diagnostic` experiment lineage
- `features/alpha-diagnostic-lab/IMPLEMENTATION_RESULT.md` after verification

### Modify

- `lib/simulation/portfolio-simulator.ts` and tests: daily marks/NAV, benchmark,
  cash-utilization, drawdown, and run fingerprint output
  - **PRECONDITION: this file is currently UNTRACKED in git** (along with
    `features/portfolio-simulation/`). An implementation that modifies it is not
    reproducible from the repository until it is committed. Commit it, or treat
    A6 as blocked, before build sequence step 2.
- `components/dashboard/PerformanceTruth.tsx`: mount the compact Lab
- `lib/schedule.ts` and cron migration only after the owner approves scheduling
- `app/api/admin/shadow-liveness/route.ts`: expected weekly diagnostic liveness
- `docs/arch/04-database-schema.md`
- `docs/arch/05-crons-and-scheduling.md`
- `docs/arch/09-learning-loop.md`
- `public/agent-diagrams/system-map.json` only if the scheduled diagnostic is
  represented as a system flow

No new package is approved or expected.

## 14. Validation plan

### Pure/unit tests

- exact alpha-funnel counts and deterministic attrition reasons;
- percentage versus currency profit-factor divergence;
- MFE capture, giveback, and prior-positive loser calculations;
- duplicated symbol/date deduplication;
- sizing quartile and equal-size counterfactual;
- same-session exit-before-entry redeployment;
- no double-spend, negative cash, or cross-currency simulation;
- cost-stress monotonicity;
- future-dated input throws;
- deterministic fingerprints and byte-identical reruns;
- insufficient/date-clustered status rules.

### Integration tests

- owner/cron authorization and browser write denial;
- plan row exists before evaluation reads begin;
- A0 failure prevents interpreted downstream findings;
- result summary is write-once and retry creates a new run;
- US query cannot read India rows and vice versa;
- accounting count includes tainted trades while learning count excludes them;
- no import or call path reaches a provider, scorer, PaperTrader, PositionMonitor,
  strategy promotion, proposal, order, or broker module.

### Production verification

- run one owner-triggered US and one India diagnostic;
- independently recompute one metric from SQL and match the stored result;
- verify service-only grants, RLS, write-once trigger, and migration history;
- load the Portfolio page, switch markets, inspect network/console, and confirm
  no cross-market result race;
- rerun an identical frozen plan and prove the same run fingerprint and result;
- run the full test suite, production-equivalent typecheck/build, architecture
  drift checks, migration replay, and secret scan before shipping.

## 15. Acceptance criteria

1. One screen identifies the measured contribution of data, selection, sizing,
   exits, cash/redeployment, and costs to market-local benchmark lag.
2. Every conclusion shows independent dates, symbols, exclusions, confidence,
   and the immutable experiment/run identity.
3. Accounting truth and learning evidence are visibly separate and reconcile to
   their respective source ledgers.
4. The simulator models calendar capital and redeployment; no per-trade excess
   comparison is used to rank different holding periods.
5. A target/stop change cannot be recommended solely because it is the best cell
   in a retrospective grid.
6. US and India cannot share capital, benchmark, thresholds, evidence, or verdict.
7. A diagnostic run has no write path to any money-path table or configuration.
8. The strongest automated verdict is `owner_review`; activation remains outside
   this feature.

## 16. Build sequence after approval

1. Pure diagnostic contracts and A0-A3 fixtures.
2. Extend the portfolio simulator and implement A4-A7.
3. Add A8 robustness, immutable plan/result persistence, and migration tests.
4. Add owner/cron API and production read-only dry run.
5. Add the Portfolio UI and browser verification.
6. Add weekly scheduling only after an unscheduled production run is proven.
7. Complete ship guardrails and implementation record.
