# Codex Review — Performance Truth Layer Architecture

You are a senior quantitative systems architect. You reviewed Kairos at 6.0/10 in a prior
round. You now have a proposed architecture for the P0 fix: a mandate-aware, cost-adjusted
Performance Truth Layer. Your job is to score this architecture against the 10/10 standard
for each of the 8 dimensions from your prior review.

Be brutally honest. Score low where warranted. If the architecture is insufficient for
10/10, say exactly what is still missing, wrong, or underspecified. Concrete proposals only.
"Needs more work" without specifics is useless.

---

## Context: prior scores (your own review)

| Dimension | Prior score | Your stated fix |
|---|---:|---|
| Signal generation quality | 4.0 / 10 | Require PIT IC, walk-forward, cost-adjusted hit-rate, benchmark-relative evidence |
| Learning loop rigor | 5.0 / 10 | Separate feature discovery from optimization; deterministic walk-forward |
| Execution realism | 4.5 / 10 | Conservative paper fills, spread, slippage, stale-quote guard, partial fills |
| Risk management | 6.5 / 10 | Mandate-scoped exposure accounting |
| Operational robustness | 6.0 / 10 | Durable job records, retries, visible state transitions |
| Data pipeline | 4.0 / 10 | Data quality ledger: source, as_of, available_at, freshness, confidence |
| Agent coordination | 6.0 / 10 | Typed contracts, abstention reasons, promotion gates |
| Security / live-money safety | 7.5 / 10 | Keep LLMs out of money/config/order/code mutation |

---

## Proposed architecture

### New tables

**`investment_mandates`**
```sql
create table investment_mandates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  market text not null check (market in ('us', 'india')),
  horizon text not null check (horizon in (
    'swing_2_20d', 'position_1_6m', 'long_term_1y_plus', 'income_dividend'
  )),
  benchmark_symbol text not null,
  min_holding_days int,
  max_holding_days int,
  max_position_pct numeric not null default 10,
  tax_sensitivity text not null default 'medium'
    check (tax_sensitivity in ('low', 'medium', 'high')),
  income_preference text not null default 'none'
    check (income_preference in ('none', 'dividend', 'growth')),
  execution_model text not null default 'conservative_close'
    check (execution_model in ('conservative_close', 'optimistic_close')),
  live_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
```

**`strategy_evaluations`** (append-only, trigger-guarded)
```sql
create table strategy_evaluations (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null references investment_mandates(id),
  market text not null,
  evaluated_at timestamptz not null default now(),
  evaluator_version text not null,
  n_trades int not null,
  n_observations int,
  sharpe numeric,
  sortino numeric,
  max_drawdown numeric,
  win_rate numeric,
  expectancy_pct numeric,
  alpha_pct numeric,
  benchmark_symbol text not null,
  cost_adjusted_return_pct numeric,
  slip_vs_modeled_bps numeric,
  walk_forward_folds jsonb,
  passed boolean not null default false,
  pass_reason text,
  fail_reason text,
  created_at timestamptz not null default now()
);
```

**FK additions** (nullable, backfilled post-seed):
- `agent_signals.mandate_id`
- `paper_trades.mandate_id`
- `decision_observations.mandate_id`

---

### Existing code that is REUSED (not rebuilt)

| Asset | What it already does | Change needed |
|---|---|---|
| `lib/analytics/performance-metrics.ts` | sharpe, sortino, maxDD, expectancy, costNet, slip, calibration — all return `Metric{value,n,insufficient}` | No change — call as-is |
| `app/api/agents/performance/metrics/route.ts` | Reads paper_performance + paper_trades, returns full metric set per market | Add `?mandateId=` filter |
| `components/dashboard/PerformanceTruth.tsx` | Full metric tiles + calibration chart + slip display | Add mandate selector + evaluation history table |
| `lib/validation/engine.ts` | Walk-forward replay, block bootstrap, p-value | Add: persist ValidationResult to strategy_evaluations |
| `paper_trades` | Has `expected_price`, `realized_slip_pct`, `fill_status`, `spread_applied`, `data_confidence`, `tainted` | Add mandate_id FK |
| `decision_observations` | Immutable append-only, full feature scores, weights_used | Add mandate_id FK |
| `paper_performance` | NAV, alpha_pct, bench_return_pct per (date, market) | No change |

