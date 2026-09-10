# Live Exit Ladder Parity — Architecture Proposal

> Status: DRAFT / PROPOSED — not approved, not built.
> Owner-directed 2026-09-09, sequenced ahead of Guardian Stage 1 and any live
> enablement: "before any live enablement, build live partial-exit/ladder
> parity and test it against the paper behavior."
> Money path: YES. This changes how live positions are exited.

---

## 1. The gap, precisely

| behavior | paper (`position-monitor`) | live (`live-exit-monitor`) |
|---|---|---|
| stop exit | yes, trailing | yes, **fixed** |
| target exit | **partial** (sell half, keep runner) | **full close** |
| runner protection after partial | stop raised to `max(entry, trailing)` | n/a |
| trailing stop | `max(prev stop, highest × anchorPct)` | none — stop never moves |
| trail distance | position's own `initial_stop_loss / avg_cost` | n/a |
| highest-price tracking | persisted `highest_price` | none |
| time stop | yes | yes |

So a live winner that reaches target is fully closed; the paper equivalent
banks half and lets the rest run behind a breakeven-or-better stop. A live
winner that runs never tightens its stop at all — it keeps its original stop
from entry indefinitely.

## 2. The real obstacle: live positions have no persistent state

This is why the gap exists, and it is the whole design problem.

`paper_positions` is a mutable row per position carrying `highest_price`,
`stop_loss` (moved as it trails), `initial_stop_loss` (immutable anchor), and
`price_target`. `position-monitor` reads it, computes, and writes the new
trailing stop back each run.

Live has no such row. `reconstructAccountLivePositions`
(`lib/trading/live-position-ledger.ts`) rebuilds positions **statelessly from
`broker_orders` fills** every run — FIFO lot consumption, average entry
derived from buy fills, policy read from each lot's `policy_snapshot`. Nothing
about the position's *history since entry* survives between runs.

Two consequences that make this more than "add a partial-sell branch":

1. **A partial-target rule would re-fire every run.** With no memory that half
   was already sold, the monitor would sell half of the remainder every 15
   minutes while price stayed above target — bleeding the position out in
   fractions. The FIFO reconstruction does see the SELL fill and reduces qty,
   but nothing marks *why* it was sold, so the rule can't distinguish "already
   took profit here" from "fresh position at target."
2. **Trailing requires a persisted high-water mark.** Recomputing the highest
   price seen since entry from bars each run is possible but is a different
   (and more expensive) mechanism than paper's, and would diverge the moment
   bar coverage has a gap.

## 3. Design

### 3.1 Reuse the paper ladder math verbatim — do not reimplement

`paperPartialTargetQuantity` and `paperRunnerStopPrice`
(`lib/trading/paper-quantity.ts`) are already pure, already tested, already
market-aware (India whole-share floor vs US fractional scale). Live calls the
same two functions. **Any divergence in ladder arithmetic between paper and
live would be a bug by construction if these are shared — which is exactly the
property parity requires.** No second implementation.

### 3.2 Add the missing state, minimally

A new table `live_position_state`, one row per (account, symbol), holding only
what reconstruction cannot derive:

```sql
create table live_position_state (
  account_id   text not null,
  symbol       text not null,
  highest_price      numeric,      -- trailing anchor since entry
  trailing_stop      numeric,      -- last computed stop; never lowered
  partial_taken_at   timestamptz,  -- non-null = partial target already fired
  partial_qty        numeric,      -- what was sold at partial, for audit
  opened_at          timestamptz not null,  -- guards stale rows across re-entries
  updated_at         timestamptz not null default now(),
  primary key (account_id, symbol)
);
```

`opened_at` is the guard against the re-entry trap: if the reconstructed
position's `firstBuyAt` is newer than the stored `opened_at`, the row is
stale (position was fully closed and re-entered) and must be reset, not
inherited — otherwise a new position would start life believing profit was
already taken.

### 3.3 Exit precedence — identical to paper, in the same order

1. **Stop** (trailing, never lowered) → full close.
2. **Target** and no `partial_taken_at` → sell `paperPartialTargetQuantity`,
   set stop to `paperRunnerStopPrice(entry, trailingStop)`, stamp
   `partial_taken_at`.
3. **Target** and `partial_taken_at` already set → no action (the runner is
   managed by the trailing stop from here, same as paper).
4. **Time stop** → full close.

Trailing stop is recomputed every run as
`max(stored trailing_stop, highest_price × anchorPct)` where `anchorPct`
derives from the lot's own policy stop distance — matching paper's
`initial_stop_loss / avg_cost` logic rather than a hardcoded percentage.

### 3.4 Live-specific hazard paper does not have: partial fills

Paper exits are synthetic and always fill completely. A live partial-target
SELL can fill partially or not at all. The stamp must therefore be written
**from the observed fill**, not at submission — otherwise a rejected partial
marks the position as "profit taken" and permanently disables its target
branch. Proposal: stamp `partial_taken_at`/`partial_qty` only after the SELL
appears as `filled`/`partially_filled` in `broker_orders`, reconciled on the
following run.

## 4. Testing parity — the actual acceptance bar

The owner's framing was "test it against the paper behavior." Concretely:

A shared fixture of price paths (runner, stop-out, gap-through-stop,
target-then-reverse, target-then-continue) is driven through **both** engines'
decision functions, asserting identical exit sequences — same trigger, same
quantity, same resulting stop. Any divergence is either a bug or a
deliberately documented live-only difference (§3.4 is the only expected one).

This requires extracting paper's decision logic into a pure function the test
can call without a DB, mirroring how `manual-fill-detection.ts` was extracted
from its route. That extraction is part of this work, not a prerequisite.

## 5. Explicitly NOT in this proposal

- **No change to entry, sizing, or the stop distance itself** — only what
  happens to an already-open live position.
- **No change to `live_auto_enabled`** or any autonomy gate. This makes the
  live exit engine match paper; it does not enable anything.
- **No pyramiding / scaling in.** Paper's anti-pyramid rules are untouched.
- **No Guardian Stage 1 interaction.** Suggested stops for manual fills remain
  detection-and-alert only; this proposal governs Kairos-originated live
  positions, which have a `policy_snapshot` lineage a manual fill does not.
- **India live** is in scope for the shared math (the helpers are already
  market-aware) but India live orders remain manual-confirm, so no behavior
  reaches an order path there.

## 6. Open questions

1. **Should the partial fire when `live_auto_enabled` is false?** Today
   `live-exit-monitor` no-ops entirely when the flag is off, so parity work is
   unobservable until it flips. Options: leave it gated (safe, untestable in
   production until enablement) or add a shadow mode that logs what it *would*
   do without submitting. The shadow option is strongly preferable — it makes
   the parity test observable on real positions before any live behavior
   change, consistent with how every other risky change in this codebase has
   been validated.
2. **Reconciliation cadence for §3.4.** The next run is 15 minutes later;
   whether that is tight enough for a partially-filled protective sell needs a
   decision.
3. **Backfill for existing live positions.** Any position already open when
   this ships has no `live_position_state` row. Proposal: initialize
   `highest_price` to the current price and leave `partial_taken_at` null —
   conservative, since it means an already-past-target position could take a
   partial it "should" have taken earlier, rather than assuming history it
   cannot know.
