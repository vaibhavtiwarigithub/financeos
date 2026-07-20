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
