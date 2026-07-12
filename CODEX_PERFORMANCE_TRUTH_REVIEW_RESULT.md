# Codex Review Result — Performance Truth Layer Architecture

Date: 2026-07-09  
Reviewer: Codex / ChatGPT  
Files reviewed:

- `features/performance-truth/FEATURE_ARCHITECTURE.md`
- `CODEX_PERFORMANCE_TRUTH_REVIEW_PROMPT.md`
- `lib/analytics/performance-metrics.ts`
- `lib/validation/engine.ts`
- `lib/learning/dataset.ts`
- `app/api/agents/performance/metrics/route.ts`
- `components/dashboard/PerformanceTruth.tsx`
- relevant migrations for `paper_trades`, `paper_performance`, `decision_observations`, `validation_experiments`, and `edge_universe_members`

## Verdict

Claude's architecture is a good P0 direction, but it does not reach 10/10.

It improves the system from “performance dashboard + scattered validation” toward a mandate-aware evaluation layer, but as proposed it still mostly evaluates executed paper trades. That is not enough to prove signal quality because executed trades are already selected by the current policy. A world-class Performance Truth Layer must evaluate both:

1. book/trade performance: what actually happened to the paper/live book, and
2. opportunity-level forward labels: what would have happened across the full scored opportunity set.

The doc should be approved only after the fixes below are applied.

Updated architecture score after proposed P0, as written: 6.5 / 10.

With the fixes in this review applied: approximately 7.2 / 10 for P0 foundation. It still will not be 10/10 until P1/P2 add data-quality ledger, conservative execution simulation, PIT universe/fundamentals, and real walk-forward promotion gates.

## Blocking fixes before build

