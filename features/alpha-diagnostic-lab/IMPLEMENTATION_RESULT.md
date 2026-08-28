# Alpha Diagnostic Lab — implementation result

> Status: **P0 SHIPPED**, running weekly, verified in production.
> Date: 2026-08-28. Influence: `none` — no money path reads this feature.

## What shipped

| piece | state |
|---|---|
| `backtest_experiments.experiment_type += 'alpha_diagnostic'` | applied + verified |
| `lib/analytics/alpha-diagnostic-contract.ts` | statuses, cohorts, dual evidence floors, canonical serialization, fingerprints, verdict |
| `lib/analytics/alpha-diagnostics.ts` | A0 data truth, A1 funnel, A3 payoff |
| `lib/analytics/alpha-diagnostics-selection.ts` | A2 selection |
| `lib/analytics/alpha-diagnostics-counterfactual.ts` | A4 exit paths, A5 sizing, A7 cost, A8 robustness |
| `lib/analytics/alpha-diagnostics-portfolio.ts` | A6 portfolio/cash calendar, A9 risk geometry |
| `app/api/analytics/alpha-diagnostics/route.ts` | owner/cron GET + POST |
| `components/dashboard/AlphaDiagnosticLab.tsx` | mounted in `PerformanceTruth`, shares its market toggle |
| pg_cron `kairos-alpha-diagnostics-us` (127) / `-india` (128) | `10 4 * * 0` / `20 4 * * 0` |

87 tests. 12 guards mutation-verified.

## First production results (2026-08-28)

Both markets: `A0 pass`, verdict **`collect_more`** — correct, since nothing has
cleared the 60-date review floor.

| test | us | india |
|---|---|---|
| A2 rank IC (h10) | **-0.012** (t -0.22, 17 dates) | **+0.105** (t 2.24, 22 dates) |
| A2 mean quintile spread | **-0.006** | +0.010 |
| A3 percent profit factor | 0.969 | **1.438** |
| A3 currency profit factor | 0.735 | **0.906** |
| A3 sizing damage suspected | no | **YES** |

**India picks winners and the position sizing destroys them** — percentage
profit factor 1.44 against a currency profit factor of 0.91. The US book has a
different problem: the selection itself does not rank (IC ≈ 0, and the quintile
spread is NEGATIVE, so acting on the ranking lost money). Two distinct failures,
which is exactly why A3 reports both profit factors and A2 reports IC beside
spread.

India's A2 rank IC of +0.105 independently reproduces the +0.106 measured by
hand on 2026-08-25 through a different code path and cohort.

## Defects this feature found in existing production data

1. **India 2026-07-09 and 07-10**: `cash + positions` is ~15% short of recorded
   NAV (-150034.07, -145171.47) with `tainted=false`. Found by A0 on its first
   run. Values left AS RECORDED and the rows labelled `tainted` with an
   `A0_nav_reconciliation` reason — kept in accounting, removed from learning.
2. **Volatility-budget sizing has never fired**: zero reductions across 1,513
   constructor events in 60 days. The mechanism exists and has not once changed
   a trade.
3. **US/India risk geometry diverges and nothing in policy explains it** (A9):
   india R:R 6.12 (stop 3.82% / target 14.52%) vs us 1.37 (5.75% / 7.50%), both
   entirely August vintage. Two candidate explanations were tested against
   production and BOTH rejected — mandate vintage drift, and the n>=60
   learned-percentile unlock. Recorded as UNEXPLAINED rather than guessed a
   third time.

## Defects found in this feature by running it

Each was invisible to typecheck, build and unit tests:

1. `backtest_experiments` requires NOT NULL `hypothesis`, `author`,
   `variant_budget`; `author` is constrained to `'llm' | 'human'`.
2. **Fingerprint shape**: the registry constrains every fingerprint column to
   `^[0-9a-f]{64}$`. The digest was 16 hex and was rejected at INSERT. Now eight
   FNV-1a passes; a test asserts all eight chunks differ.
3. **`Number(null) === 0`** — `num()` coerced a NULL `bench_nav` to a real zero,
   so A0 treated the 2026-06-28 SUNDAY inception row (no session, no benchmark)
   as a row that had a benchmark and failed it for missing provenance. This is
   the same trap already documented in `constructor-outcome.ts` and reintroduced
   in a different file hours later.
4. **A0 re-failed rows already labelled `tainted`**, pinning India at
   `data_invalid` permanently and making the taint label meaningless. A0 now
   excludes them and reports the excluded count.
5. **`resolveVerdict` counted a passing A0 toward `owner_review`**, so the first
   successful run reported "escalate to owner" when the only passing test was
   "the ledger reconciles". Only A2/A6/A8 may promote now.
6. `SimulatedPosition.costBasis` is PER SHARE, not total outlay; the unpriced-mark
   fallback divided it by quantity and valued a 50-share position at 10.
7. The permutation p-value used `b/m`, which returns exactly 0 on a perfect
   signal and clears every trial-adjusted alpha. Now `(b+1)/(m+1)`.

## Deliberate refusals

- A1 emits `insufficient_evidence`: the funnel projection is not persisted, and
  an explicit refusal beats a fabricated funnel.
- A4 marks a lot `ambiguous` when MFE cleared the target AND MAE breached the
  stop — daily data cannot order two barriers touched in the same window.
- A7 reports a null surviving fraction on a negative gross edge.
- A6 reports a null excess rather than inventing one when the benchmark is absent.
- A9 records the US/India divergence as unexplained.

## Not done

- **UI render is unverified.** The dashboard needs an authenticated session that
  could not be created here. The component compiles, is mounted, and the API it
  reads is confirmed working, but it has not been seen to paint.
- A6 and A8 are implemented and tested but not yet wired into the route's run
  plan; A6 needs a persisted event calendar and A8 needs a declared candidate.
- A2's by-setup / by-regime / by-instrument-family breakdowns.
- Purged walk-forward folds and the regime holdout inside A8.

## Architecture corrections made before building

Four claims in the approved doc were re-verified against production; two were
wrong. The doc was corrected in place before implementation:

- "the live +20% target sits far beyond the observed h10 p75 MFE" — **inverted**.
  Live `target_pct` is 8 in BOTH markets; against p75 MFE of ~7.75% / ~8.93% it
  is well calibrated.
- India 1M excess "~-1.76pp" — **-0.68pp** on the corrected benchmark series.
- US 1M excess "~-0.53pp" — -0.67pp; window now pinned.
- `lib/simulation/portfolio-simulator.ts` was UNTRACKED, so A6 was not
  reproducible from the repository. Committed as a precondition.
