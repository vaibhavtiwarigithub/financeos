# Strategy Portfolio Lab

> Status: Approved for P0 implementation. Owner reconfirmed the shared
> paper/live evidence requirement on 2026-09-13; this remains non-executing:
> no score, paper fill, live proposal, exit, sizing, or broker activation.
> Date: 2026-08-02

## Implementation reconciliation — 2026-10-30

The production strategy-template shadow path is **not operational**. A read-only
query confirmed `strategy_templates` and `register_trial(...)` exist, while
`strategy_template_shadow_configs`, `strategy_template_shadow_events`, and
`create_strategy_template_shadow_config(...)` are absent. The old migration
preflight remains authoritative: production migration lineage diverges from
this checkout, so do not force migration history or apply the feature schema
until the canonical deployment migration set is recovered and reconciled.

Code now includes a strict, deterministic daily-rule compiler and the Learning
page exposes producer deployment state separately from an empty experiment
queue. The API compiles from the stored template row; callers cannot submit an
arbitrary rule spec. It refuses unsupported rule keys and the not-yet-approved
combination compiler. Focused compiler/schema-status tests pass. These code
changes do **not** mean that shadows are collecting or that a strategy has been
measured.

The seven current production templates were inspected. None is currently
compilable in full: the technical templates also include unsupported 52-week or
Bollinger rules, while the others include fundamental, insider, sentiment, or
valuation rules that daily OHLCV alone cannot reproduce. The compiler rejects
the whole template rather than silently discarding conditions. No candidate is
eligible to enter a meaningful tournament until its complete point-in-time
inputs are available and its source semantics are represented by a versioned
deterministic rule.

### Remaining gates

1. Recover/reconcile the authoritative production migration lineage. Do not
   bypass it with raw SQL, a new timestamp that hides the missing history, or a
   migration-history repair.
2. Provide complete, point-in-time source fields for any template rules that
   require more than daily OHLCV, or explicitly define new templates whose
   entire rule set can be calculated from the approved historical feed.
3. Deploy the immutable config/event ledger and lifecycle RPC through the
   reconciled migration process; verify per-market capacity and append-only
   invariants.
4. Connect registered configs to the existing deterministic validator and
   matched, cost-aware portfolio replay; persist decision overlap and matured
   net outcomes against the same deterministic dimension baseline.
5. Run a natural forward shadow cohort and retain insufficient status until
   labels mature. No automatic strategy selection, score changes, champion
   promotion, paper/live position change, or order is permitted.

The separate `systematic-pattern-discovery` proposal remains parked. It is not
enabled by this bounded template-lab implementation because its survivorship,
historical source, and multiple-testing prerequisites remain unresolved.

## Decision

Turn a selected Strategy Library template into an immutable, market-local strategy
version that can validate and collect non-executing shadow decisions beside the
champion. Templates remain reference material until explicitly admitted to this lab.

## Boundaries

- US and India versions, evidence, limits, and comparisons never mix.
- At most **three total** active template shadows per market; a predeclared
  combination challenger counts as one of the three. This conservative capacity
  decision prevents sample starvation and supersedes the earlier ambiguous
  “three plus one” wording.
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