| # | Severity | Location | Problem | Required fix |
|---:|---|---|---|---|
| 1 | BLOCKER | `features/performance-truth/FEATURE_ARCHITECTURE.md`, runEvaluation pseudocode | The query uses `.eq("status", "closed")` on `paper_trades`, but existing `paper_trades` uses `closed_at` and has no canonical `status` column. This would fail or return no trades. | Replace with `.not("closed_at", "is", null)`. If a future `status` column is desired, add it explicitly in migration and backfill, but that is unnecessary for P0. |
| 2 | BLOCKER | `features/performance-truth/FEATURE_ARCHITECTURE.md`, runEvaluation pseudocode | `expectancy()` expects rows with `pnl_pct`, but pseudocode passes `{ returnPct, won }`. Result: expectancy/win-rate become n=0 and all metrics look insufficient. | Call `expectancy(trades)` directly or map to `{ pnl_pct: t.pnl_pct }`. Persist `win_rate` from `expM.winRate`, not `expM.value`. |
| 3 | BLOCKER | `features/performance-truth/FEATURE_ARCHITECTURE.md`, runEvaluation pseudocode | `calibration()` expects `{ predicted, win }`, but pseudocode passes `{ score, won }`. Result: calibration is silently empty. | Map to `{ predicted: Number(t.analyst_score) / 100, win: (t.pnl_pct ?? 0) > 0 }`. |
| 4 | BLOCKER | `features/performance-truth/FEATURE_ARCHITECTURE.md`, API/UI reuse | Adding `?mandateId=` to `/api/agents/performance/metrics` cannot make Sharpe/Sortino/MaxDD mandate-specific because `paper_performance` is only per `(date, market)`, not per mandate. NAV metrics would still represent the whole market book while trades are mandate-filtered. | Either add mandate-level NAV snapshots, or compute mandate NAV/returns from mandate-filtered trade cash flows. In P0, label whole-book metrics clearly and only make trade metrics mandate-specific, or add `paper_performance_mandate` as a new derived append-only/table. |
| 5 | BLOCKER | `features/performance-truth/FEATURE_ARCHITECTURE.md`, “Validation engine” reuse | The doc says `lib/validation/engine.ts` result is “never persisted anywhere.” That is false. It already writes `validation_experiments` and updates `strategy_versions.validation_experiment_id`. Creating `strategy_evaluations` as a second persistence target risks duplicated/conflicting truth. | Change architecture: `strategy_evaluations` should reference or summarize `validation_experiments`, not replace it. Add `validation_experiment_id bigint references validation_experiments(id)` or store separate sections: `book_metrics` and `validation_experiment_id`. |
| 6 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, `edge_universe_members` reuse | The doc calls `edge_universe_members` “PIT-ish eligibility.” The migration and route explicitly say it is current-liquid/survivorship-biased and not true point-in-time membership. | Replace “PIT-ish” with “audit of the current-liquid universe used for the run; not true PIT membership.” Do not use it as a promotion-grade PIT universe. |
| 7 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, migrations A/B | New public tables do not specify RLS. Supabase exposed-schema tables should enable RLS. | Add `alter table public.investment_mandates enable row level security;` and `alter table public.strategy_evaluations enable row level security;`. For P0, prefer deny-by-default and access via owner-gated service-role routes. If direct authenticated reads are needed, add explicit owner-only or single-owner policies. |
| 8 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, `investment_mandates.live_enabled` | `live_enabled` inside mandates is dangerous/ambiguous. It may later be misread as live-trading authorization, bypassing the existing strategy_config/autonomy/owner-click gates. | Remove it from P0 or rename to `eligible_for_live_review boolean default false` with a hard doc note: “not consumed by broker gateways; advisory only.” |
| 9 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, mandate mutability | If mandate rows are editable, old evaluations can change meaning after the fact. Evaluations must be reproducible. | Add `mandate_snapshot jsonb not null` to `strategy_evaluations`; optionally add `version`, `active`, `archived_at` to `investment_mandates`. Do not rely on mutable mandate rows to interpret historical evaluations. |
| 10 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, FK wiring | Acceptance criteria only mention new `paper_trades` inserts getting `mandate_id`. But the migration also adds `mandate_id` to `agent_signals` and `decision_observations`; those must be populated at signal/observation creation time, before paper trading. | Add acceptance criteria and file list for `lib/research-agent.ts`, `lib/deepseek-agent.ts`, `app/api/agents/paper-trade/route.ts`, and the `execute_paper_fill` RPC path to propagate `mandate_id`. |
| 11 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, pass/fail gate | `n_trades >= 20 AND Sharpe > 0.5` is not a sufficient gate. It is in-sample, trade-selected, and ignores the existing walk-forward p-value and max drawdown. | For P0 display, this can be a weak health flag. For any promotion gate, require `validation_experiments.passed = true`, `p_improvement`, `n_effective`, fold wins, max drawdown cap, positive benchmark-relative expectancy, and no taint overload. |
| 12 | HIGH | `features/performance-truth/FEATURE_ARCHITECTURE.md`, forward labels | Closed paper trades are not enough for signal quality. They evaluate only what the current policy chose to trade. | Add opportunity-level evaluation from `decision_observations` × `observation_labels` using existing `lib/learning/dataset.ts`, filtered by `mandate_id` and horizon. Persist `n_observations`, `horizon_days`, and benchmark-neutral label stats. |
| 13 | MEDIUM | `features/performance-truth/FEATURE_ARCHITECTURE.md`, insert error handling | The pseudocode ignores Supabase errors for mandate fetch, trade fetch, NAV fetch, and evaluation insert. A failed insert could still return a “passed” result to UI. | Check every `{ error }`; return `ok:false` and do not mark success when reads/writes fail. Money path is unaffected, but truth path should fail closed. |
| 14 | MEDIUM | `features/performance-truth/FEATURE_ARCHITECTURE.md`, taint semantics | Current metrics route intentionally counts tainted trades for book truth. Proposed evaluation excludes tainted trades. Both are valid but must be separated. | Persist `n_trades_total`, `n_trades_evaluable`, `tainted_count`, and `excluded_count`. Show both “book performance including taint” and “learnable/evaluable performance excluding taint.” |
| 15 | MEDIUM | `features/performance-truth/FEATURE_ARCHITECTURE.md`, concurrency/idempotency | Owner can click “Run Evaluation” repeatedly and append duplicate rows with identical input set. Append-only is correct, but duplicate runs can clutter/confuse. | Add `dataset_hash`, `window_start`, `window_end`, and `input_counts` to `strategy_evaluations`. UI should group identical hashes or mark duplicate/same-dataset reruns. Do not upsert. |
| 16 | MEDIUM | `features/performance-truth/FEATURE_ARCHITECTURE.md`, route helper | The doc references `requireOwnerSession()`, but repo uses `requireOwner()` in `lib/auth/require-owner.ts`. | Use `requireOwner()` unless Claude intentionally creates a new helper. |
| 17 | MEDIUM | `features/performance-truth/FEATURE_ARCHITECTURE.md`, mandate schema | The mandate schema is too thin to distinguish strategy families from risk profiles. It lacks allowed asset types, allowed signal families, turnover budget, and order/notional ceilings. | For P0, add at least `allowed_asset_types text[]`, `allowed_signal_families text[]`, `turnover_budget_monthly numeric`, and `evaluation_horizon_days int[]`. Keep money-limit fields advisory unless explicitly wired through existing risk gates. |
| 18 | LOW | `features/performance-truth/FEATURE_ARCHITECTURE.md`, `max_position_pct` | `max_position_pct` on mandates may conflict with `strategy_config`/risk profile caps if later reused for live sizing. | Mark it evaluation/advisory only for P0, or rename to `target_max_position_pct`. Live gates must continue using existing approved money-limit sources. |

