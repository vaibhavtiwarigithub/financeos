# Strategy Portfolio Lab

## Autonomous Strategy Discovery Addendum — owner direction 2026-10-30

The owner has clarified that strategy research must run without per-candidate
selection or approval. The old manual-start and owner-promotion rules below are
superseded for the *research and paper* lifecycle by this addendum. They remain
in force for live trading and for any action outside the verified account/risk
mandate.

### Required autonomous lifecycle

1. On a bounded scheduled cadence, the configured Kairos LLM proposes a small
   number of falsifiable strategy hypotheses using only the versioned app data
   packet and the allowlisted deterministic rule grammar. The model may not emit
   executable code, change risk limits, or bypass the compiler. Preserve model,
   prompt, grammar, data cutoff, and hypothesis fingerprints.
2. Reject malformed, unsupported, duplicate, cross-market, or over-capacity
   candidates automatically. Run deterministic point-in-time replay, realistic
   costs, benchmark/no-trade comparisons, stress/regime slices, and multiple-
   testing accounting. Historical cache diagnostics alone are never promotion
   evidence.
3. Automatically start qualifying versions in bounded forward shadow. The
   natural market-local research pipeline collects decisions and matured
   outcomes; do not add a high-frequency schedule or write transient quotes to
   Postgres just to generate more rows.
4. A deterministic selector evaluates the frozen candidate against the
   incumbent on matched opportunities and matured, non-overlapping forward
   evidence. It can retain, pause, retire, or select a *paper* challenger only
   after predeclared sample, confidence, net-of-cost, drawdown, robustness, and
   integrity gates all pass. Insufficient or conflicting results leave the
   incumbent unchanged. Keep immutable audit events and an immediate rollback
   to the prior paper champion.
5. Surface status, blockers, evidence, and the selected version on Learning;
   owner participation is observational and is not a per-candidate gate.

### Execution boundary

- This addendum authorizes autonomous discovery, validation, shadow operation,
  and evidence-gated paper-strategy selection. It does not authorize a live
  strategy promotion or broker action by itself.
- Live activation still requires the complete owner-approved mandate and every
  account, reconciliation, quote, idempotency, protective-order, exposure,
  kill-switch, and lease prerequisite in `features/agentic-quant-platform`.
- Strategy selection is distinct from dimension-weight selection. Existing
  `strategy_versions.is_champion` is consumed by the scoring-weight resolver;
  it must not be relabeled as an entry/exit strategy champion. The selected
  rule strategy needs its own explicit, market-scoped consumer in the paper
  execution path before it can be described as “used.”
- LLM-generated prose never counts as evidence. LLMs generate hypotheses and
  summarize stored results; deterministic evaluators alone own state changes.
- No changes to the existing deterministic score, council roster/prompts,
  position sizing limits, account settings, or live enablement are implied.

### Acceptance and implementation status

- No owner action is needed to register/start each candidate; the scheduled
  producer performs those actions under the bounded policy.
- US and India candidate families, labels, benchmarks, and selections remain
  isolated.
- Duplicate schedule delivery is idempotent; a failure to read or persist
  evidence fails closed and raises System Health.
- A candidate cannot reach paper selection on historical-fit results alone.
- Losing, immature, or data-degraded candidates never replace the incumbent.
- The existing 2026-10-30 implementation does **not** satisfy this addendum:
  templates are fixed, registration and shadow start are owner-operated, and
  the outputs do not feed paper strategy execution. Implementation and
  production verification are outstanding.

## Implementation checkpoint — 2026-10-30

The first autonomous lifecycle slice now closes the existing **LLM dimension-
weight challenger** loop: LearnerAgent already creates market-local immutable
challengers; deterministic walk-forward validation and natural shadow decisions
already exist. The new weekly selector records append-only maturity snapshots,
compares each challenger with the active scoring baseline on the same matured
observation IDs, uses exactly the first 20 horizon-spaced windows, and invokes a
database-serialized selector only after the forward gate passes. It automatically
retires a fully matured failed weight challenger, retains the incumbent on
insufficient labels, and promotes a pass to the **paper scoring champion**.
Historical labels already contain the app's cost adjustment; the selector must
not subtract cost twice. The owner UI reports maturity and automatic selection
status, and the old validation-only manual promotion path is closed by the new
database gate. This cannot alter live settings or place orders.

This checkpoint does **not** complete the wider strategy-rule platform above.
The existing price-rule template lab still has owner-operated registration and
shadow start, and its rule decisions/outcomes have no selected-rule consumer in
PaperTrader. The automatic selector described in this checkpoint applies to
dimension-weight challengers only; it must not be presented as autonomous entry/
exit pattern discovery or as proof of realized portfolio P&L. Rule-level LLM
hypothesis generation, bounded point-in-time replay, automatic rule shadow
registration, a matched forward portfolio evaluator, and a separate paper-only
rule strategy consumer remain unimplemented and require their own validated
acceptance path. No forward shadow candidate has been run or promoted by coding
tests.

> Status: Approved for P0 implementation. Owner reconfirmed the shared
> paper/live evidence requirement on 2026-09-13; this remains non-executing:
> no score, paper fill, live proposal, exit, sizing, or broker activation.
> Date: 2026-08-02

## Implementation reconciliation — 2026-10-30

The approved P0 flow is implemented in a forward-only migration and the
Learning → Strategy discovery & forward tournament panel. Production migration
lineage was read directly: the latest applied migration was `20261029161600`,
and the four strategy-shadow objects were absent. The new migration follows that
version; it does not edit or mark older migrations as applied. Current apply,
deployment, and natural-run verification evidence is recorded in
`IMPLEMENTATION_RESULT.md`.

The workflow is intentionally bounded: compile the three fully price-based
templates supported by the deterministic grammar, run a 70/30 temporal
historical comparison on cached daily bars, and register a frozen diagnostic
draft with the trial-family ledger. Historical cache data are
survivorship-selected and may be retrospectively adjusted; results are
diagnostics, not promotion evidence. The universe is limited to ten symbols and
three active or draft configurations per market. Unsupported rule fields stay
visible and are never dropped.

An owner explicitly starts a forward shadow after the priced historical
holdout gate. Natural market-local ResearchAgent runs append one immutable
decision per configuration/symbol/session. Outcomes mature from next-session
open through the exact declared horizon exit, with modeled entry/exit cost and
source/basis provenance. The Learning panel compares the rule with deterministic
entry eligibility on the same observations and reports label maturity, overlap
groups, and benchmark trend/volatility price proxies. Those proxies are not
macroeconomic regimes. No result enters scoring, paper positions, proposals,
sizing, exits, or broker paths; there is no automatic promotion.

The broad `systematic-pattern-discovery` proposal remains separate and parked.
This lab does not ingest arbitrary external strategies, optimize thresholds, or
search combinations. It provides a measured, versioned starting point without
claiming a profitable edge.

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
