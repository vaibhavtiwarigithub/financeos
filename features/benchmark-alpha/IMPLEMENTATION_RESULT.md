# Benchmark display comparators — implementation result

**Shipped:** 2026-08-24  
**Scope:** P1E display-only extension to the existing Benchmark Alpha scorecard.

## Outcome

- Paper Portfolio exposes one market-local comparison benchmark at a time.
- US: VOO, QQQ, XLK, XLF.
- India: NIFTY 50, NIFTY IT (ITBEES), NIFTY Bank (BANKBEES), NIFTY Next 50 (JUNIORBEES).
- The owner selection persists per market in `app_settings` and becomes the
  next display default.
- `benchmarks.is_primary` remains untouched and authoritative for governed
  analytics. Display selection has no scoring, learning, sizing, fill, or order effect.

## Correctness repair

The original scorecard route defined `upsertProviderObservations()` for
secondary benchmarks but never invoked it. P1E wires that collector into the
daily rollup, using Massive-first/Yahoo-fallback for US and Yahoo daily bars for
India. Portfolio and benchmark rows join only on exact dates; missing sessions
remain missing rather than being forward-filled.

## Data and API

- Migration: `20260824213000_portfolio_benchmark_choices.sql`.
- Preference keys: `portfolio_default_benchmark_us` and
  `portfolio_default_benchmark_india`.
- Owner-gated API: `GET/PATCH /api/portfolio/performance-series`.

## Explicit non-effects

No change to governed primary benchmarks, mandates, ResearchAgent, scoring,
LearnerAgent, promotion gates, risk, paper trades, live proposals, or orders.
