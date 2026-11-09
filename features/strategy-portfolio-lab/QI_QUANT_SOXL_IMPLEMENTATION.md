# QI Quant SOXL reference implementation

Date: 2026-11-09. This is a bounded first instrument-specific implementation of the pasted QI Quant contract. It is research-only and does not validate or promote the supplied strategy.

## Built

- Reuses the existing weekly US Learner `strategy_discovery` run and existing append-only `trial_family_ledger`; no new schedule, table, provider, model call, or inference allowance.
- Registers eight frozen, distinct trials before inspecting data: the supplied SOXX/SOXL pullback baseline plus seven fixed VIX filters (three close levels, four one-day change thresholds). The definitions are not fitted or selected against an alleged final holdout.
- Uses SOXX close above its 200-session SMA plus standard Wilder RSI(14) below 35; enters SOXL at the following session open; models 6% stop, 25% target and 15-session time exit.
- Includes adverse cost assumptions of 25 basis points per side and a 50-basis-point-per-side stress. These are explicit research assumptions, not measured historical spread/commission costs.
- Resolves stop gaps at the worse open, same-day stop/target collisions at the stop, favorable target gaps at the target, and does not close before entry or claim a truncated maximum-hold trade as complete.
- Requires valid unique OHLC bars, equal SOXX/SOXL session dates, consistent non-legacy provider/basis/version within those instruments, and at least 230 aligned sessions. VIX is optional for the independent baseline; each VIX variant requires valid, consistently provenanced VIX index bars aligned to every SOXX/SOXL session. Missing or misaligned VIX leaves those variants explicitly `insufficient_data`, never a fabricated zero-trade result. It does not mix data bases or impute dates.
- Persists bounded summary, trial count, source metadata, cutoff and an input hash into the existing `agent_runs.workload_metrics.discovery.soxlReference` record. The owner-only SOXL symbol panel also offers an on-demand read-only replay over the same cache and displays period summaries, VIX comparisons, costs, assumptions and trade ledger.
- The Symbol Research strategy panel now exposes the recorded dimensions, decoded entry/exit variables, exact frozen rule specification, data window, source/basis/provenance versions, benchmark, candidate-universe historical diagnostics, purged development folds, and separate matured per-symbol forward observations. It explicitly labels the historical result as full-universe evidence rather than claiming a symbol-only backtest was run.

## Verification (2026-11-09)

- Focused SOXL replay and registration tests: 8 passed, including missing/misaligned VIX regression cases.
- Full Vitest suite after fast-forwarding to current `origin/main`: 4,770 passed, 8 skipped across 586 passing test files (one skipped).
- `npm run build`: passed compilation, lint/type validation, static generation for all 77 pages, and trace collection.
- Changed-file secret-pattern scan and scoped `git diff --check`: passed.
- No production endpoints, database routes, scheduled jobs, broker APIs, or trading actions were invoked. Production acceptance remains pending the next natural weekly US Learner cycle.

## Interpretation and current gates

The 2022–2024 and 2025–2026 periods were already shown in the user-provided research example and are both labeled selection-exposed. They are descriptive calendar buckets, not training/validation/final holdout splits. VIX subgroups are predeclared diagnostics; small or empty samples are not interpreted as evidence. The trade-sequence drawdown compounds each sequential trade at full notional and is not a portfolio drawdown or account P&L.

The automatic cycle reads only `price_cache`. It can report `insufficient_data` for short SOXX/SOXL history, mixed/legacy SOXX/SOXL provenance, or non-aligned SOXX/SOXL sessions. Missing, mixed, legacy, or non-aligned VIX now blocks only the seven VIX variants; it does not block the VIX-free baseline. The code version and trial family were advanced to v2 so this changed data contract cannot be confused with v1. The cycle does not fetch new history, call Alpaca, reconstruct point-in-time macro/news data, or bypass data entitlements. This implementation does not certify completeness of every exchange session or historical corporate-action adjustment quality beyond the cache provenance contract.

The result does not feed the composite research score, dimension formula, strategy selector, paper/live portfolio, orders, risk settings or broker. General symbol-universe discovery remains bounded to existing market-local candidates; this reference does not mean Kairos backtests every supported ticker. Untouched holdout, purged walk-forward validation, broader robust strategy ranking, full cost/liquidity modeling, and authorized all-symbol coverage remain separate gates. No profitability or production effectiveness claim is made until natural cycles persist sufficient verified data and later forward labels mature.