## Q1 — Dimension scores

### Signal generation quality — 5.0 / 10

Fixes:

- Adds mandate context, which is necessary before judging whether a signal worked.
- Starts separating swing US vs swing India.
- Adds a place to store strategy-level evaluations.

Still missing:

- Does not compute forward labels across the full scored opportunity set.
- Does not force expected-return or evidence-quality calibration.
- Does not prevent a policy-selected paper-trade sample from being treated as signal proof.

Minimum to reach 10/10:

- Attach every `decision_observations` row to a mandate.
- Evaluate `decision_observations × observation_labels` by mandate/horizon.
- Require PIT-safe data availability and benchmark-neutral forward labels.
- Promote only from out-of-sample opportunity-level evidence, not paper fills alone.

### Learning loop rigor — 6.0 / 10

Fixes:

- Moves toward deterministic statistical evaluation.
- Reuses existing walk-forward/bootstrap validation engine.
- Keeps LLMs out of numeric optimization.

Still missing:

- Proposed doc misunderstands existing persistence: `validation_experiments` already exists.
- Pass/fail gate is too weak and in-sample.
- No mandate-aware validation dataset yet.

Minimum to reach 10/10:

- Use `validation_experiments` as the canonical challenger evidence ledger.
- Add mandate filtering to `loadLabeledDataset()`.
- Require p-value / p-improvement, fold wins, n-effective, drawdown, benchmark-neutral return, and cost-adjustment.

### Execution realism — 5.0 / 10

Fixes:

- Reuses existing cost/slip metrics.
- Recognizes execution model in the mandate schema.

Still missing:

- Paper fills remain mostly simplified.
- No partial fills, stale-quote rejection, market-hours fill eligibility, or realistic bid/ask fill assumptions in this P0.

Minimum to reach 10/10:

- Implement conservative paper execution model before any autonomy expansion.
- Evaluate “would not fill” and partial-fill outcomes.
- Store modeled vs realized slippage by market/liquidity bucket.

### Risk management — 6.8 / 10

Fixes:

- Mandates can eventually scope risk and evaluation.
- Keeps P0 read-only/no live impact.

Still missing:

- Mandate risk fields are not connected to exposure accounting.
- `live_enabled` field is unsafe unless clearly advisory.
- No mandate-level daily/cumulative exposure ledger.

Minimum to reach 10/10:

- Keep live caps in existing owner-approved risk/gateway config.
- Add mandate-specific exposure reporting separately.
- Never allow mandate rows to authorize live trading by themselves.

### Operational robustness — 6.2 / 10

Fixes:

- Minimal new routes.
- Append-only evaluation table direction is correct.

Still missing:

- No dataset hash/idempotency marker.
- No job/run state for evaluation attempts.
- Pseudocode ignores Supabase read/write errors.

Minimum to reach 10/10:

- Add `evaluation_run_id`, `dataset_hash`, `window_start`, `window_end`, and explicit error states.
- Fail closed on DB errors.
- UI should show last successful run and failed run reason.

### Data pipeline — 4.8 / 10

Fixes:

- Starts using benchmark and cost-adjusted metrics.
- Acknowledges taint/exclusion.

Still missing:

- `edge_universe_members` is not PIT membership.
- No data-quality ledger in P0.
- No fundamental `available_at` / filing-date discipline.
- No guarantee benchmark data and trade data share comparable dates.

Minimum to reach 10/10:

- Data-quality ledger by symbol/date/dimension/source.
- PIT universe membership or honest “non-PIT” flags that block promotion.
- Mandate-specific benchmark series and label maturity checks.

### Agent coordination — 6.5 / 10

Fixes:

- Clarifies Evaluation as deterministic/non-LLM.
- Starts defining how PerformanceTruth UI, metrics API, validation engine, and paper ledgers should connect.

Still missing:

- No complete file-level wiring list for `mandate_id`.
- No contract update for ResearchAgent/DeepSeekAgent/PaperTrader/LearnerAgent.
- No downstream rule saying LearnerAgent must consume strategy evaluations before proposing promotion.

