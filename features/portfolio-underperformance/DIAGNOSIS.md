# Portfolio underperformance — diagnosis

Status: **Diagnosis only. No fix proposed, no code changed.**
Author: Claude · 2026-08-06
Evidence: production (`dionkikgdmlaotvtbnfr`), queried directly. Every figure below
is a query result, not an estimate.
Related: `features/walk-forward-ic-folds/`, `features/india-scorer-discrimination/`,
`features/event-ledger/`.

---

## 0. The one-line version

**The honest answer is that the data cannot yet say why.** Every decision-level
figure in this document comes from a **single two-week window** (2026-07-06 →
2026-07-22), with 7–14 distinct dates depending on horizon. See **§4b**, which
refutes §4 and §5 of this same document.

What is solidly established:

- **~30% of the US and ~51% of the India benchmark gap is uninvested cash** —
  arithmetic, not signal (§2).
- **The reporting window is 18 return days**, and the system already labels its
  own confidence `low`/`insufficient` (§1).
- **US and India have different payoff shapes** — US lottery (2 wins of 23),
  India coin-flip (48% at ±2.3%) — both with expectancy indistinguishable from
  slightly negative (§3).
- **The modal exit is a 10-day clock, not a thesis**, in both books (§6).

What is NOT established, despite being written confidently in the first version
of this document: any claim about universe composition, discovery-source quality,
or scorer ranking ability.

**The binding constraint on every question here is matured-label date coverage.**

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

## 4b. CORRECTION (2026-08-06, same day) — §4 and §5 do not survive scrutiny

Everything below in §5 was written, committed, and then **refuted by the next
query**. It is kept rather than deleted because the failure mode is the point.

**The entire matured-label dataset is one fortnight.**

| market | horizon | n | distinct dates | symbols | span |
|---|---|---|---|---|---|
| us | 2d | 536 | 14 | 82 | 07-06 → 07-22 |
| us | 5d | 338 | 11 | 70 | 07-06 → 07-20 |
| us | 10d | 74 | **7** | **18** | 07-06 → 07-14 |
| us | 20d | 4 | **2** | **1** | 07-06 → 07-07 |
| india | 10d | 65 | 7 | 31 | 07-07 → 07-15 |
| india | 20d | 13 | **1** | 13 | 07-07 |

Every IC figure in §4 comes from a single two-week window in July 2026. The
US 10-day IC of **+0.300** rests on 18 symbols over 7 overlapping dates — that is
not evidence of a ranking ability, it is one market fortnight. `n` counts
observations; the effective independent sample is the **date** count, and it is
7. Nothing in §4 supports a claim about the scorer in either direction.

**The §5 watchlist finding is an artefact, and worse than merely thin:**

- 26 observations = **10 symbols × 3 consecutive days** (07-09, 07-10, 07-13)
- All 10 symbols are semiconductors: SOXL, MRVL, ARM, MU, INTC, QCOM, TSM,
  AVGO, NVDA, ASML. It is a **semis watchlist**, measured across one semis
  drawdown. One sector, one week.
- **`entry_eligible = false` on all 26.** The system never bought a single one.

So the cohort blamed for the largest measured loss **had zero influence on the
portfolio**. `metals_basket` (3 symbols, 3 dates) and `region_etf` (3 symbols,
3 dates) are also 0-eligible. Only `holding` (108 eligible) and `null`
(30 eligible) ever produced an eligible US decision — and `holding`'s **median**
excess is exactly **0.0000**, with the −0.94% mean coming from a tail.

The §5 error was also one of attribution: the closed trades named there
(RDDT, HOOD, SMCI) were never in the watchlist cohort. Sharing a "high-beta"
description is not sharing a source. Two separate observations were merged into
one story because the story was tidy.

**What actually survives:** §1 (window too short — already self-labelled), §2
(cash drag, pure arithmetic), §3 (payoff shapes, though on n=23/50), and §6's
raw exit-reason counts. The causal claims in §4 and §5 do not.

**Consequence for the recommendations in §8:** items 1 and 2 were both built on
§5. Demoting the watchlist would be a **no-op that resembles a fix** — it already
buys nothing. The universe-composition thesis has no surviving evidence behind
it. What is genuinely established is that **matured-label date coverage is the
binding constraint on every question this document asks**, including its own.

## 5. Where the US pool goes wrong — this is the finding

> **REFUTED — see §4b.** Retained verbatim as written. Do not act on it.

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

- **Not the LLM.** No LLM touches score direction, sizing, or exits.
- **Not data availability.** Coverage is healthy in System Health.

It does **not** rule out the scorer, the universe, or the exits. Post-§4b, none
of the three has been tested on enough independent dates to convict or acquit.

## 8. What it points at, in priority order (revised after §4b)

1. **Matured-label date coverage.** Every question above is gated on it. At the
   20-day horizon the US has **4 observations across 2 dates on 1 symbol**; India
   has 13 on a single date. Until this grows, each new analysis will keep
   producing confident answers from one market fortnight — as this document
   demonstrated on itself.
