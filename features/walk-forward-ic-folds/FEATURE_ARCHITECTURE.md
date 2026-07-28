# Feature Architecture: Walk-Forward IC Folds

## Status

Architecture status: Draft
Architecture approved: No
Approved scope: None
Approved date: None
Implementation allowed: No

## Feature Purpose

Make `edge_ic_history` windows actual out-of-sample folds, so the promotion gate
in `lib/gates/promotion-gate.ts` can claim out-of-sample validation instead of
estimate stability.

## The problem, measured

Discovered 2026-07-27 by running the promotion gate against prod data.

Every `edge_ic_history` row is an IC computed over `history_days = 1000`. The six
US windows for a given edge span **16 calendar days** end to end
(2026-07-08 → 2026-07-24).

| Fact | Value |
|---|---|
| `history_days` per window | 1000 |
| Span, first → last window_end (US) | 16 days |
| Implied data overlap between first and last window | **~98.4%** |
| Rows vs distinct `window_end` (US, per edge/horizon) | 6 rows, **4** distinct |
| Distinct `run_fingerprint` behind those 6 rows | 6 |
| `universe_size` drift across them | 31 → 32 → 40 |

Consecutive "windows" are the same 1000-day backtest re-run weekly with the end
date nudged forward a few days. They are not folds.

**Three things this breaks:**

1. `MIN_WINDOWS = 3` claims to count "independent IC runs". It counts re-runs.
2. The cross-window IC check was named `walk_forward_pass`. It compares an IC
   over ~Oct-2023→08-Jul-2026 against one over ~Oct-2023→24-Jul-2026. Any
   "decay" it detects is noise from a 16-day endpoint shift plus a changing
   universe — not out-of-sample decay.
3. Waiting does not fix it. Four more weeks moves the overlap from 98.4% to
   ~95.6%. Genuinely disjoint 1000-day windows would need ~8 years.

**What is NOT broken:** the Newey-West `t_stat` *within* a single window,
computed over that window's ~96 as-of dates. That is real evidence and is
unaffected by cross-window overlap. It remains the gate's binding constraint
(best latest t: US 1.73, India 1.04, against a 2.0 hurdle).

## Interim measures already shipped (not this feature)

- Route dedupes by `window_end`, newest `created_at` wins.
- `GateResult.walk_forward_pass` renamed to `ic_stability_pass`; failure code
  `walk_forward_failed` → `ic_stability_failed`. The gate no longer claims a
  property it does not have.
- `strategy_policies.walk_forward_pass` **column** kept as-is; renaming it needs
  a migration on an append-only governance table. Deferred to this feature.

## Scope

This feature includes:
- An IC computation mode that emits **disjoint** folds: fold *k* evaluates only
  as-of dates after fold *k−1*'s last as-of date, with a purge gap of at least
  `horizon` days so a fold's forward-return window cannot leak into the next.
- Persisting fold provenance on each row: `fold_index`, `fold_start`, `fold_end`,
  `is_disjoint`, and the purge gap used.
- Gate changes: require *N* disjoint folds; restore a real walk-forward check
  (fold-over-fold IC decay) alongside the stability check.
- Backfill of existing rows as `is_disjoint = false` so no historical row is ever
  mistaken for fold evidence.

## Non-Goals

- Does not change `analyst_score`, ResearchAgent, PaperTrader, or any order path.
- Does not change the IC formula, the edge registry, or the Newey-West lag rule.
- Does not lower `T_HURDLE`. If disjoint folds make promotion harder, that is the
  correct outcome, not a reason to move the bar.
- No LLM anywhere on this path.

## Current Behavior

`app/api/agents/edge-ic/route.ts` runs on a schedule and, per edge × market ×
horizon × segment, computes one IC over the trailing `history_days = 1000` with
`step_days = 5`, writing a single row keyed on `window_end = today`. Each run
therefore re-reads nearly the same history as the previous run.

## Proposed Behavior

Partition the available history into consecutive, non-overlapping fold windows
and compute one IC per fold. Between folds, purge `horizon` days so a fold's
forward-return labels cannot overlap the next fold's features.

