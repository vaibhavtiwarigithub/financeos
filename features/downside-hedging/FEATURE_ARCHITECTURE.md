# Downside Hedging - Feature Architecture

> Status: APPROVED FOR BUILD (2026-07-15). US PAPER ONLY. SHIPS OFF.

## Purpose

Add bounded downside protection without true short selling, margin, options, or
leveraged products. Kairos may buy an explicitly allowlisted unleveraged inverse
ETF as a small portfolio hedge after deterministic macro and market confirmation.
The hedge is portfolio insurance, not an alpha candidate.

## Locked Decisions

- US paper book only. No India proxy is invented.
- Initial instruments: `SH` and `PSQ`, both -1x daily-reset inverse ETFs.
- Every 2x/3x, volatility, commodity-inverse, and single-name inverse product
  remains blocked.
- Normal research, PaperTrader, Trader, rotation, and live execution continue to
  reject every leveraged/inverse ETF. Only the dedicated paper-hedge RPC has a
  narrow `SH`/`PSQ` exception.
- No LLM may arm, select, size, enter, exit, or mutate the hedge.
- Entry is cash-funded. Capital Rotation cannot sell an alpha holding to fund it.
- Default target is 5% NAV; hard ceiling is 8%; one hedge position maximum.
- Maximum holding period is five market days. Normal stop protection still works.
- Performance is judged on whole-book drawdown, volatility, turnover, and
  benchmark-relative return after hedge drag, never hedge P&L alone.

## Deterministic State Machine

`off -> armed -> active -> exit_pending -> cooldown -> off`

Entry requires both:

1. Macro confirmation: latest US `macro_regime.danger_score >= 60`.
2. Market confirmation: SPY is below its 50-session SMA and either 20-session
   return <= -4% or 20-session drawdown <= -6%.

The condition must persist for two completed evaluations. `PSQ` is selected only
when QQQ is at least three percentage points weaker than SPY over the same
20-session window; otherwise `SH` is used.

Exit requires danger <= 45, SPY above SMA50, and non-negative five-session return,
persisting for two evaluations. The five-market-day time stop and 5% price stop
can exit sooner. Missing/stale data never enters and never fabricates an exit.

## Data Model

- `downside_hedge_config`: US-only controls, seeded disabled.
- `downside_hedge_state`: mutable current state and confirmation streaks.
- `downside_hedge_events`: append-only evaluation/lifecycle ledger.
- `paper_positions.position_role` and `paper_trades.position_role`: `alpha` or
  `hedge`; hedge trades are always `excluded_from_learning=true`.

Owner-authenticated users may read configuration/state/events through owner RLS.
Only service-role routes/RPCs write. Anonymous access is revoked.

## Execution

`POST /api/agents/downside-hedge` runs after the US close. It loads macro state and
point-in-time daily bars, evaluates the pure state machine, and appends an event.

- `enabled=false`: no evaluation or provider call.
- `enabled=true`, `paper_execute_enabled=false`: shadow measurement only.
- both true: an `enter` decision creates a non-alpha control signal and calls
  `execute_paper_hedge_fill`, which rechecks configuration, state, allowlist,
  one-position limit, cash, and NAV cap under DB row locks before delegating to
  the existing atomic paper-fill function.
- an `exit` decision marks only the hedge position `hedge_exit`; PositionMonitor
  closes it through the existing paper accounting path.

PositionMonitor never applies ordinary analyst-score/direction exits to a hedge.
It retains price stop and time stop behavior. After a hedge disappears, the next
controller run reconciles `exit_pending`/`active` to cooldown before re-entry.

## Product Surface

Settings -> Agents contains a Downside Hedge panel showing state, latest reason,
target/cap, instruments, and separate Shadow and Paper Execution toggles. Paper
execution cannot be enabled unless shadow is enabled. There is no live toggle.

## Acceptance Criteria

1. Default/live DB state is OFF for both flags.
2. Generic research, paper, trader, rotation, and live gateway still block
   `SH`, `PSQ`, and all leveraged/inverse products.
3. LLM text cannot affect any evaluator result.
4. One failed/missing/stale input cannot create an entry.
5. RPC rejects non-US, non-allowlisted, over-cap, non-cash-funded, duplicate, or
   improperly sourced fills.
6. Hedge trades cannot enter learner/validation datasets.
7. US and India books are never summed or mutated together.
8. Typecheck, full Vitest, production build, live migration/RLS/OFF-state checks,
   and Vercel deployment pass without placing a live order.
