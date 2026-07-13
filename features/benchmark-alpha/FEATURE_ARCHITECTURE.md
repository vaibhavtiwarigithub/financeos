# Feature Architecture — Benchmark Alpha Scorecard (multi-horizon, config-driven)

> Status: **PROPOSAL — architecture only, not built.** Needs owner sign-off.
> Last updated: 2026-07-13
> Update the relevant `docs/arch/` chapters (04 schema, 05 crons, 09 learning-loop) + `system-map.json` when built.

## Problem
The agents **grade** strategies vs a benchmark after the fact (`strategy_evaluations.book_alpha_pct`, `promotion_eligible`) and store daily paper alpha (`paper_performance.alpha_pct`), but there is **no always-on, multi-horizon, both-book number** the agents hold and strive to beat. Specifically missing:
1. Rolling alpha at **1W / 1M / 3M / YTD / 1Y** (only daily / since-inception exists).
2. **Live** book alpha (only paper feeds evaluation).
3. Alpha as a **live input** to agent decisions + a **goal** (not just a chart).
4. **Extensible benchmarks** — VOO/NIFTI are effectively hardcoded; adding QQQ/SPY/sector/blend should be a config row.

## Goal
- Always know the excess return vs benchmark, **paper + live, per market, at multiple horizons**.
- Make **risk-adjusted alpha (info ratio) vs a primary benchmark** the north-star the learner optimizes + the promotion gate enforces.
- Adding a benchmark = a config row (no code); one **primary** per market drives the objective, others are comparison-only.

## Data model (Phase 1)

### `benchmarks` (config — the extensibility point)
| Column | Type | Notes |
|---|---|---|
| `market` | text | `us` \| `india` |
| `symbol` | text | benchmark ticker, e.g. `VOO`, `QQQ`, `^NSEI`, `^NSEBANK` |
| `label` | text | display name |
| `is_primary` | bool | exactly ONE primary per market — drives objective/gate |
| `weights` | jsonb | null = single symbol; else a weighted basket `{VOO:0.6, IEF:0.4}` (blend support, later) |
| `enabled` | bool | |
| PK | `(market, symbol)` | |
Seeded: us→VOO (primary), india→^NSEI (primary). RLS owner-read, service-write.

### `benchmark_scorecard` (materialized rollup — the always-on number)
| Column | Type | Notes |
|---|---|---|
| `market` | text | |
| `book` | text | `paper` \| `live` |
| `benchmark_symbol` | text | |
| `horizon` | text | `1W` \| `1M` \| `3M` \| `YTD` \| `1Y` |
| `as_of` | date | rollup date |
| `portfolio_return_pct` | numeric | book return over the window (rebased) |
| `bench_return_pct` | numeric | benchmark return over the same window |
| `excess_return_pct` | numeric | portfolio − bench (the "alpha") |
| `info_ratio` | numeric | excess return / tracking error (risk-adjusted) |
| `n_days` | int | sample size → confidence |
| PK | `(market, book, benchmark_symbol, horizon, as_of)` | |

## Compute (Phase 1 — measurement only, no money-path change)
- A daily rollup (extend the position-monitor / nav-snapshot cron, or a new `POST /api/agents/benchmark-scorecard`) that, for each `(market, book, enabled benchmark, horizon)`:
  1. Loads the book's NAV series — **paper** from `paper_performance(date, nav)`, **live** from `live_performance(account_id, date, equity)` summed per market.
  2. Loads/【computes the benchmark series — single symbol close (Massive US, Kite/Yahoo India), or a weighted basket for blends. Reuse the existing `bench_nav` where the symbol matches; fetch others.
  3. Rebases both to the horizon window → `portfolio_return_pct`, `bench_return_pct`, `excess_return_pct`, `info_ratio` (excess / stdev of daily excess), `n_days`.
  4. Upserts `benchmark_scorecard`.
- **Priceable-only**: a benchmark whose close can't be fetched is skipped with a `log()` note (never a silent gap).
- **Confidence**: horizons with `n_days` below a floor are flagged low-confidence (don't act on 1 week of data — see the phantom-drawdown lesson).

## Surfacing (Phase 1)
- **Dashboard "Alpha Scorecard"**: a grid — rows = horizons, cols = benchmarks, cells = excess % + info ratio, paper vs live tabs, US/India switch. Green/red vs 0.
- **Agent read**: a helper `getAlpha(svc, market, book, horizon, benchmark?)` so any agent can ask "are we beating VOO this month?".

## Objective + feedback (Phase 2 — ARCHITECTURE-GATED, touches the learning loop)
1. **Primary-benchmark objective**: the LearnerAgent's challenger objective + the Performance Truth promotion gate optimize/require **positive info ratio vs the primary benchmark over the mandate `evaluation_horizon_days`** — not just win-rate. (`book_alpha_pct` already exists; make it the primary gate + the learner's stated objective.)
2. **Posture feedback**: persistent underperformance (e.g. `excess_return_pct < −X%` at 3M with `n_days ≥ floor`) shifts risk posture (tighten/size-down) and raises System Health `trailing-benchmark:<market>:<book>` (warn). Recovery clears it.
3. **Goal**: a target in `investment_mandates` (e.g. beat benchmark ≥ Y%/yr, positive monthly info ratio); the scorecard tracks progress; the learner strives toward it.

## Extensibility
- Add a benchmark: insert a `benchmarks` row (symbol + label + enabled). The scorecard tracks it next rollup. No code.
- Change the primary: flip `is_primary` (enforce exactly one per market via a partial unique index). The objective/gate follow.
- Blends: set `weights` (a weighted basket) — the compute builds a synthetic series. Ships after single-symbol.

## Safety / honesty
- Phase 1 is **pure measurement** — additive, no order/paper-trade/learner change.
- Phase 2 changes how the system decides → **architecture-first**, feature-flagged, paper-validated before it can affect live.
- `n_days` confidence gates over-reaction; never trip a real gate on a noisy short window.

## Phasing
- **P1 (safe, build first):** `benchmarks` + `benchmark_scorecard` migrations, rollup cron, dashboard, agent-read helper. Config-driven benchmarks from day 1.
- **P2 (gated, after sign-off):** primary-benchmark objective in the learner + promotion gate, posture/alert feedback, mandate goal.

## Files (P1)
`supabase/migrations/17X_benchmarks.sql` (+ `benchmark_scorecard`); `lib/analytics/benchmark-alpha.ts` (compute + `getAlpha`); `app/api/agents/benchmark-scorecard/route.ts` (rollup) + pg_cron; `components/dashboard/AlphaScorecard.tsx`; docs arch-04/05/09 + system-map. P2 adds learner/evaluation objective wiring + posture reporter (separate).
