# Strategy Evidence Scorecard

> Status: **DRAFT — for owner approval. No code written.**
> Date: 2026-09-01. Influence if approved: **read-only surface.** It displays
> evidence; it activates nothing and no money path reads it.

## The question it answers

> Which strategy — or combination — is currently adding benchmark-relative
> return, capturing large winners, limiting losses, and doing so with enough
> evidence to trust?

Deliberately **not** "which strategy has the highest return", and explicitly
**not a win-rate leaderboard**. A leaderboard ranked on win rate would reward the
exact pathology this book already exhibits: many small wins and one large loss.
Measured on the live ledger, `time_stop` closes 73.7% of lots at a mean +1.66%
while `stop_hit` loses a mean −4.72%.

## Location

A third tab on the existing Strategies page:

`Fit Scores · Algo Library · Live Evidence`

That page already shows symbol-to-strategy fit scores and reference templates.
Governed performance evidence currently lives in Learning, and raw research
observations live on Research — neither is the right home for a
strategy-versus-strategy comparison.

## The table

| Strategy | Evidence stage | 12-week alpha | Payoff ratio | Profit factor | Winning weeks | Evidence | Status |
|---|---|---:|---:|---:|---:|---:|---|
| RSI Pullback | Forward shadow | +1.8% | 1.9x | 1.42 | 7/10 | 31 trades | Promising |
| Trend Breakout | Paper | +0.6% | 2.6x | 1.18 | 6/12 | 24 trades | Collecting |
| Calendar Overlay | Replay only | +0.3% | 1.1x | 1.04 | 5/11 | 11 weeks | Insufficient |
| Champion + RSI | Paper | +1.1% | 1.7x | 1.31 | 8/12 | 38 trades | Promising |
| Current Champion | Paper | -0.4% | 0.8x | 0.91 | 4/12 | 42 trades | Degrading |

Visible columns, in priority order:

1. **Alpha versus the correct market benchmark** — never absolute return. US
   compares to VOO, India to NIFTY 50; the two are never pooled.
2. **Payoff ratio** — average winner / average loser. This is the column that
   answers "win big, lose small", and it is why win rate is demoted.
3. **Profit factor** — gross gains / gross losses.
4. **Winning weeks**, as `7/10` — never a streak (see below).
5. **Evidence count and stage.**
6. **Status** — computed, never hand-set.

**Win rate is NOT a headline column.** It appears in the expanded row alongside
average win, average loss, max drawdown, Sharpe, costs and a weekly sparkline.

## Winning weeks, not streaks

Show two distinct facts:

- **Positive in 7 of the last 10 completed weeks**
- **Current positive-alpha streak: 3 weeks**

A streak resets on a single bad week and encourages recent-winner chasing.
Persistence research on fund performance finds apparent short-term winners often
reflect common exposures and costs rather than durable skill
([Carhart 1997](https://doi.org/10.1111/j.1540-6261.1997.tb03808.x)) — applied
cautiously here, since that work studied funds and not this system.

## Evidence stages — always visible

Every row shows which population produced its numbers:

| stage | meaning |
|---|---|
| `replay` | historical simulation only; hypothetical |
| `shadow` | forward, non-executing, real-time signals |
| `paper` | executed in the paper book |
| `live` | real money |

A replay number and a live number must never sit in the same column without this
label. The SEC's guidance on performance claims is explicit that backtests are
hypothetical, that past performance does not predict future results, and that
cherry-picked periods mislead
([SEC investor bulletin](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-47)).

## Statuses — frozen thresholds

These are **financially load-bearing** and must be fixed here, before any
strategy is graded against them. Tuning a threshold after seeing which strategy
it promotes is the failure this whole document exists to prevent.

| status | condition |
|---|---|
| `insufficient_evidence` | below the evidence floor: `nEffective < 12` or `nDates < 60` |
| `collecting` | floors met, no verdict yet — accruing forward evidence |
| `promising` | positive net alpha AND payoff ratio > 1 AND floors met, but not yet multiple-testing significant |
| `working` | ALL of: positive net benchmark alpha; payoff ratio > 1; profit factor > 1; max drawdown no worse than the champion's; multiple-testing-adjusted significance at the family's full trial count; and forward evidence, not replay alone |
| `degrading` | previously `working`, now failing any one of those conditions |
| `failed` | negative net alpha with floors met — measured, and measured badly |
| `retired` | owner-retired; row remains for the record |

**`working` requires more than a positive return.** It requires benchmark-relative
alpha, acceptable drawdown, positive expectancy, sufficient independent evidence,
and no integrity failure. A strategy cannot reach `working` on replay evidence
alone, ever.

A strategy declared a **hedge** is graded differently and says so: it may carry
modest or negative standalone return, but must reduce downside enough to justify
its carrying cost. It must not be quietly scored against the easier
return-strategy criteria.

## Combination rows

Rows such as `Champion + RSI + Trend` appear alongside single strategies, sharing
the same columns and statuses. The decision object is the champion-relative one
defined in `features/external-strategy-discovery` section 7 —
`champion`, `champion+A`, `champion+B`, `champion+A+B` — so a combination that
merely duplicates existing exposure is visible as adding nothing.

## What exists and what is missing

Already available:

- `components/dashboard/StrategyGovernancePanel.tsx:33` surfaces signal count,
  win rate, average return, Sharpe, drawdown and alpha.
- `lib/analytics/performance-metrics.ts:105` computes expectancy and profit
  factor.

Missing, and therefore the actual build:

- strategy-level **weekly** return history
- **payoff ratio** attached to each strategy run
- benchmark-relative **weekly consistency** (`7/10`)
- **evidence-stage** separation
- a **governed status** calculation with the frozen thresholds above
- **combination rows**

## What this does NOT do

- It does not activate, promote, size or retire anything. Every action remains an
  owner decision.
- It does not rank by win rate, or by return alone.
- It does not display a replay number without its stage label.
- It does not pool US and India.

## Open question for the owner

The `working` threshold set above is my proposal, not a derived optimum. The one
I would most expect to argue about is **"max drawdown no worse than the
champion's"** — that is strict, and it will block a strategy that earns more
while drawing down slightly deeper. The alternative is a drawdown-adjusted return
comparison, which is more permissive and harder to read at a glance. Say which
you want before implementation; changing it afterwards, once rows exist, is
exactly the tuning this document forbids.