```
|<-- fold 1 -->|purge|<-- fold 2 -->|purge|<-- fold 3 -->|
```

Each scheduled run appends a new fold only when enough *new* data has accrued to
fill one (`fold_days + horizon`). On a run that cannot fill a fold, it writes
nothing new rather than re-emitting the trailing window.

Open question for approval: `fold_days`. With ~1000 days of history and a 20-day
horizon, `fold_days = 250` yields ~3 disjoint folds today; `fold_days = 125`
yields ~7 but each has fewer as-of dates and a noisier per-fold t-stat. This
trades fold count against per-fold power and should be decided explicitly, not
defaulted.

## System Flow

1. edge-ic run starts for (edge, market, horizon, segment).
2. Read the latest persisted `fold_end` for that key.
3. If `today − fold_end ≥ fold_days + horizon`, compute the next fold; else exit
   without writing.
4. Compute IC + Newey-West t over the fold's as-of dates only.
5. Insert with `fold_index`, `fold_start`, `fold_end`, `is_disjoint = true`.
6. Promotion gate reads only `is_disjoint = true` rows when evaluating
   walk-forward; stability continues to use all deduped rows.

## Module Inventory

| Module | Change |
|---|---|
| `lib/edges/ic.ts` | Add fold partitioning + purge gap; keep current mode behind a flag |
| `app/api/agents/edge-ic/route.ts` | Fold-advance decision, write fold provenance |
| `lib/gates/promotion-gate.ts` | Separate `walk_forward_pass` (disjoint folds only) from `ic_stability_pass` |
| `app/api/agents/backtest/promote/route.ts` | Filter evidence to `is_disjoint` when the walk-forward gate is required |
| `supabase/migrations/*` | `edge_ic_history`: `fold_index`, `fold_start`, `fold_end`, `is_disjoint`, `purge_days` |
| `public/agent-diagrams/system-map.json` | Update EDGELAB → POLICYGATE edge semantics |
| `docs/arch/09-learning-loop.md`, `04-database-schema.md` | Document folds |

## Data Architecture

- Required: existing `edge_signals` + candle history. No new provider.
- New columns are additive and nullable; existing rows backfill to
  `is_disjoint = false`.
- Unique index on `(edge_id, market, horizon, segment_type, segment_value,
  fold_index)` to make fold emission idempotent — this is the durable fix for the
  duplicate-window problem the route currently patches at read time.

## Files / Behavior That Must Not Change

- `strategy_policies` append-only triggers and the `promoted_by =
  'deterministic_gate'` CHECK.
- Any order-placement path.
- `T_HURDLE`, `IC_MIN`.

## Risks

- **Fewer folds than expected.** If `fold_days` is set high, there may be only
  2 disjoint folds — below `MIN_WINDOWS`. Promotion then stays blocked. This is
  honest but means the feature does not immediately unblock anything.
- **Per-fold t-stats get weaker,** because each fold has fewer as-of dates than
  the current 1000-day window. Splitting 96 as-of dates across 3 folds leaves
  ~32 each. Given the binding constraint today is already the t-hurdle, disjoint
  folds will likely make promotion *harder*, not easier.
- **Cost.** More IC computations per run.

## Open Questions For Owner

1. `fold_days` — fold count vs per-fold power (see above).
2. Should `MIN_WINDOWS` for the walk-forward gate differ from the stability gate?
3. Do we rename the `strategy_policies.walk_forward_pass` column in the same
   migration, or keep it and add `ic_stability_pass` alongside?
4. Given the risk section — this likely makes promotion strictly harder — is this
   worth building now, or after there is enough history for it to plausibly pass?

## Recommendation

Build **after** there is more history, not now. The feature's value is letting
the gate honestly claim out-of-sample validation; it does not unblock any
promotion, and on current data it would reduce per-fold power and make promotion
harder. The interim rename means nothing is currently overclaiming, which was the
actual risk. Revisit when an edge is close to clearing `T_HURDLE` on a single
window — at that point the walk-forward claim starts to matter.
