# Feature Architecture - Benchmark Alpha Scorecard

> Status: **PROPOSAL - architecture reviewed/corrected by Codex on 2026-07-13. Not built.**
> Scope: deterministic measurement first; no order path, no paper fills, no learner mutation in Phase 1.
> Build gate: Phase 2 learner/promotion wiring requires a separate owner approval after Phase 1 has accumulated evidence.
> Update when built: `docs/arch/04-database-schema.md`, `docs/arch/05-crons-and-scheduling.md`, `docs/arch/09-learning-loop.md`, and `public/agent-diagrams/system-map.json`.

## Purpose

Kairos already stores some benchmark information:

- `paper_performance.bench_nav`, `bench_return_pct`, `alpha_pct` - a single per-market paper benchmark series.
- `live_performance.account_id,date,equity,bench_nav` - a forward-built live account equity curve currently tied to VOO.
- `investment_mandates.benchmark_symbol` and `strategy_evaluations.book_alpha_pct` - mandate/evaluation context.

What is missing is a trustworthy **multi-horizon, per-market, per-book benchmark scorecard** that answers:

- Are paper and live beating the configured benchmark over 1W, 1M, 3M, YTD, and 1Y?
- Is the result statistically usable or just short-window noise?
- Which benchmark is primary for the learning objective, and which are comparison-only?
- Can a benchmark be added without hardcoding VOO/NIFTY everywhere?

This feature belongs inside the existing **Performance Truth Layer**, not beside it. It is a materialized measurement surface and later an input to governed learner/promotion decisions.

## Non-Negotiable Design Rules

1. **No cross-currency roll-up.** US USD books and India INR books are never summed, compared, or converted implicitly.
2. **Benchmark currency must match book currency.** US books benchmark against USD-traded benchmarks such as `VOO`; India books benchmark against INR/index series such as `^NSEI`/NIFTY source symbols.
3. **Common-window rebasing only.** Portfolio and benchmark start from the same first date where both have valid levels inside the requested horizon.
4. **No action from noisy windows.** Phase 1 is measurement-only. Phase 2 can only use longer, confidence-qualified windows.
5. **Deterministic only.** No LLM computes, fills, overrides, or gates alpha.
6. **Existing series are source ledgers.** `paper_performance` and `live_performance` remain the source series; `benchmark_scorecard` stores rollups so dashboards/agents read one stable, audited number.

## Reviewed Design Issues And Fixes

### 1. Live aggregation was underspecified

**Failure scenario:** `live_performance` is keyed only by `(account_id,date)` and has VOO in `bench_nav`. A future rollup that sums all rows by date can mix Webull + Robinhood, trading + read-only, or even future India accounts. The resulting "live alpha" would be an accidental account set, not a market book.

**Fix:** Add explicit live series provenance before live scorecarding:

- Add nullable `market`, `currency`, `broker`, and `book_scope` columns to `live_performance`, backfilled from `live_account_snapshots`/broker registry where possible.
- Phase 1 scorecard uses canonical scopes only:
  - `paper`: one market-level paper pool from `paper_performance`.
  - `live`: one market-level live book per `(market,currency,book_scope='all_live_accounts')`, summing only accounts whose rows match that market/currency/scope.
- If provenance is missing for any live row in the window, the live scorecard row is `status='insufficient_data'`, not estimated.

### 2. Info-ratio math was ambiguous

**Failure scenario:** The proposal said "excess / stdev of daily excess" but did not specify units. If cumulative 1M excess return is divided by daily tracking error without annualization/window scaling, the ratio is not comparable across 1W, 3M, and 1Y.

**Fix:** Persist both components:

- `excess_return_pct = portfolio_window_return_pct - benchmark_window_return_pct`.
- `tracking_error_daily_pct = sample stdev(daily_portfolio_return_pct - daily_benchmark_return_pct)`.
- `info_ratio = mean(daily_excess_return_pct) / stdev(daily_excess_return_pct) * sqrt(252)`.
- If tracking error is zero, non-finite, or sample size is too small, `info_ratio=null` and `status='insufficient_data'`.

The dashboard may show cumulative excess for intuitive reading, but learner/promotion logic may only consume the annualized daily information ratio.

### 3. YTD/1Y edge cases were not guarded

**Failure scenario:** On January 3, a YTD row might have 1-2 observations and produce a huge positive/negative alpha; on a newly created live account, 1Y might silently use two days and look complete.