Minimum to reach 10/10:

- Add typed mandate contract to signal, observation, paper fill, validation, and learner handoffs.
- Add abstention reasons and evidence eligibility at every boundary.

### Security / live-money safety — 7.2 / 10

Fixes:

- No LLM in evaluation.
- Owner-gated run route.
- No cron access for manual evaluation route.
- No live trading impact.

Still missing:

- New tables lack explicit RLS plan.
- `live_enabled` field can be misused later.
- Service-role routes need strict owner gates and bounded query limits.

Minimum to reach 10/10:

- Enable RLS on new tables.
- Use `requireOwner()` consistently.
- Remove/rename `live_enabled`.
- Add explicit “not consumed by broker gateway” note for every mandate field that looks like a money control.

## Q2 — Mandate schema

The current mandate schema is enough to label “US swing” vs “India swing,” but not enough to meaningfully distinguish trader/investor strategy families.

Load-bearing fields for P0:

- `name`
- `market`
- `horizon`
- `benchmark_symbol`
- `min_holding_days`
- `max_holding_days`
- `execution_model`
- `tax_sensitivity`
- `income_preference`
- `allowed_asset_types`
- `allowed_signal_families`
- `evaluation_horizon_days`

Nice-to-have for P0 but load-bearing by P1/P2:

- `turnover_budget_monthly`
- `max_position_pct` as advisory/evaluation field
- `max_order_notional_usd`
- `max_order_notional_inr`

Important distinction:

- Money-limit fields can exist as mandate metadata, but the live broker gateway must not consume them unless a separate approved risk architecture wires them into existing caps and owner approval. Otherwise the mandate table becomes a hidden money-control surface.

Recommended P0 schema additions:

```sql
allowed_asset_types text[] not null default array['equity','etf'],
allowed_signal_families text[] not null default array['momentum','quality','technical','sentiment','macro'],
evaluation_horizon_days int[] not null default array[5,10,20],
turnover_budget_monthly numeric,
mandate_version int not null default 1,
active boolean not null default true,
archived_at timestamptz
```

Recommended `strategy_evaluations` addition:

```sql
mandate_snapshot jsonb not null,
dataset_hash text,
window_start date,
window_end date,
n_trades_total int,
n_trades_evaluable int,
tainted_count int,
excluded_count int,
validation_experiment_id bigint references validation_experiments(id)
```

## Q3 — Pass/fail gate

Current gate `n_trades >= 20 AND Sharpe > 0.5` is not sufficient.

Specific problems:

- Sharpe > 0.5 is weak for promotion and can be unstable with 20 trades.
- Sharpe from `paper_performance` is whole-market-book unless mandate-level NAV exists.
- It is in-sample if computed from all executed trades.
- It ignores the existing walk-forward/bootstrap validation engine.
- It ignores max drawdown.
- It ignores benchmark-neutral return.
- It ignores taint/degraded data concentration.

Recommended gate separation:

### P0 display gate

Use simple labels:

- `insufficient_sample`
- `negative_or_zero_edge`
- `promising_but_unvalidated`
- `validation_required`

Do not use P0 `passed=true` to imply live readiness.

### Strategy promotion gate

Require all:

- `validation_experiments.passed = true`
- `p_improvement >= 0.80` or stricter
- paired-diff CI lower bound not materially negative
- `n_effective >= minimum` by horizon
- at least 3/5 folds won
- benchmark-neutral expectancy > 0
- max drawdown within mandate limit
- tainted/evaluable ratio below threshold
- no unresolved data-quality or execution-model warnings

## Q4 — Forward label gap

Yes, this is a major gap.

Closed paper trades are necessary for book truth, but insufficient for signal truth.

Reason: paper trades are selected by the current ResearchAgent/PaperTrader policy. If the policy only trades the top 3 candidates, evaluation of closed paper trades cannot tell whether the score function separated winners from losers across all opportunities. It only tells whether the selected subset happened to work.

The repo already has the right starting point:

- `decision_observations` records scored candidates.
- `observation_labels` stores matured forward returns.
- `lib/learning/dataset.ts` loads labeled observations.
- `lib/validation/engine.ts` performs walk-forward replay with block bootstrap.

Required architecture change:

- P0 `strategy_evaluations` should include both:
  - `book_metrics`: from closed paper trades and paper NAV.
  - `opportunity_metrics`: from `decision_observations × observation_labels`.