2. **The exit layer.** The raw counts are robust: 34 of 50 India exits and 13 of
   23 US exits are the 10-market-day time stop, and stops (−6.35% India, −9.47%
   US) are wide against average wins (+2.31% / +15.86%). This is a design
   observation about the rules as written, not an inference from a short sample,
   which is why it survives §4b.
3. **Cash deployment.** Pure arithmetic (§2) and the only item needing no edge.
   But it is NOT free: deploying into a book whose expectancy is unproven
   increases exposure to an unmeasured quantity. **Sequence: not before (1).**

## 9. Explicitly not proposed here

No threshold change, no weight change, no sizing or concentration change, no exit
rule change, no universe change. Each of those is a money-path decision requiring
its own architecture round and its own predeclared evidence. In particular,
**concentration into 2–3 high-conviction names is contraindicated by §3**:
concentration multiplies edge, and measured US expectancy is −0.97% per trade
with a "confident and correct" sample size of two.

## 10. Open questions for the owner (revised after §4b)

1. **Withdrawn.** "Universe composition" as a tracked program had exactly one
   piece of evidence behind it and that evidence was an artefact. A program
   measuring **decision-label coverage** — the constraint that actually binds —
   is proposed instead.
2. **Withdrawn.** Demoting the US `watchlist` source is a no-op: all 26 of its
   observations are `entry_eligible = false`. It buys nothing today. Making that
   change would produce a commit, a doc update and no behavioural difference,
   while creating the impression the problem was addressed.
3. Are the 8 NULL-P&L closed trades worth backfilling, or is
   `direction_flip → neutral` genuinely a no-P&L close? (Unaffected by §4b.)

## 12. The exit layer — the target cannot be reached before the clock closes the trade

This section survives §4b because it compares the **rules as configured** against
the **holding period they run inside**. It is a geometry argument, not an
inference from a short sample.

Configured geometry, from `paper_positions` (all rows populated):

| market | n | initial stop | price target | nominal R:R |
|---|---|---|---|---|
| us | 14 | −7.46% | +19.37% | **2.60** |
| india | 12 | −7.65% | +19.16% | **2.50** |

Now put that beside the actual excursions over the horizon the book holds for,
from entry-eligible decisions (`avg_atr_pct`: US ≈2.9%, India ≈2.3%):

| market | horizon | avg MFE | avg MAE | stop in ATR | target in ATR | MFE in ATR |
|---|---|---|---|---|---|---|
| us | 10d | **+1.25%** | −3.89% | ≈2.6 | ≈**6.7** | ≈**0.43** |
| india | 10d | **+3.71%** | −3.36% | ≈3.3 | ≈**8.2** | ≈**1.5** |

**The target sits at roughly 5–15× the typical best-case excursion available
inside the holding period.** A position exits on the 11-market-day time stop; in
those 11 days the average US position's most favourable moment is +1.25%, against
a target of +19.37%. The target is not a demanding goal — it is unreachable by
construction, and the realised exits agree: **1 of 73 closed trades exited at
`partial_target`**, against 47 on the time stop.

The stop is the mirror image. At 2.6–3.3 ATR it sits well outside the typical
10-day adverse excursion (≈1.34 ATR), so it also rarely fires — 8 of 73 exits.
When it does fire it has, by definition, already given up ~3 ATR: US `stop_hit`
averages **−9.47%**.

**So the 2.5–2.6 nominal reward:risk never reaches the outcomes.** India's
realised ratio is +2.31% average win against −2.23% average loss — **1.04**, not
2.50. The stop/target pair is decorative; the 11-day clock is the real exit rule,
and it fires at a point neither leg was designed for.

This is a coherent, testable mismatch and it needs no additional data to state:
either the holding period is too short for the target, or the target is too far
for the holding period. Which one to change is a money-path decision and is **not
proposed here**.

### 12b. Five dead columns that nearly produced a sixth wrong finding

`paper_trades.entry_price`, `.stop_loss`, `.take_profit`, `.highest_price` and
`.quantity` are **NULL on all 145 rows**. The live fields are `fill_price` and
`qty`, and the exit path reads stops from `paper_positions`, not `paper_trades`.

Noted because reaching for the obvious-sounding column produced "stop levels are
never persisted, so exits cannot be audited" — which is false, and was one query
away from being written down as fact. The columns are duplicates of live fields
and are a trap for exactly this kind of analysis.

## 11. Method note — why this document refuted itself

The first version passed every check it was given: real production queries, no
fabricated numbers, correct arithmetic, caveats about overlapping windows stated
up front. It was still wrong, because **the caveats were stated and then not
acted on**. "Windows overlap heavily" was written in §4 and the very next section
built a causal story on top of it anyway.

The single query that broke it — `count(distinct ts::date)` alongside `count(*)`
— was cheap and obvious in hindsight. The lesson worth keeping is procedural:
when a cohort's `n` is impressive, **check how many independent dates and symbols
produced it before writing the interpretation**, not after. And check
`entry_eligible` before attributing portfolio damage to a cohort — a source that
never passed the eligibility gate cannot have cost anything.
