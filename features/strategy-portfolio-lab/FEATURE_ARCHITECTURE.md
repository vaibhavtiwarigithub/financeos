# Strategy Portfolio Lab

> Status: Approved for P0 implementation; no score, paper, live, exit, sizing, or broker activation.
> Date: 2026-08-02

## Decision

Turn a selected Strategy Library template into an immutable, market-local strategy
version that can validate and collect non-executing shadow decisions beside the
champion. Templates remain reference material until explicitly admitted to this lab.

## Boundaries

- US and India versions, evidence, limits, and comparisons never mix.
- At most three active template shadows per market; at most one predeclared
  combination challenger per market.
- A combination is declared before its first validation run and increments the
  market trial-family count. No search across arbitrary template combinations.
- The canonical scorer, PaperTrader, PositionMonitor, cash, positions, exits,
  Router, and broker paths never read template-shadow output.
- A passed backtest is eligibility evidence only. Promotion remains governed by
  the existing dormant OOS gate and owner-only RPC.

## P0 Build

1. Add a service-only `strategy_template_shadow_configs` ledger: market, template
   id(s), immutable config fingerprint, state (`draft|validating|shadow|paused|
   retired`), declared trial family, and owner audit fields.
2. Compile one selected template into a `strategy_versions` challenger with frozen
   entry/exit rules and source-template lineage; reject any rule not represented
   by Kairos' deterministic grammar.
3. Reuse existing deterministic validation and `shadow_decisions`; do not create a
   second evaluator or price path.
4. Add a Learning comparison view: champion versus each shadow, decision overlap,
   would-enter count, turnover proxy, validation result, latest shadow evidence,
   and explicit “insufficient evidence” until forward outcomes mature.
5. Label Strategies as manual research tools until a template has an active shadow.

## Evidence and recommendation

The system may recommend only: continue collecting, pause/retire for a deterministic
failure, or submit for owner review. It cannot recommend activation from the best
historical result without the declared trial-family multiple-testing adjustment,
PIT walk-forward evidence, and forward shadow outcomes.

## Build order

P0 schema/config + template compiler; P1 shadow comparison UI; P2 predeclared
combination compiler; P3 only after promotion-grade OOS evidence exists.

## Acceptance

- A template shadow cannot write a signal, fill, proposal, exit, or order.
- Attempts beyond the per-market limits fail atomically.
- Every candidate and combination has frozen source/config/trial provenance.
- Comparison never sums USD and INR evidence.
- Disabling or retiring a shadow preserves history and immediately stops new rows.