**Fix:** Each row stores `window_start`, `window_end`, `n_observations`, `n_return_days`, and `coverage_pct`. Confidence gates:

| Horizon | Minimum return days for display | Minimum for Phase 2 use |
|---|---:|---:|
| `1W` | 4 | never used for gating |
| `1M` | 15 | never used for promotion |
| `3M` | 45 | 60 |
| `YTD` | min(20, elapsed trading days - 1) | max(60, 70% of elapsed trading days) |
| `1Y` | 120 | 180 |

Rows below the display floor are stored with `status='insufficient_data'`. Rows below the Phase 2 floor are display-only.

### 4. Benchmark priceability was too optimistic

**Failure scenario:** A user adds `^NSEBANK` or a sector ETF that the current provider cannot price. If the rollup simply skips it with a log line, the UI and agents can mistake absence for neutrality.

**Fix:** Add a small benchmark observation ledger and explicit row status:

- `benchmark_price_observations`: one row per `(benchmark_id,date,component_symbol)` with close, currency, provider, and `source_status`.
- The rollup writes a `benchmark_scorecard` row for every enabled benchmark/horizon/book even when the benchmark is unpriceable, with `status='benchmark_unpriceable'` and `missing_reason`.
- UI shows the failure state; agents treat it as unavailable.

### 5. Primary benchmark uniqueness must be scoped

**Failure scenario:** A single partial unique index on `(market) where is_primary` works for one benchmark per market, but blend/single representations and future inactive rows can accidentally leave two "primary-like" configs or none.

**Fix:** Use a normalized `benchmarks` table with stable IDs and an explicit partial unique index:

```sql
unique (market) where is_primary = true and enabled = true
```

The Settings/API update that flips primary must be transactional: clear old primary and set new primary in one service-role operation. If no enabled primary exists for a market, Phase 2 is disabled for that market and Phase 1 rows are comparison-only.

### 6. Phase 2 could overfit the learner to beta/regime

**Failure scenario:** A high beta strategy can beat VOO in a risk-on month and get promoted even if it is simply more volatile. Conversely, a defensive strategy can lag in a melt-up and be rejected despite doing its job.

**Fix:** Phase 2 cannot replace the existing validation gate. It is an additional guard:

- Challenger still must pass walk-forward validation (`validation_experiments.passed=true`) and existing sample/evidence gates.
- Primary-benchmark info ratio is one metric in the Performance Truth row, not the only objective.
- Promotion requires either:
  - positive primary info ratio over the mandate horizon with sufficient sample, or
  - explicit owner override/journaled reason when the mandate intentionally differs from the benchmark.
- Learner objective uses a blended score: validation pass/fold stability first, then primary benchmark IR, then drawdown/cost/slip. No direct mutation from scorecard rows.

### 7. Posture feedback was too action-like

**Failure scenario:** A negative 1W alpha row triggers posture tightening, which reduces entries after random weekly noise - the same failure class as the prior phantom drawdown cascade.

**Fix:** Posture feedback is advisory and slow:

- Only `3M`, `YTD`, or `1Y` primary rows may create `trailing-benchmark:*` alerts.
- Requires two consecutive completed rollups below threshold.
- Alert severity is `warn`, not `critical`.
- It never toggles `market_controls`, risk profile, order size, or live-auto settings. It recommends review only.

## Data Model - Phase 1

### `benchmarks`

Config rows. One enabled primary per market.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Stable key used by scorecard rows |
| `market` | text | `us` or `india` |
| `label` | text | Human label: `VOO`, `NIFTY 50`, `QQQ`, `60/40` |
| `kind` | text | `single` or `blend` |
| `symbol` | text nullable | Single-symbol benchmark display/source symbol |
| `provider_symbol` | text nullable | Provider-specific ticker, e.g. `VOO`, `^NSEI`, `NIFTY50.NS` |
| `currency` | text | `USD` or `INR`; must match market/book |
| `price_provider` | text | `massive`, `yahoo`, `kite_yahoo`, `manual_import` |
| `is_primary` | boolean | One enabled primary per market |
| `enabled` | boolean | Disabled rows retained for history |
| `weights` | jsonb nullable | Blend components: `[{benchmark_id, weight}]`; weights must sum to 1.0 |
| `created_at` / `updated_at` | timestamptz | |

Seed:

