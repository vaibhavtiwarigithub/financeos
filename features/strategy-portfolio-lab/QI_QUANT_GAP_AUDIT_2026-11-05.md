# QI Quant autonomous strategy system — gap audit

Date: 2026-11-05. Scope: reconcile the owner's pasted QI Quant specification with the current repository, the approved November 3 discovery architecture, and read-only production evidence. This is an implementation audit, not evidence of strategy performance.

## Summary

Kairos has substantial reusable pieces, but it is **not yet the per-symbol, end-to-end autonomous strategy research system in the pasted specification**. The November 3 approved loop is narrower and intentionally bounded: weekly market-local discovery, a small recently researched cohort, fixed reference/dimension trials, at most one optional LLM candidate, deterministic cached-bar screening, and natural per-symbol forward shadow collection. It does not promise a separate strategy generation/backtest for every ticker, broad parameter optimization, three-model debate, or automatic trading.

Production evidence on November 5:

| Evidence | Observed state | Meaning |
|---|---|---|
| `strategy_template_shadow_configs` | 0 rows | No candidate is currently collecting strategy shadow decisions. |
| `strategy_template_shadow_decisions` | 0 rows | No candidate-specific per-symbol forward decisions have been recorded. |
| `strategy_template_shadow_outcomes` | 0 rows | No matured strategy-shadow outcome exists. |
| `strategy_discovery` runs, last 30 days | 0 rows | The post-expansion deterministic discovery child producer has not yet established a natural production cycle. |
| Latest learner rows | US and India on Oct 30, before the Nov 3 discovery release; both summaries said 0 LLM hypotheses | These rows do not verify the new deterministic discovery path. |

The bounded symbol-evidence UI slice has since shipped in commit `b50df20402312584148b389d859a44547c5118cc` and Vercel production deployment `dpl_2GSWEqD9JR3YYtt7ApiKocE4Jf8y` (READY). `/login` returned 200 and the unauthenticated symbol-shadow API returned 401. This deployment does not change the production counts above or verify a natural discovery cycle; the full QI Quant engine remains incomplete.

The standard price cache is not sufficient to reproduce the illustrative SOXL study as specified. Current read-only counts:

| Symbol | Bars | Earliest–latest | Basis/provenance |
|---|---:|---|---|
| SOXL | 327 | 2025-07-22–2026-11-05 | Mixed `adjusted`/`unknown`; mixed provenanced/unprovenanced rows |
| SOXX | 284 | 2025-09-22–2026-11-05 | Adjusted, Yahoo, v1 provider-basis |
| SPY | 327 | 2025-07-22–2026-11-05 | Mixed `adjusted`/`unknown`; mixed provenanced/unprovenanced rows |

Those cached series do not cover 2022–2024, do not share an identical start date, and contain mixed/unprovenanced rows for SOXL and SPY. The existing strategy replay fails closed on mixed bases. No SOXL performance result is calculated from them.

## Existing reusable capabilities

- `lib/strategy-replay/rule-spec.ts` is a declarative, fingerprintable hypothesis format. It supports OHLC-derived SMA, legacy and Wilder RSI, rolling range/high, and same-session recorded dimension observations; it enforces next-open execution for close-derived entry rules.
- `lib/strategy-replay/compile.ts` produces deterministic next-bar events and records flat-state decisions. It is price/dimension rule compilation, not a stop/target intrabar event engine.
- `lib/strategy-replay/template-backtest.ts` reuses the app's portfolio simulator and NAV marker for fixed-cost, equal-weight, temporal holdout and descriptive fixed-origin folds. It does not fit parameters, model a stop/target collision from daily OHLC, or emit a reproducible per-trade stop/target trade ledger.
- `lib/strategy-replay/autonomous-template-discovery.ts` freezes a market-local recently researched universe (maximum 10 symbols per asset class), registers trials before screening, runs a bounded deterministic historical diagnostic, and can start a shadow only after its fixed screen. `reference-discovery.ts` adds a bounded continuation worklist.
- The natural ResearchAgent collector can persist candidate decision observations and later labels per symbol; Learning already owns the discovery funnel. No per-symbol LLM call is required or permitted for this flow.
- Existing instrument taxonomy, market-local benchmark registry, leveraged ETF risk, daily SOXL door, paper exit engine, macro/market data, and multiple-provider/model infrastructure can inform a later instrument-specific research contract. These components do not themselves create or validate strategies.

