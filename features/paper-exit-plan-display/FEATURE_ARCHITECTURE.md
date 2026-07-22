# Paper Portfolio Exit Plan Display

Status: approved for implementation (owner requested, 2026-07-21)

## Decision

Show one compact `Exit plan` section for every open paper position. Do not show a single "agent exit price": Kairos can exit through several deterministic rules, and presenting only the profit target would be materially misleading.

## Why

The owner needs to understand why an open paper position is still held and which condition would close it. The existing position card shows P&L but hides PositionMonitor's current stop, target, conviction threshold, score freshness, and time horizon.

## Scope

- Project a read-only exit plan from the open position, per-market trading mandate, effective champion/user horizon, and latest same-market validated deterministic holding score.
- Show the persisted trailing/protective stop. This is the current executable paper stop and may ratchet upward; it never moves down.
- Show the persisted profit target when present. After a partial target exit the database clears the target, so the UI must say no remaining target rather than retaining a historical number.
- Show current score versus the per-market exit threshold and whether the score is fresh enough to act.
- Show current position age versus the effective time horizon, including whether the position is grandfathered onto its entry horizon.
- Show the first currently met condition using PositionMonitor's precedence: time, score, stop, target.

## Boundaries

- Display-only. It cannot write signals, positions, trades, mandates, cash, controls, broker orders, or provider state.
- No market-data/provider calls. It reuses persisted position prices and signals.
- US and India are keyed and resolved separately; currencies and signals never cross.
- Missing/stale research means mechanical exits only. It must never be converted to score zero.
- The manual Close Position command remains separate and unchanged.
- This does not add or change an exit rule, threshold, target, stop, or schedule.

## Data Contract

`PaperExitPlan` contains:

- market and position identity
- current persisted price, stop, and optional target
- latest deterministic score, threshold, timestamp, market-session age, and freshness
- open-position weekday age, effective horizon, and horizon source
- current projected state: `hold`, `time_exit_due`, `score_exit_due`, `stop_exit_due`, or `target_exit_due`

The projection is assembled on the server. The client receives only display data and performs no decision calculation.

## Edge Cases

- No target: display `No remaining target`; do not invent one.
- No score: display `Awaiting held-name research · mechanical exits active`.
- Stale score: display its age and `mechanical exits only`.
- Partial target: the remaining lot has no target and a breakeven-or-higher persisted stop.
- Hedge positions: omit score exits; retain their stop and effective short horizon.
- Invalid numeric data: display unavailable, never coerce to zero.
- A due state is a projection at the persisted price/time. PositionMonitor remains the sole autonomous execution authority.

## Acceptance Criteria

1. Every open paper position renders an Exit plan section without changing layout width on mobile.
2. Stop, target, score/freshness, and time horizon match the inputs PositionMonitor would read.
3. US positions cannot receive India scores or mandates, and vice versa.
4. Missing/stale scores cannot produce `score_exit_due`.
5. Null targets remain null.
6. The page performs no external provider request and no write.
7. Pure projection tests cover precedence, stale/missing score, null target, grandfathered horizon, and market identity.