- US: `VOO`, USD, provider `massive`, primary.
- India: `NIFTY 50`, INR, provider symbol used by the existing quote path (`^NSEI` or `NIFTY50.NS`, whichever the implementation proves priceable), primary.

### `benchmark_price_observations`

Small durable price ledger for benchmark components. This avoids refetching every horizon and makes missing data auditable.

| Column | Type | Notes |
|---|---|---|
| `benchmark_id` | uuid FK |
| `component_symbol` | text |
| `date` | date |
| `close` | numeric |
| `currency` | text |
| `provider` | text |
| `source_status` | text | `ok`, `missing`, `provider_error`, `unpriceable` |
| `error` | text nullable | Short provider error; no secrets |
| PK | `(benchmark_id, component_symbol, date)` | |

### `benchmark_scorecard`

Materialized rollup. This is the always-on number.

| Column | Type | Notes |
|---|---|---|
| `market` | text | `us` or `india` |
| `currency` | text | Must match book currency |
| `book` | text | `paper` or `live` |
| `book_scope` | text | `market_paper_pool`, `all_live_accounts`; future account subsets require explicit scopes |
| `benchmark_id` | uuid FK |
| `benchmark_symbol` | text | Snapshot display value |
| `is_primary_snapshot` | boolean | Snapshot at compute time |
| `horizon` | text | `1W`, `1M`, `3M`, `YTD`, `1Y` |
| `as_of` | date | Rollup date |
| `window_start` / `window_end` | date | Actual common window used |
| `portfolio_return_pct` | numeric | Rebased over common window |
| `bench_return_pct` | numeric | Rebased over common window |
| `excess_return_pct` | numeric | Portfolio minus benchmark |
| `daily_excess_mean_pct` | numeric | Mean daily excess return |
| `tracking_error_daily_pct` | numeric | Sample stdev of daily excess |
| `info_ratio` | numeric | Annualized daily excess / tracking error |
| `n_observations` | int | Common level observations |
| `n_return_days` | int | Common daily return pairs |
| `coverage_pct` | numeric | Common valid observations / expected trading observations |
| `confidence` | text | `insufficient`, `low`, `medium`, `high` |
| `status` | text | `ok`, `insufficient_data`, `benchmark_unpriceable`, `book_series_missing`, `currency_mismatch`, `stale_series` |
| `missing_reason` | text nullable | Explain unavailable rows |
| PK | `(market, currency, book, book_scope, benchmark_id, horizon, as_of)` | |

RLS: owner-read, service-role writes. No public/anon policy. Add indexes on `(market,book,book_scope,as_of desc)` and `(benchmark_id,as_of desc)`.

## Computation Contract

### Series loading

Paper:

- Source: `paper_performance(date, market, nav)`.
- Currency: `USD` for `us`, `INR` for `india`.
- Existing `bench_nav`/`alpha_pct` remains for the legacy single-benchmark chart; the scorecard computes its own benchmark series for config-driven rows.

Live:

- Source: `live_performance` rows with explicit `market`, `currency`, and `book_scope`.
- Aggregation: sum `equity` by date only within the same `(market,currency,book_scope)`.
- No constant-holdings estimate may feed `benchmark_scorecard`; estimated live charts stay visually labeled and are not learner inputs.

Benchmark:

- Source: `benchmark_price_observations`, filled by the rollup from provider adapters.
- For `single`: one close series.
- For `blend`: combine component daily returns with fixed weights, rebalanced daily for measurement. Blend weights are normalized only if the stored sum is within a small tolerance; otherwise row status is `benchmark_unpriceable`.

### Windowing

1. Determine target horizon start:
   - `1W`: as_of minus 7 calendar days.
   - `1M`: as_of minus 30 calendar days.
   - `3M`: as_of minus 90 calendar days.
   - `YTD`: January 1 of as_of year.
   - `1Y`: as_of minus 365 calendar days.
2. Filter portfolio and benchmark levels to dates >= target start and <= as_of.
3. Inner join by date. Do not forward-fill for scorecard math.
4. Use the first joined row as the base for both portfolio and benchmark.
5. Compute simple daily returns from adjacent joined rows.
6. If common rows or return pairs fail the horizon confidence floor, write `status='insufficient_data'`.

### Math

Use fractions internally, persist percentages for UI consistency.

