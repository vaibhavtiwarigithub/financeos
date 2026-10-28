# Health Control And Paper P&L
Status: APPROVED AND IN BUILD (owner request, 2026-07-20)

## Problem

1. A kill-switch trip latches `market_controls.trading_enabled=false`, but the
   Settings market toggle only changes `strategy_config`. The user therefore
   cannot inspect or safely reset the actual latch from the UI.
2. `paper_trades.realized_pnl` is correctly null while a trade is open, but the
   Trades tables render only that terminal value. The current mark-to-market P&L
   already available on `paper_positions` is not shown beside the open lot.
3. Live holdings already show current P&L. Live orders and research signals do
   not share one canonical, cross-broker execution ledger and must not be
   presented as if uploaded history were broker-confirmed live trades.

## Design

### Guarded reset

- Add an owner-only Settings API that returns each market latch and reset reason.
- A reset names the market and the book that tripped (`paper` or `live`).
- The server reruns `checkKillSwitches` for that exact book before enabling the
  market latch. An unsafe, stale, or missing live baseline refuses the reset.
- A successful reset clears the matching health issue and writes an immutable
  `decision_journal` entry. It never changes thresholds, global pause, security
  lock, broker credentials, account selection, or live-autonomy flags.
- Future trip reasons and issue keys include the book. The market latch remains
  intentionally conservative and shared: a trip in either book blocks new
  exposure for that market until its originating book passes a guarded reset.

### Current paper P&L

- Keep `Realized P&L` terminal and immutable.
- Add `Current P&L` beside it for open BUY lots only.
- Compute deterministically from persisted values already fetched:
  `(paper_positions.current_price - paper_trades.fill_price) * paper_trades.qty`.
- Join strictly by normalized market + symbol. Multiple open lots use the same
  current mark but retain their own fill price and remaining lot quantity.
- Missing/non-finite marks, unmatched lots, SELL rows, and closed trades render
  unavailable; they never substitute fill price or zero.
- Expose mark timestamp in the cell tooltip. No provider call is added.

### Live parity boundary

- Live Portfolio remains the source for broker holdings and unrealized P&L.
- Research signals remain market-level evidence, not account-level executions.
- A future live Trades tab may read only reconciled `broker_orders`, scoped to
  market + active account + live environment. Kite/Webull/Robinhood parity must
  be proven before calling it unified. Uploaded CSV decisions remain analysis,
  not the live order ledger.

## Acceptance criteria

- Settings shows the real per-market latch and its reason.
- Reset cannot succeed unless the originating book currently passes all brakes.
- Successful reset is audited and resolves only matching kill-switch alerts.
- Open paper trade rows show current amount and percent at the persisted mark;
  closed rows show only realized P&L.
- US and India are never joined or summed; currency follows the selected market.
- No external API call, LLM call, broker call, order, threshold, or autonomy flag
  is introduced by the P&L display.

## Paper accuracy-latch recovery visibility — owner approved 2026-10-28

### Intent and boundary

Make the existing owner-facing kill-switch card explain whether the paper
30-day accuracy brake is currently blocked, clear, insufficient for evaluation,
or unavailable because its data could not be read. This addresses the recovery
dead-end confusion without changing risk policy. The 35% threshold, 20-directional-
episode minimum, 30-day window, market latch, and explicit owner reset remain
unchanged. No automatic re-enable, probe trades, sample fabrication, or shadow
outcome substitution is allowed.

### Data contract

Extend the existing owner-only `GET /api/settings/kill-switch` response with a
nullable `paper_accuracy` summary only for a latch attributed to the paper book:

```ts
{
  state: "blocked" | "clear" | "insufficient" | "unavailable",
  wins: number | null,
  losses: number | null,
  directionalEpisodes: number | null,
  winRatePct: number | null,
  thresholdPct: number,
  minimumEpisodes: number,
  windowDays: 30
}
```

Use the same canonical `aggregatePaperExitAccuracy` function and source query
contract as the kill-switch evaluator (`paper_trades`, same market, non-null
outcome, tainted exits excluded, same timestamp fallback and episode grouping).
Read failures or a history-limit overflow are `unavailable`, never `insufficient`.
Fewer than 20 valid directional episodes are `insufficient`; this means the
accuracy brake has no current estimate, not that the strategy is safe or
profitable. A measured rate below threshold is `blocked`; at or above threshold
is `clear`. Never report a required future win count because the rolling window
can change as new episodes arrive and old ones expire.

The summary is explanatory only. It does not decide reset eligibility. The
existing POST remains the sole reset path and rechecks all breakers, the pause,
book attribution, owner authentication, and audit-before-enable requirements.
The UI must state that a clear accuracy gate does not guarantee the other brakes
pass. On unavailable data, preserve the latch and direct the user to the exact
read failure without exposing provider/database secrets.

### UI and acceptance

In Settings → Trading, the paper latch card shows the rolling sample, win rate,
threshold, and state in plain language. The existing `Recheck paper + reset`
button remains available; its server response continues to control the result.
After every reset attempt, refresh the read-only status. No score, position,
order, account, threshold, or trading behavior changes.

Acceptance: authenticated GET reports exact values from the canonical helper;
20-row boundary, below/at/above threshold, tainted rows, market isolation,
query error, and overflow states are covered; anonymous/non-owner requests retain
the existing denial; GET performs no writes; reset continues to use the existing
guarded and audited POST and cannot bypass any safety brake.
