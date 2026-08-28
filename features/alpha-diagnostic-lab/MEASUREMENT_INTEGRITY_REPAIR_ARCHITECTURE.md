# Alpha Diagnostic Lab — measurement-integrity repair

> **Status:** Approved by owner instruction on 2026-08-28: “fix all the issues
> found including any arch build and implementation.”
>
> **Role sequence:** Codex acts as Architect for this document and then Builder
> against these acceptance criteria. This amendment supersedes conflicting P0
> implementation details in `FEATURE_ARCHITECTURE.md`; the original safety
> boundary remains authoritative.

## 1. Decision

Repair the existing owner-only Alpha Diagnostic Lab so every displayed result
uses its declared cohort, sampling unit, opening portfolio state, statistic, and
immutable input identity. Do not change any score, feature weight, eligibility
rule, position size, volatility threshold, stop, target, horizon, exit, paper or
live position, proposal, order, or broker path.

The owner pain is false diagnosis: the P0 Lab can currently reverse India’s
selection conclusion by switching from all-scored to eligible-long rows and can
compare portfolios whose entry and exit quantities do not match. A read-only
instrument that gives the wrong causal answer is not safe enough to guide later
money-path decisions.

## 2. Scope

### In scope

- A0 benchmark/accounting coverage semantics.
- A2 eligible-long cohort identity and explicit all-scored context.
- A3/A4/A5/A7 real date units and truthful MAE/MFE availability.
- A6 reconciled opening state and quantity-consistent equal-size replay.
- A8 exact A2 statistic, exact A2 rows, within-date permutation, and h10
  effective-observation gate.
- A9 initial versus current/trailing risk geometry.
- Non-null metric/deploy version and content-derived dataset fingerprints.
- UI rendering for A2, missing values, sample-unit labels, A6 rejection detail,
  and A9 initial/current geometry.
- Adversarial tests, route contract tests, production-shaped dry-run evidence,
  implementation record, work log, and Graphify refresh.

### Out of scope

- Backfilling unrecoverable historical stop/target values.
- Changing trading policy or enabling any dormant/shadow feature.
- Reclassifying already-tainted rows.
- Adding a second experiment registry or a new database table.
- Claiming profitability, benchmark outperformance, or a promotable candidate.

## 3. Data contracts

### A0

`NavRow` remains market-local and gains no inferred provider data. A0 must
distinguish:

- a leading cash-only inception row before the first benchmark session;
- a missing benchmark inside or after the benchmark-covered period;
- a row with a benchmark but missing/mismatched provenance;
- missing NAV components, duplicate dates, and reconciliation failures.

The finding reports `benchmarkCoverage`, `leadingInceptionRows`, and the clean
row count. Its top-level coverage is computed, never hardcoded to one. Existing
tainted rows remain outside the clean invariant cohort but their exclusion count
is reported by the run summary.

### A2

The route selects `id`, `entry_eligible`, `direction`, score, timestamp, and h10
label. It creates two separately named findings:

- `A2`: earliest eligible-long row per market/symbol/decision-date;
- `A2_ALL_SCORED`: earliest scored row per market/symbol/decision-date, context
  only and never candidate-establishing.

Filtering occurs before deduplication. A2’s exact deduped rows and per-date
statistic are reusable by A8; A8 may not reconstruct a different sample.
The observation ledger is read with stable bounded pagination; a PostgREST
response cap must never silently truncate the cohort.

### Closed-lot metrics

`ClosedLot` and `SizedLot` carry `entryDate` and `exitDate`. Their sample reports
`nDates` as distinct entry dates and includes `dateUnit: "entry_date"` in
metrics. Window bounds come from entry dates.

MFE/MAE are joined only from a matched matured observation label for the same
market/symbol and the lot’s entry date. If no unambiguous label exists, both are
NULL. A4 adds `unavailable`; NULL extremes are never `neither_touched` and do
not count as resolved coverage.

### A6 opening state and counterfactual

The replay begins at the end of the first canonical mark session that also has
an untainted EOD performance row:

- initial cash is that session’s persisted `paper_performance.cash_balance`;
- carried positions and quantities come directly from that first append-only
  mark-ledger session, aggregated by symbol and seeded at its canonical mark;
  today’s mutable lot state is never used to reconstruct a historical book;
- events are strictly after the opening session; ordinary exits remain
  exit-first, while an explicitly identified same-session round trip executes
  its entry before its own exit so the ledger's causal order is representable;
- missing opening marks make A6 insufficient rather than fabricated;
- entry and exit events are coalesced by session/symbol/type.