---

### New code

**`lib/evaluation/run-evaluation.ts`** — deterministic evaluation job:
1. Fetch closed, non-tainted trades for mandate
2. Fetch NAV series from paper_performance
3. Call all existing math functions from performance-metrics.ts
4. Pass/fail gate: n_trades >= 20 AND Sharpe > 0.5 (abstain if data insufficient)
5. INSERT to strategy_evaluations (append-only, no upsert)
6. Returns {passed, failReason, metrics}

**`POST /api/agents/evaluation/run`** — owner-gated, no cron access, calls runEvaluation()

**`GET /api/agents/evaluation/results`** — reads strategy_evaluations, latest first

---

### P1 (separate feature docs, not yet designed):
- ResearchDecision output shape (expectedReturnBps, evidenceQuality, drivers, abstentionReason)
- Conservative paper execution model (stale-quote guard, partial fills, would-not-fill)
- Data quality ledger (source/freshness/confidence per dimension/symbol/day)

---

## Questions for you

### Q1 — Does this architecture reach 10/10 on each dimension?

For each of the 8 dimensions, score the architecture AS PROPOSED above on a 0–10 scale.
State exactly what the proposed architecture fixes, and what it STILL does not fix.

Format:
```
## [Dimension name] — [score]/10
Fixes: ...
Still missing: ...
Minimum additional work to reach 10/10: ...
```

### Q2 — Is the mandate schema complete?

The schema omits:
- `turnover_budget_monthly`
- `max_order_notional_usd / _inr`
- `allowed_asset_types[]`
- `allowed_signal_families[]`

Are these necessary for swing trading to be meaningfully differentiated from "balanced risk profile"?
Which fields are load-bearing vs nice-to-have for a single-user $10k NAV system?
Which fields should be required for an evaluation to be mandate-valid?

### Q3 — Is the pass/fail gate sufficient?

Current gate: `n_trades >= 20 AND Sharpe > 0.5`.

Problems you should identify:
- Is Sharpe 0.5 the right threshold for swing trading?
- Should the gate require walk-forward Sharpe, not in-sample?
- Should max_drawdown be an explicit gate dimension?
- Is the p-value from walk-forward block bootstrap used? If not, what is it for?

### Q4 — Is forward label computation missing?

Current architecture computes metrics FROM existing closed paper_trades (pnl_pct already filled).
It does NOT separately compute forward return labels from decision_observations against
a point-in-time universe.

Is this a gap? Or is using closed paper_trades sufficient for swing-horizon evaluation?
Specifically: if paper fills are at next-close with 5bps spread, is that sufficient
as a cost-adjusted, benchmark-relative label, or does the system need a separate
universe-population forward label computation from decision_observations?

### Q5 — P1 ordering: which fix is highest-leverage next after P0?

Given the three P1 items:
1. ResearchDecision output shape (structured evidence object with expectedReturnBps)
2. Conservative paper execution model (stale-quote guard, partials, would-not-fill)
3. Data quality ledger (source/freshness/confidence per dimension)

Which one most directly improves the learning loop's signal quality?
Which can be done with minimum net-new code given what already exists?
Give a ranked order with reasoning.

---

## Output format

```
## Q1 — Dimension scores

### [Dimension] — [N]/10
Fixes: ...
Still missing: ...
Minimum to reach 10/10: ...

(repeat for all 8 dimensions)

## Q2 — Mandate schema

## Q3 — Pass/fail gate

## Q4 — Forward label gap

## Q5 — P1 ordering

## Updated overall score: X/10
[2-paragraph verdict: does this architecture unblock the 6.0→10.0 path, or not?]
```
