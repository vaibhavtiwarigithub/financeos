# Live Exit Ladder Parity — Architecture Proposal

> Status: **Approved and implemented; production state/shadow tables verified**
> (2026-09-12). Both monitors now call the same ladder core. The 2026-09-12
> correction makes the stop use the prior persisted high-water mark before the
> current observation can ratchet the trail; `live_auto_enabled` remains off.
> 2026-10-14 collection-health correction: each authenticated monitor invocation
> now writes best-effort, market-local operational status to the existing
> `upgrade_path_producer_runs` ledger. A successful run with no reconstructed
> managed position is recorded as `waiting_for_managed_position`; stale/missing
> shadow-event rows alone do not mean the scheduled collector is frozen. A
> filled active-account buy that cannot be reconstructed, missing fresh quotes,
> and failed state/shadow writes are explicit blockers. These run counters are
> operational health only, never strategy or P&L evidence.
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
| time stop | no — Decision 74 | no — Decision 74 |

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
  market       text not null check (market in ('us', 'india')),
  state_mode   text not null default 'legacy'
    check (state_mode in ('legacy', 'shadow', 'executable')),
  highest_price      numeric,      -- trailing anchor since entry
  trailing_stop      numeric,      -- last computed stop; never lowered
  partial_taken_at   timestamptz,  -- non-null = broker-confirmed partial target fill
  partial_qty        numeric,      -- what was sold at partial, for audit
  opened_at          timestamptz not null,  -- guards stale rows across re-entries
  direction_flip_armed_session timestamptz, -- first fresh held-short score session
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
2. **Target** and no `partial_taken_at` → submit `paperPartialTargetQuantity`.
   Only a broker-confirmed non-zero fill may set `partial_taken_at` and move the
   runner stop to `paperRunnerStopPrice(entry, trailingStop)`.
3. **Target** and `partial_taken_at` already set → no action (the runner is
   managed by the trailing stop from here, same as paper).
4. **Fresh score below entry threshold** → full close immediately; a confirmed
   two-session held-short direction flip → full close. Both share paper's
   freshness and debounce policy.

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
appears with non-zero `filled_qty` as `filled`/`partially_filled` in
`broker_orders`, reconciled on the following run. Requested quantity is never
substituted for an unconfirmed partial fill.

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

1. **Shadow state isolation (resolved):** shadow rows use `state_mode=shadow`;
   executable runs read only `state_mode=executable`, so a hypothetical trail
   or partial cannot affect an order after enablement.
2. **Reconciliation cadence for §3.4.** The next run is 15 minutes later;
   whether that is tight enough for a partially-filled protective sell needs a
   decision.
3. **Backfill for existing live positions.** Any position already open when
   this ships has no `live_position_state` row. Proposal: initialize
   `highest_price` to the current price and leave `partial_taken_at` null —
   conservative, since it means an already-past-target position could take a
   partial it "should" have taken earlier, rather than assuming history it
   cannot know.

## 7. Collection health contract

The hourly authenticated cron records a separate `upgrade_path_producer_runs`
row for US and India after the monitor invocation completes. The row contains
only market-scoped counts and enumerated state (account configured, market
open, fills read/matched, matched buys/sells, reconstructed positions, quote
failures, state-write failures, and shadow rows written); it never stores an
account identifier, symbol, or raw provider error. The write is best-effort and
occurs after the exit monitor, so a health-ledger outage cannot prevent, repeat,
or change an exit action.

### Confirmed-review safety repair (owner go, 2026-10-22)

Cancellation is never best-effort before another SELL. Acquire the protective
row with compare-and-swap; unresolved/canceling state, failed read/claim, broker
failure or unproven final cancellation blocks the new sell and raises a critical
risk issue. A canceled stop followed by a rejected/unknown sell is recorded as
a needs_reconcile audit event and critical health issue, not active protection
or automatic replacement. Preserve the true terminal canceled broker-stop status;
the residual exit lifecycle, not the canceled broker order, needs reconciliation.
Reconcile actual broker sells/fills and held quantity before any replacement:
blind restoration can oversell after an ambiguous fill. Submission acknowledgement
does not establish runner protection. This hardening does NOT establish live
readiness, enable a worker or authorize any broker lifecycle test. The leveraged
live door shares the same canceled-stop reconciliation latch; paper is unchanged.

Each row explicitly persists the invocation's start time and a finish time no
earlier than that start time; the database default is not used for `started_at`.
This keeps producer-run duration and ordering trustworthy even if wall-clock
timestamps have sub-second jitter.

`collected` with `waiting_for_managed_position` or `outside_market_session` is
a valid no-event result. `blocked` identifies a known collection gap, including
a filled buy that fails reconstruction, an unusable quote, or failed state or
shadow persistence. An exception before market diagnostics return records an
`error` for both markets with a sanitized generic blocker. Upgrade Path shows
this run health for operational-only programs too. Shadow-row freshness has no
time promise: the cron's own last-run status is the liveness contract, while a
new shadow row requires an eligible live position during that session.

### 2026-10-27: market-status observation lifetime

The shared session corroborator now validates the original `av_cache.fetched_at`
alongside its payload. An overnight US-closed status fetched during India hours
cannot veto the next US regular session. Only observations younger than five
minutes, with a valid nonfuture timestamp, can corroborate open/closed; the memory
cache expires at observation time plus five minutes. Stale or unavailable status
uses the existing local-session fallback with independent quote/broker gates.
Fresh closed observations still block. This preserves the existing AV daily call
budget and changes no live switch, execution permission or protective-order gate.

### 2026-10-28: shadow-write alert recovery

Production review found the IBIT shadow-write alert remained open after the
action-contract migration had been applied and subsequent observations were
persisting. The monitor now resolves only the matching market/account/symbol
alert after that exact shadow insert succeeds; failed inserts continue to report
the critical issue and block the shadow observation. This is health-state
recovery only and does not alter ladder decisions, position state, or orders.
