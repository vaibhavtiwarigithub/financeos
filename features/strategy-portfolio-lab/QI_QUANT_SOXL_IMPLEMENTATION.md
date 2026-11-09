# QI Quant SOXL reference implementation

Date: 2026-11-09. This is a bounded first instrument-specific implementation of the pasted QI Quant contract. It is research-only and does not validate or promote the supplied strategy.

## Built

- Reuses the existing weekly US Learner `strategy_discovery` run and existing append-only `trial_family_ledger`; no new schedule, table, provider, model call, or inference allowance.
- Registers eight frozen, distinct trials before inspecting data: the supplied SOXX/SOXL pullback baseline plus seven fixed VIX filters (three close levels, four one-day change thresholds). The definitions are not fitted or selected against an alleged final holdout.
- Uses SOXX close above its 200-session SMA plus standard Wilder RSI(14) below 35; enters SOXL at the following session open; models 6% stop, 25% target and 15-session time exit.
- Includes adverse cost assumptions of 25 basis points per side and a 50-basis-point-per-side stress. These are explicit research assumptions, not measured historical spread/commission costs.
- Resolves stop gaps at the worse open, same-day stop/target collisions at the stop, favorable target gaps at the target, and does not close before entry or claim a truncated maximum-hold trade as complete.
- Requires valid unique OHLC bars, one verified provider/basis/version per instrument, matching SOXX/SOXL raw-versus-adjusted basis, and at least 230 aligned sessions. It excludes and reports legacy/unprovenanced rows, then uses only the exact SOXX/SOXL date intersection; extra dates are counted and never imputed. Conflicting verified provenance, duplicate sessions, or invalid OHLC still block the base replay. VIX is optional for the independent baseline; each VIX variant requires valid, consistently provenanced VIX index bars aligned to every SOXX/SOXL session. Missing or misaligned VIX leaves those variants explicitly `insufficient_data`, never a fabricated zero-trade result.
- Persists bounded summary, trial count, source metadata, cutoff and an input hash into the existing `agent_runs.workload_metrics.discovery.soxlReference` record. The owner-only SOXL symbol panel also offers an on-demand read-only replay over the same cache and displays period summaries, VIX comparisons, costs, assumptions and trade ledger.
- The Symbol Research strategy panel now exposes the recorded dimensions, decoded entry/exit variables, exact frozen rule specification, data window, source/basis/provenance versions, benchmark, candidate-universe historical diagnostics, purged development folds, and separate matured per-symbol forward observations. It explicitly labels the historical result as full-universe evidence rather than claiming a symbol-only backtest was run.
- The replay builder now filters and counts unprovenanced legacy rows, forms the exact verified SOXX/SOXL date intersection, and counts valid one-instrument-only dates without filling prices. Conflicting verified provenance, duplicate dates, invalid paired OHLC and insufficient overlap still stop the calculation. The same cohort builder is used by the natural discovery cycle and owner-only on-demand replay; the UI reports retained sessions and exclusions.

## Verification (2026-11-09)

- Focused SOXL replay and registration tests: 8 passed, including missing/misaligned VIX regression cases.
- Full Vitest suite after fast-forwarding to current `origin/main`: 4,770 passed, 8 skipped across 586 passing test files (one skipped).
- `npm run build`: passed compilation, lint/type validation, static generation for all 77 pages, and trace collection.
- Changed-file secret-pattern scan and scoped `git diff --check`: passed.
- The read-only production cache contains 285 aligned, verified SOXX/SOXL sessions, 29 excluded legacy SOXL rows, 14 verified unmatched SOXL sessions, and no VIX series. The baseline has enough paired sessions for its 230-session minimum; all VIX variants must remain insufficient.
- No production endpoints, database routes, scheduled jobs, broker APIs, or trading actions were invoked. Production persistence remains pending the next natural weekly US Learner cycle.

## Interpretation and current gates

The 2022–2024 and 2025–2026 periods were already shown in the user-provided research example and are both labeled selection-exposed. They are descriptive calendar buckets, not training/validation/final holdout splits. VIX subgroups are predeclared diagnostics; small or empty samples are not interpreted as evidence. The trade-sequence drawdown compounds each sequential trade at full notional and is not a portfolio drawdown or account P&L.

The automatic cycle reads only `price_cache`. It can report `insufficient_data` for short paired SOXX/SOXL history or conflicting verified provenance. Legacy rows are excluded before replay and counted; clean but unpaired dates are excluded to form the exact intersection, not filled. Missing, mixed, legacy, or non-aligned VIX blocks only the seven VIX variants; it does not block the VIX-free baseline. The code version and trial family were advanced to v2 so this changed data contract cannot be confused with v1. The cycle does not fetch new history, call Alpaca, reconstruct point-in-time macro/news data, or bypass data entitlements. This implementation does not certify completeness of every exchange session or historical corporate-action adjustment quality beyond the cache provenance contract.

## Production cache readiness check (2026-11-09)

A read-only cache query found 285 verified adjusted SOXX sessions and 299 verified adjusted SOXL sessions, of which exactly 285 are paired; 14 clean SOXL-only dates and 29 older legacy SOXL rows are excluded. No VIX row is currently available, so the VIX-free baseline can be attempted while all seven VIX variants must remain `insufficient_data`. The latest natural US `strategy_discovery` run is still November 6 and predates this correction. No replay route or scheduled job was manually invoked; persistence of the next natural cycle remains the runtime acceptance gate.

The result does not feed the composite research score, dimension formula, strategy selector, paper/live portfolio, orders, risk settings or broker. General symbol-universe discovery remains bounded to existing market-local candidates; this reference does not mean Kairos backtests every supported ticker. Untouched holdout, purged walk-forward validation, broader robust strategy ranking, full cost/liquidity modeling, and authorized all-symbol coverage remain separate gates. No profitability or production effectiveness claim is made until natural cycles persist sufficient verified data and later forward labels mature.
