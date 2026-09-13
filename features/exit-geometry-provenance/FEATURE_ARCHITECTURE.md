# Exit-geometry provenance and shadow-baseline repair

> Status: **APPROVED — paper-only evidence repair.** Owner approval: 2026-09-12.
> Money-path influence: **none.** This work records and measures the incumbent;
> it does not alter a stop, target, sizing rule, paper exit, live order, or broker setting.
> Implementation result: 2026-09-12 — complete locally; 2,664 tests pass and
> TypeScript is clean. The isolated Next build was stopped after an extended
> silent OneDrive/Webpack compile, so no build pass is claimed.

## Why

Kairos resolves entry geometry from either the market mandate or the
market-local, entry-candidate MAE/MFE ledger. The chosen values are bound to a
fill, but the existing journal record omits the percentile values, horizon,
mandate version and calculation time needed to reproduce that decision.
Separately, the general exit-geometry shadow still uses a stale hard-coded
7.5%/19.2% baseline even though execution uses a different market-local plan.
A shadow cannot judge a policy it did not actually measure.

## Scope

1. Extend the in-memory execution-risk result with an immutable provenance
   object: mandate inputs/version, resolved horizon, observed-at time, sample
   count, and, for a ledger result, the actual MAE/MFE percentile values and
   percentile parameters.
2. Write that object into append-only `pipeline_stage_events.risk_plan` detail
   for paper and autonomous-live proposal creation. It is evidence only;
   existing tables and executions remain authoritative.
3. Make the read-only geometry-shadow endpoint load each market's current
   mandate rather than embed 7.5%/19.2%. It must stamp the baseline source and
   explicitly report that it measures a mandate baseline, not a reconstruction
   of historical per-entry plans.
4. Correct stale comments and tests that still claim 7.5%/19.2% is live.

## Deliberate limits

- Do not turn an ATR multiplier, structural low, fundamental score, volume
  profile, or R multiple into a stop/target rule.
- Do not use a current percentile calculation to rewrite history or claim it
  was the plan used by an older trade.
- Do not persist a new table or migration: `pipeline_stage_events` is already
  the append-only decision journal and the change is additive JSON.
- Do not make the general shadow a promotion gate. It remains read-only and
  must continue to refuse ambiguous barrier ordering.

## Acceptance criteria

- [x] A newly created risk-plan event contains a versioned provenance snapshot;
  malformed/missing learned data is visibly represented as a mandate fallback.
- [x] Paper and autonomous-live proposal paths use the same provenance constructor.
- [x] Geometry-shadow results contain no hard-coded 7.5%/19.2% incumbent and state
  the exact baseline used for each market.
- [x] Tests prove no input can silently turn invalid learned values into a ledger
  plan, and prove a supplied market mandate changes the shadow baseline.
- [x] Typecheck and relevant tests pass. No production migration or trade occurs.