## Material gaps versus the pasted specification

1. **Symbol coverage and progress:** no user-selected-symbol/horizon job path; the current automatic candidate universe is capped at 10 recently researched names per asset family. It can truthfully say no candidate matches a symbol, but it does not test every supported symbol.
2. **Cross-instrument signal attribution:** the current rule spec applies signals to and trades the same symbol. The SOXL hypothesis uses SOXX and VIX to decide an SOXL trade. That contract cannot be represented without an explicit signal-instrument/execution-instrument mapping.
3. **Execution realism:** the generic daily replay does not model stop-loss/target fills, same-bar collisions, gap-through stops, partial fills, liquidity, spread/commission schedules, or exact trade-by-trade MFE/MAE. A fixed slippage fraction is not sufficient to certify the sample SOXL returns.
4. **Indicator and event coverage:** volume/sector breadth, volatility term structure, instrument calendars, and PIT macro/news releases are not all available in the rule grammar. Current macro data must not be backfilled with today's revised values.
5. **Data:** existing cached SOXL/SOXX/SPY histories fail the range/basis/provenance requirements above. Alpaca is connected in the app/tool environment, but its supported historical entitlement/feed and an app-persisted, reproducible licensed corpus have not been verified for this study. The MCP connector alone does not establish the deployed app's data entitlement or a durable app ingestion path.
6. **Optimization and independent validation:** the current automatic loop is a small fixed trial schedule, not the pasted bounded coarse-to-fine search, stress tests, purged walk-forward/untouched final test, or bootstrap/multiplicity-adjusted ranking system. The SOXL 2025–2026 sample is already selection-contaminated by the supplied account and cannot be called an untouched test.
7. **Multi-model orchestration:** existing model integrations serve other app roles; no approved strategy-specific Claude/Codex/DeepSeek three-way proposal-and-critique workflow is implemented. Activating that workflow changes inference policy/budget and is outside the current shadow design.
8. **Production acceptance:** there is no natural post-release discovery cycle or shadow outcome evidence yet. A historical diagnostic, successful code path, or `promising` label cannot stand in for that evidence.

## Sequencing consistent with the user request and current authority

### Phase 1A — foundation and reproducibility (current work)

- Finish the symbol detail evidence view over the existing candidate/config, decision, outcome, and trial/run records; represent no run, no matching hypothesis, unsupported input, blocked/insufficient replay, pending label, and matured descriptive evidence separately.
- Keep candidate-level backtests separate from one-symbol forward outcomes; do not turn an LLM claim into a result.
- Add focused regression tests for filtered symbol reads, stale/absent evidence semantics, and simulator assumptions.
- Specify a reproducible SOXL/ SOXX / SPY input snapshot with provider/feed, adjustment and corporate-action provenance before calculating returns. Treat missing/insufficient licensed history as a blocker, not a reason to silently substitute data.
- Audit generic replay semantics and add execution tests only for already-supported deterministic behavior. Do not represent an OHLC stop/target fill engine as built when it is not.

### Phase 1B — SOXL test contract (architecture gate before implementation)

Define separately versioned dual-symbol signal/target contract, market sessions, next-session fill, gap/stop/target collision rules, cost schedule, data-basis normalization, trade/portfolio ledger, benchmark set and reproducible chronological partitions. Independently calculate and test Wilder RSI. First target is reproduction/audit of the supplied illustrative ranges, not tuning or claiming the reported numbers.

### Later phases requiring separate architecture and any applicable approvals

- User-selected per-symbol queues and larger symbol coverage (compute and market-data workload assessed first).
- More complex portfolio/partial-fill or intraday execution engine.
- Broader optimizer, purged walk-forward/untouched validation and formal strategy score.
- Strategy-specific multi-LLM roles and inference budget.
- Any candidate entering a paper money path, and any live enablement, remain under separate existing gates. No strategy is auto-promoted by successful research.

No new schedule, provider, paid service, schema, model call, account permission, trading behavior or live setting was changed during this audit.
