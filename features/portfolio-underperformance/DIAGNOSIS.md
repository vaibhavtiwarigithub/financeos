# Portfolio underperformance — diagnosis

Status: **Diagnosis only. No fix proposed, no code changed.**
Author: Claude · 2026-08-06
Evidence: production (`dionkikgdmlaotvtbnfr`), queried directly. Every figure below
is a query result, not an estimate.
Related: `features/walk-forward-ic-folds/`, `features/india-scorer-discrimination/`,
`features/event-ledger/`.

---

## 0. The one-line version

**US and India are failing for opposite reasons.** US selects from a candidate
pool that loses badly to its benchmark — one discovery source alone runs
**−9.8% excess at 5 days**. India's *decisions* are actually good (+0.58% excess
at 5 days across every source) and the **exit layer gives all of it back**.

Neither is a scorer-weights problem, which is where tuning effort would
instinctively go.

---

## 1. First, what the headline numbers can and cannot support

The whole book starts **2026-07-10**. `benchmark_scorecard` reports
`insufficient_data` for every horizon of 3M or longer.

| | portfolio | benchmark | excess | return days | confidence |
|---|---|---|---|---|---|
| US 1M | −0.13% | VOO +2.65% | −2.77% | 18 | `low` |
| US 1W | +0.32% | VOO +4.11% | −3.79% | 5 | `insufficient` |
| India 1W | +0.37% | ^NSEI +1.54% | −1.17% | 5 | `insufficient` |

The system is labelling its own confidence correctly. An 18-day window cannot
separate skill from noise, and the 1W rows are explicitly `insufficient`. They
are a symptom worth chasing, not a verdict.

## 2. A third of the visible gap is cash, not selection

| market | cash | NAV | cash % |
|---|---|---|---|
| us | 2,751.71 | 9,936.91 | **27.7%** |
| india | 389,251.55 | 1,001,709.68 | **38.9%** |

Against a benchmark that is 100% invested, uninvested cash costs
`cash% × benchmark return` mechanically:

- US 1W: 0.277 × 4.11% = **1.14pp of the 3.79pp gap (30%)**
- India 1W: 0.389 × 1.54% = **0.60pp of the 1.17pp gap (51%)**

This is arithmetic, not signal. It is also the only part of the gap that can be
closed without any edge whatsoever — which makes it the cheapest thing on this
page and the one least related to the interesting problem.

## 3. The two books fail with different shapes

Closed trades with a recorded P&L:

| market | n | win rate | avg win | avg loss | expectancy |
|---|---|---|---|---|---|
| us | 23 | **8.7%** (2 wins) | +15.86% | −2.57% | **−0.97%** |
| india | 50 | **48.0%** | +2.31% | −2.23% | **−0.05%** |

**India is a coin flip with symmetric payoffs.** 48% at ±2.3% is noise minus
costs. Expectancy is statistically indistinguishable from zero.

**US is a lottery.** Two of 23 paid, and they paid +15.9%. A low win rate is
*normal* for that payoff shape — an 8.7% win rate is not itself the defect, and
reading it as one leads to exactly the wrong fix (tightening entries to raise
win rate would remove the two trades that paid). The defect is that expectancy
is negative and the edge is estimated on **two** observations.

**Data hole:** 8 closed trades carry NULL `realized_pnl_pct` (1 US, 7 India),
mostly `direction_flip (was long, now neutral)`. They are invisible to every
statistic in this document. Small, but it means every count above is a floor.

## 4. The scorer is not the problem — the pool is

IC of `analyst_score` against forward return, from
`decision_observations × observation_labels`:

| market | 2d | 5d | 10d |
|---|---|---|---|
| us | −0.063 (n=536) | **+0.196** (n=338) | **+0.300** (n=74) |
| india | −0.068 (n=151) | −0.022 (n=134) | +0.073 (n=65) |
| **us avg excess** | −0.27% | **−1.83%** | **−1.61%** |

The US scorer **ranks** at 5–10 days. And the average US decision still
underperforms its benchmark by 1.6–1.8% at every horizon. It ranks well *inside a
pool that systematically loses*.

Caveats, stated rather than buried: the 5d/10d windows overlap heavily with no
HAC correction, and n=74 at 10d is thin. The best-powered figure here is US 2d at
n=536, and it is **negative**. India shows no ranking ability at any horizon.

## 5. Where the US pool goes wrong — this is the finding

5-day benchmark-neutral excess by `discovery_source`:

| market | source | n | avg excess 5d |
|---|---|---|---|
| us | **watchlist** | 26 | **−9.83%** |
| us | metals_basket | 9 | −3.19% |
| us | (null) | 72 | −1.85% |
| us | holding | 220 | −0.94% |
| us | region_etf | 9 | +0.27% |
| us | manual | 2 | +1.36% |
| india | india_screener | 71 | **+0.58%** |
| india | india_holding | 38 | **+0.58%** |
| india | (null) | 21 | +1.01% |
| india | manual | 4 | +0.72% |

**Every India source is positive. Every material US source is negative.**

The US `watchlist` source at **−9.83% over 26 decisions** is not a small drag —
it is roughly a tenth of position value lost against benchmark in five days,
repeatedly. Closed US trades name the mechanism: RDDT −14.27%, HOOD −10.23%,
SMCI −8.09%, PLTR, SPOT. High-beta retail-momentum names, measured against VOO,
whose gain over this window was mega-cap led. The pool is structurally on the
wrong side of the market's breadth.

This connects to a defect already fixed in this repo: the US screener was starved
for all of 2026-07 (`kairos-research-discovery-us` exists precisely because
`gatherSymbols` ordered candidates holdings → watchlist → screener and the
wall-clock budget cut from the tail). So the US book has been trading
**holdings and a hand-curated watchlist**, which is exactly the −0.94% and
−9.83% cohorts. The screener fix is recent enough that its candidates have not
yet accumulated matured labels.

## 6. Where India goes wrong — the exit layer, not the entry

India decisions average **+0.58% excess at 5 days**. India closed trades average
**−0.05%**. The edge exists at decision time and does not survive to realisation.

Exit reasons for closed trades:

| market | exit reason | n | avg P&L |
|---|---|---|---|
| india | `time_stop (11 market days > 10d, grandfathered)` | 34 | +1.21% |
| india | `direction_flip (was long, now short)` | 6 | −1.10% |
| india | `stop_hit` | 4 | **−6.35%** |
| india | `capital_rotation` | 3 | −3.22% |
| us | `time_stop (11 market days > 10d, grandfathered)` | 13 | −0.99% |
| us | `stop_hit` | 4 | **−9.47%** |
| us | `direction_flip (was long, now short)` | 3 | −1.05% |

Two observations:

**The modal exit is a clock, not a thesis.** 34 of 50 India exits and 13 of 23 US
exits are the 10-market-day time stop. The holding period is set by a timer
rather than by the signal that opened the position.

**Stops are wide relative to the win size.** US `stop_hit` averages −9.47%
against an average win of +15.86%; 4 of 23 trades (17%) at −9.47% is a −1.6%
drag on the whole book by itself. India's −6.35% stop against a +2.31% average
win is worse in ratio: a single stop erases roughly three average winners.

## 7. What this rules out

- **Not the scorer weights.** US IC is positive at the horizon actually traded.
- **Not the LLM.** No LLM touches score direction, sizing, or exits.
- **Not a data-availability problem.** Coverage figures are healthy in
  System Health; the negative cohorts have full evidence.

## 8. What it points at, in priority order

1. **US universe composition.** The watchlist cohort is the single largest
   measured destroyer of relative return. Nothing in the 14-program upgrade-path
   registry currently measures universe composition at all.
2. **The exit layer for India.** A positive decision edge is being converted to
   zero. Time-stop and stop-width are the two candidate mechanisms and are
   separable with existing data.
3. **Cash deployment.** Pure arithmetic, needs no edge, but is a policy decision
   with its own risk implications and is NOT free — deploying into a pool with
   negative expectancy makes things worse, not better. **Sequence matters: this
   is safe only after (1).**

## 9. Explicitly not proposed here

No threshold change, no weight change, no sizing or concentration change, no exit
rule change, no universe change. Each of those is a money-path decision requiring
its own architecture round and its own predeclared evidence. In particular,
**concentration into 2–3 high-conviction names is contraindicated by §3**:
concentration multiplies edge, and measured US expectancy is −0.97% per trade
with a "confident and correct" sample size of two.

## 10. Open questions for the owner

1. Should universe composition become a tracked program in
   `lib/shadows/registry.ts`? It is currently the largest measured problem with
   no owner and no evidence campaign.
2. Is the US `watchlist` source hand-maintained, and can it simply be
   demoted to measure-only pending review? That is the highest-value, lowest-risk
   single change available — but it is still a change to what the system may buy.
3. Are the 8 NULL-P&L closed trades worth backfilling, or is
   `direction_flip → neutral` genuinely a no-P&L close?
