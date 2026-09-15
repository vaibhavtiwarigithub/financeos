# Feature Architecture: Per-Symbol Score History vs Price

## Status

Architecture status: Approved
Architecture approved: Yes (owner, 2026-09-15 — "Proceed")
Approved scope: Read-only. Plot the dimension scores already written by every
research run against price, for any researched symbol.
Implementation allowed: Yes — shipped 2026-09-15.

## The defect this fixes

`/dashboard/research/<symbol>` → **Score History** read `/api/research/trades`,
whose scores live as columns on the `paper_trades` row. So a symbol had a score
history **only if it had produced a trade**.

Research runs on hundreds of symbols that never trade. Every one of those runs
already writes the full dimension set to `agent_signals`. Observed 2026-09-15:

| Symbol | Research runs | Paper trades | Tab showed |
|---|---|---|---|
| STM | 56 (2026-07-17 → 2026-09-15) | 0 | "No scored paper trades found for STM." |

Two months of daily scores — including a fundamental move from 23 → 70 around
2026-09-12 that pulled the analyst score 35 → 56 — were in the database and
invisible on the page built to show them.

Coverage is not the constraint. Last 90 days: **364 symbols, 9,107 runs**, with
`fundamental/technical/sentiment/macro/insider` present on all but 5 rows.

## Design

### Source of truth

`agent_signals`, keyed by `symbol` + `market`. It is written once per research
run per symbol, trade or no trade. `paper_trades` is no longer consulted for
score history; it still supplies execution markers drawn **over** the series, so
a symbol that did trade keeps both.

### One point per day, last run wins

A symbol is sometimes researched twice in a day (STM was, on 2026-08-31 and
2026-09-01). For STM's 365-day window, **56 runs collapse to 34 chart points**.

- Plotting both puts two points on one x value, which renders as a vertical
  spike that looks like score volatility that never happened.
- **Averaging them is rejected**: it invents a score no run ever produced. The
  last run of the day wins — it is a real observation, and it is the one
  standing at the close.
- The point carries `runs`, and the UI says "last of N runs that day", so the
  collapse is never silent.

`lib/research/score-history.ts` owns this rule so it is testable apart from the
route and the chart.

### Gaps are shown as gaps

Scores exist only on days a research run happened. Those series are null on
every other day and the lines **break** there — `connectNulls` is deliberately
off for scores (and on for price, which is continuous). Joining the dots across
a three-week gap would draw a trend the agent never observed.

### Honest zero

`technical_score` legitimately reads `0` for STM. Checked before assuming a bug:
across 30 days technical spans 0–100 with a mean of 61.7, so STM genuinely
scores low — it is down 7%. A real `0` must survive as `0` and never collapse to
null, or the chart would report "no data" where the agent had a firm opinion.

### Empty state

The old message blamed missing *trades*. A symbol with no runs in the window now
reads "No research runs recorded for {symbol} in this window" — a different
claim, and the true one.

## Non-goals (explicitly out of scope)

- **Per-indicator attribution** (which P/E or RSI reading moved a dimension).
  Not recorded on the signal row; the UI says so rather than guessing.
- **`recommendation`** — null on every STM row, so it is not surfaced.
- Any write path. This feature reads; it changes no score, trade or decision.

## Acceptance tests

`tests/research-score-history.test.ts` — 16 assertions. All 13 mutations in the
harness caught, including: same-day runs averaged, same-day runs both kept, a
real zero collapsed to null, the Insider dimension dropped, provenance dropped,
points unsorted, the route reverting to `paper_trades`, the route losing its
owner gate or its market scoping, the tab gating on trades again, score lines
smoothing over gaps, and the dual axis collapsed to one.

Two of those mutations initially survived and exposed vacuous assertions of the
author's own making: a dimension check that looped over `SCORE_DIMENSIONS` (so
deleting a dimension deleted its own assertion), and an axis check that matched
`yAxisId` anywhere (the lines carry it too, so it passed with the axis removed).
Both tests were rewritten to name what they assert.

## Update triggers (per CLAUDE.md)

Update this file when: the score dimensions change, the same-day collapse rule
changes, the source table changes, or per-indicator attribution is added.