```text
portfolio_return_pct = (portfolio_last / portfolio_first - 1) * 100
bench_return_pct     = (bench_last / bench_first - 1) * 100
excess_return_pct    = portfolio_return_pct - bench_return_pct

daily_excess_pct[i]        = portfolio_daily_return_pct[i] - benchmark_daily_return_pct[i]
tracking_error_daily_pct   = sample_stdev(daily_excess_pct)
daily_excess_mean_pct      = mean(daily_excess_pct)
info_ratio                 = daily_excess_mean_pct / tracking_error_daily_pct * sqrt(252)
```

Never divide cumulative excess by daily tracking error.

## Surfacing - Phase 1

- Dashboard Alpha Scorecard:
  - Market switch: US/India.
  - Book tabs: paper/live.
  - Rows: horizons.
  - Columns: enabled benchmarks.
  - Cell: cumulative excess return, annualized info ratio, confidence/status badge.
  - Missing/unpriceable rows are visible, not omitted.
- Agent helper:
  - `getAlpha(svc, {market, book, bookScope, horizon, benchmarkId?})`
  - Returns only the latest scorecard row with status/confidence.
  - Agents must treat non-`ok` or low-confidence rows as unavailable.

## Objective And Feedback - Phase 2

Phase 2 is **not part of the Phase 1 build**. It needs a separate architecture approval after Phase 1 data exists.

Allowed Phase 2 wiring:

1. Add primary benchmark scorecard fields to `strategy_evaluations` snapshots:
   - `primary_benchmark_id`
   - `primary_benchmark_symbol`
   - `primary_horizon`
   - `primary_excess_return_pct`
   - `primary_info_ratio`
   - `primary_alpha_confidence`
2. LearnerAgent may read these fields as evidence but may not mutate weights from them directly.
3. Promotion gate remains: existing walk-forward validation pass first, then benchmark-alpha guard second.
4. Benchmark guard consumes only confidence-qualified `3M`, `YTD`, or `1Y` primary rows, never `1W`/`1M`.
5. Alerts are advisory:
   - `trailing-benchmark:<market>:<book>` only after two consecutive qualified underperformance rows.
   - Warn-only, clears after recovery.
   - No automatic pause, kill switch, order-size change, risk profile change, or live-auto change.

## Extensibility

Adding a benchmark should be possible by inserting a config row, but only if the provider can price it:

1. Insert `benchmarks` row as disabled.
2. Run a priceability check for at least 30 recent observations.
3. If priceable and currency matches market, enable it.
4. To change primary, call a service-route transaction that ensures exactly one enabled primary per market.

Blend benchmarks ship after single-symbol benchmarks:

- Component benchmarks must already be enabled and priceable.
- Weights must sum to 1.0.
- Blend currency must match every component and the target market.

## Build Order

1. **P1A - series/provenance migration**
   - Add benchmark config/observation/scorecard tables.
   - Add live performance provenance columns or an explicit live-account-to-market mapping needed for safe aggregation.
2. **P1B - deterministic math library**
   - Pure functions for common-window rebasing, daily excess, tracking error, info ratio, confidence/status.
   - Unit tests for missing dates, zero tracking error, January YTD, short 1W/1M windows, USD/INR mismatch, and live multi-account aggregation.
3. **P1C - rollup route + cron**
   - Owner/cron-gated route.
   - Writes every enabled benchmark/book/horizon row, including unavailable statuses.
   - No learner/order side effects.
4. **P1D - dashboard + helper**
   - Alpha Scorecard UI.
   - `getAlpha` read helper.
   - Docs/system-map updates.
5. **P2 - gated objective wiring**
   - Only after P1 evidence and owner approval.
   - Add Performance Truth snapshot fields and learner/promotion read-only consumption.
   - Add warn-only posture reporter.

## Files - Phase 1

- `supabase/migrations/17X_benchmark_alpha.sql`
- `lib/analytics/benchmark-alpha.ts`
- `app/api/agents/benchmark-scorecard/route.ts`
- `components/dashboard/AlphaScorecard.tsx`
- `tests/benchmark-alpha.test.ts`
- `docs/arch/04-database-schema.md`
- `docs/arch/05-crons-and-scheduling.md`
- `docs/arch/09-learning-loop.md`
- `public/agent-diagrams/system-map.json`

## What Not To Build In Phase 1

- Do not change LearnerAgent objectives.
- Do not change promotion gates.
- Do not change risk posture automatically.
- Do not add live-order, paper-fill, sizing, or broker behavior.
- Do not use estimated live backcasts in scorecard rows.
- Do not silently skip unpriceable benchmarks.