For swing trading, a closed paper trade with next-close/5bps spread is acceptable for book P&L tracking, but not sufficient as a full cost-adjusted, benchmark-relative signal label.

## Q5 — P1 ordering

Recommended order:

### 1. Data quality ledger

Most directly improves learning-loop signal quality. Without source/freshness/available-at/confidence by dimension, the evaluator cannot know whether a signal was built on reliable evidence. This also protects against Alpha Vantage/free-provider quota failures being treated as real neutral evidence.

Minimum-code path:

- Start by logging quality rows from existing provider calls.
- Feed `data_confidence` and taint reasons into existing `decision_observations` and `paper_trades`.

### 2. Conservative paper execution model

Second-highest leverage because it closes the paper/live confidence gap. A strategy that only works under optimistic fills is not a strategy.

Minimum-code path:

- Add stale quote rejection.
- Add market-hours check.
- Add conservative bid/ask/slippage model.
- Defer full partial-fill state machine if needed.

### 3. ResearchDecision output shape

Important, but do it after the evaluator and data ledger can judge the fields. Otherwise expectedReturnBps becomes another persuasive LLM field without enough calibration.

Minimum-code path:

- Add optional fields first.
- Populate only when data quality is sufficient.
- Force abstention when missing evidence is load-bearing.

## Required edits to Claude's architecture doc

Claude should update `features/performance-truth/FEATURE_ARCHITECTURE.md` before implementation:

1. Replace `edge_universe_members — PIT-ish eligibility` with an explicit non-PIT/survivorship warning.
2. Correct `lib/validation/engine.ts` inventory: it already persists `validation_experiments`.
3. Define `strategy_evaluations` as a summary/evaluation table that references `validation_experiments`, not as a replacement.
4. Add RLS statements for new tables.
5. Remove or rename `live_enabled`.
6. Add `mandate_snapshot`, `dataset_hash`, `window_start`, `window_end`, taint counts, and `validation_experiment_id`.
7. Fix runEvaluation pseudocode:
   - use `closed_at IS NOT NULL`
   - pass `pnl_pct` to `expectancy`
   - pass `predicted/win` to `calibration`
   - persist `win_rate` correctly
   - check all Supabase errors
8. Clarify that mandate-specific Sharpe requires mandate-specific NAV; otherwise show whole-book Sharpe separately.
9. Add file-level wiring for `mandate_id`:
   - `lib/research-agent.ts`
   - `lib/deepseek-agent.ts`
   - `app/api/agents/paper-trade/route.ts`
   - `execute_paper_fill` RPC migration
   - `lib/learning/dataset.ts`
   - `lib/validation/engine.ts`
10. Add opportunity-level evaluation from `decision_observations × observation_labels`.

## Claude Code prompt

Use this prompt with Claude:

```text
Read CODEX_PERFORMANCE_TRUTH_REVIEW_RESULT.md and update features/performance-truth/FEATURE_ARCHITECTURE.md before writing implementation code.

Do not build yet.

Your task:
1. Apply every BLOCKER/HIGH doc fix from the Codex review.
2. Keep the feature P0 read-only and no-live-impact.
3. Correct the reuse inventory:
   - validation_experiments already persists ValidationResult.
   - edge_universe_members is current-liquid/non-PIT, not PIT-ish.
4. Fix the runEvaluation pseudocode:
   - paper_trades closes via closed_at, not status.
   - expectancy input must use pnl_pct.
   - calibration input must use predicted/win.
   - win_rate must use expM.winRate.
   - all Supabase errors must be handled.
5. Add schema details:
   - RLS for new tables.
   - mandate_snapshot.
   - dataset_hash/window_start/window_end.
   - n_trades_total/n_trades_evaluable/tainted_count/excluded_count.
   - validation_experiment_id FK to validation_experiments.
6. Remove or rename mandate live_enabled so it cannot be mistaken for live-trading authorization.
7. Explicitly distinguish book/trade metrics from opportunity-level forward-label metrics.
8. Add the exact file/migration wiring needed to propagate mandate_id into agent_signals, paper_trades, decision_observations, and validation datasets.

Stop after updating the architecture doc. Ask Vaibhav for approval before implementation.
```

## Final assessment

This architecture is worth continuing, but it should not be described as “10/10” yet.

It is a strong P0 scaffold if corrected. The real 10/10 path requires the next layer: mandate-aware opportunity labeling, data-quality ledger, conservative paper execution, and validation gates that use the existing walk-forward/bootstrap engine instead of a simple Sharpe threshold.