The actual arm uses actual quantities. The equal-size arm equalizes opening
position notional across carried names and, for each later entry session,
equalizes that session’s actual deployed notional across entered names. It keeps
state for actual and counterfactual holdings; every partial/full exit applies
the actual exit fraction to the counterfactual remaining quantity. No future
entry count or future notional may influence an earlier allocation.

The simulator accepts optional seeded positions. Rejection reasons are counted
by reason and exposed; an invalid exit makes the arm `data_invalid`, not a
comparable result.

### A8

A8 accepts dated, already-deduped A2 rows and computes the same statistic as A2:
mean of qualifying per-date Spearman rank ICs. Every placebo permutes outcomes
within decision date and recomputes that exact statistic. `horizonDays=10` is
part of the sample gate. The deterministic seed and iteration count are
persisted. Use at least 2,000 permutations so the minimum attainable p-value is
below the ten-trial Sidak threshold with useful resolution.

### A9

The route reads both `initial_stop_loss` and current `stop_loss`. A9 publishes
separate initial and current/trailing stop percentages and reward:risk values,
plus coverage for each. Positions trailed to/above cost remain in the current
cohort and are reported as locked-profit/non-positive risk distance, not silently
dropped. Entry vintage applies only to initial geometry.

### Run identity

`code_version` is never NULL. It is the deploy SHA when available and otherwise
the explicit metric version `alpha_diagnostics_v2`.

`dataset_fingerprint` hashes canonical, sorted content for every consumed input:
performance, trades, observations plus labels, marks, and positions. The payload
contains only selected fields, not provider secrets. `run_fingerprint` continues
to combine plan, dataset, and result. A same-day code-version or data correction
must create a distinct plan/run rather than reuse stale output.

No schema migration is required.

## 4. Files

### Modify

- `PROJECT_DECISIONS.md`
- `features/alpha-diagnostic-lab/FEATURE_ARCHITECTURE.md`
- `features/alpha-diagnostic-lab/IMPLEMENTATION_RESULT.md`
- `lib/analytics/alpha-diagnostic-contract.ts`
- `lib/analytics/alpha-diagnostics.ts`
- `lib/analytics/alpha-diagnostics-selection.ts`
- `lib/analytics/alpha-diagnostics-counterfactual.ts`
- `lib/analytics/alpha-diagnostics-portfolio.ts`
- `lib/simulation/portfolio-simulator.ts`
- `app/api/analytics/alpha-diagnostics/route.ts`
- `components/dashboard/AlphaDiagnosticLab.tsx`
- corresponding test files
- `WORK_LOG.md`

### Do not modify

- scoring, portfolio-constructor, PaperTrader, PositionMonitor, live execution,
  trading mandate, rotation, or broker modules;
- Supabase schema or production rows, except a real owner-triggered diagnostic
  run after the implementation is deployed through the normal release path.

## 5. Acceptance criteria

1. An adversarial fixture where all-scored IC is positive and eligible-long IC
   is negative makes A2 report the negative eligible-long result.
2. A2 and A8 consume byte-equivalent deduped rows and A8’s real statistic equals
   A2’s rank IC.
3. A8 permutes only within dates and fails the h10 effective-observation gate at
   60 dates.
4. A resized entry followed by partial and full exits produces no invalid exit
   and leaves zero counterfactual quantity.
5. A6 opening NAV equals persisted cash plus seeded marked positions within one
   cent; no pre-window position disappears and no inception NAV is presented as
   cash.
6. Changing any consumed value with unchanged row counts/date endpoints changes
   `dataset_fingerprint`; changing the metric version changes `plan_fingerprint`.
7. A cash-only leading inception row is explicitly counted; an internal missing
   benchmark, duplicate date, or missing NAV component fails A0.
8. Missing MFE/MAE is `unavailable`, reduces coverage, and is never
   `neither_touched`.
9. A3/A4/A5/A7 show distinct entry dates, not lot counts.
10. A9 initial metrics use `initial_stop_loss`; current metrics retain
    trailed-to-profit positions and report their count.
11. UI renders A2 and displays NULL as `—`, never zero; sample-unit text matches
    the metric.
12. Focused tests, full tests, production-parity typecheck/build, secret scan,
    and Graphify update complete, or every unrelated blocker is named precisely.
13. Source search proves no scorer, strategy, sizing, exit, paper/live, proposal,
    order, or broker module imports the diagnostic libraries or persisted result.

## 6. Rollback

Revert the v2 source commit. Existing immutable v1 experiment rows remain as
historical, explicitly superseded measurements. No database rollback is needed.
