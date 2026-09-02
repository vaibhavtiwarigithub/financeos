# Macro dimension — role correction

> Status: **Stage 1 COMPLETE (measure-only, shipped). Stages 2–3 not approved.**
> Created: 2026-09-02 · Stage 1 results added 2026-09-02
> Scope: how `macro_score` enters the entry decision. Money path.
> Owner has confirmed "trade less in a dangerous regime" IS an intended policy
> (§7), which changes the Stage 2 recommendation — see §9.

## 1. What macro is today

`fetchMacroScore` (`lib/data/scores.ts:403`) returns a **single market-wide scalar**
derived from the weekly `macro_regime` row (`week_of` is a Monday;
`kairos-macro-sentinel` runs Mondays 12:30 UTC). It is US-only by construction —
all 8 indicators are US FRED series — and India correctly returns
`available: false`, so India's weights renormalize onto the other four
dimensions.

It carries **weight 0.15** in `computeWeightedAnalystScore`
(`fundamental 0.30 / technical 0.25 / sentiment 0.20 / macro 0.15 / insider 0.10`).

Production, 2026-08-01 onward:

| market | macro available | distinct macro values | avg analyst score |
|---|---|---|---|
| us | 100% (3,970 obs) | 6 (one per week) | 62.99 |
| india | 0% (1,144 obs) | 1 (placeholder 50, excluded) | 74.81 |

## 2. The defect, stated precisely

**Macro is not broken as information. It is misplaced as a ranking input.**

On any given day macro is a constant `c` across every symbol. The composite is

```
analyst = 0.30f + 0.25t + 0.20s + 0.15c + 0.10i
```

Since `0.15c` is identical for every candidate, it **cannot change the ordering
of candidates**. Removing macro and renormalizing gives
`(0.30f + 0.25t + 0.20s + 0.10i) / 0.85` — a positive scalar multiple of the
same quantity, so the ordering is *identical*. This is algebra, not a
measurement, and it needs no evidence floor to assert.

Two consequences follow:

1. Macro's 0.15 weight buys **exactly zero** information about *which* stocks
   are selected.
2. Its entire effect lands on the *level* of every score at once, and therefore
   on **how many** candidates clear the absolute entry threshold of 60.

So macro is, de facto, a **market-timing gate implemented as a weight** — which
makes its timing behaviour implicit, uncalibrated, and invisible. Nobody
declared "at danger_score X, buy less." It emerges from the product of a weight
and a threshold that were each chosen for unrelated reasons.

> This is the correct reading of the `macro` row in the Dimension Rank IC panel:
> `mean IC 0.0000, SD 0.0000, t —, positive days 0%`. That is **not** a
> measurement that macro has no predictive value. Its cross-sectional IC is zero
> **by construction**, because a constant has no cross-sectional variance. The
> panel must not be used to argue macro should be dropped as information.

## 3. Measured impact

Paired symbols across the 2026-08-24 macro update (73 symbols present both days):

| dimension | mean Δ 08-21 → 08-24 | contribution to composite |
|---|---|---|
| fundamental | 0.00 | 0.00 |
| technical | +7.73 | +1.93 |
| sentiment | +0.62 | +0.12 |
| **macro** | **+28.00** | **+4.20** |
| insider | −0.55 | −0.06 |
| **analyst** | **+5.85** | — |

Macro supplied roughly **72% of the entire book-wide re-rating**. Eligibility
share moved **52.6% → 76.0%**; **16 of 73 symbols became newly eligible and 0
lost eligibility**, with no company-specific evidence changing.

Weekly macro values since 2026-08-01: `57, 67, 65, 47, 75, 69`. The 47→75 range
is 28 points, i.e. a **±4.2 point** swing on every US score from a signal that
cannot rank anything.

## 4. Why this matters more than it looks: the rank gate is off

`lib/scoring/rank.ts` implements the cross-sectional half of a **hybrid entry
gate** (absolute threshold AND within-group percentile). It is **inactive**:
`rank_pct_min` defaults to 0 and is only enabled from the champion genome
(`app/api/agents/research/cron/route.ts:557-570`). Neither champion has a genome
at all, so `rank_pct_min` is null.

Verified: `rank_pct` is null and `rank_rejected` is 0 on **every** US signal for
the 14 sessions from 2026-08-18 to 2026-09-02.

This is **off by design, not broken** — the code comment says default 0 means
"gate inactive ⇒ we do NOT touch agent_signals at all". But the consequence is
that **the absolute threshold is currently the only active entry gate**, which is
precisely what makes macro's level shift fully load-bearing. A rank-based gate
is immune to a common level shift by construction.

## 5. Options

**A. Remove macro from the composite; express regime as a declared policy.**
Ordering is provably unchanged (§2). The regime signal becomes an explicit
gate — a sizing throttle or an entry pause at a predeclared danger level.
*Pro:* the timing behaviour becomes visible, calibratable and testable.
*Con:* choosing the policy threshold needs its own evidence, which does not exist yet.

**B. Make macro cross-sectional.** Give each symbol a regime sensitivity (sector
beta), so macro can actually rank. *Con:* requires a sensitivity model that does
not exist — `lib/scoring/instrument-taxonomy.ts` has no volatility or liquidity
buckets. Large speculative build.

**C. Activate the rank gate.** Set `rank_pct_min` on the champion genome so
selection is cross-sectional. A common level shift then cannot change who is
selected, which neutralises the macro churn without touching the macro
dimension at all. *Already built and tested; needs a genome, not new code.*

**D. Do nothing to live behaviour; shadow first.** Record counterfactual
eligibility with macro excluded, for N sessions, and decide from that.

## 6. Recommendation

**D then A, with C evaluated in parallel.**

Stage 1 (measure-only): shadow the macro-excluded composite, recording per
session how many candidates change eligibility. No live change. This is the only
part with no evidence risk.

Stage 2 (needs Stage 1): move macro out of the composite and into a declared
regime policy, with a predeclared threshold and its own falsification test.

Stage 3 (separate decision): whether to activate the rank gate. This is the
highest-leverage available change and requires no new code, but it alters live
selection and therefore needs its own approval and its own shadow.

**Explicitly NOT proposed:** tuning or zeroing the macro weight from the
Dimension Rank IC table. That IC is zero by construction and is not evidence
about macro's value.

## 7. Open question for the owner

Does the intended behaviour "trade less in a dangerous regime" exist as a
deliberate policy? If yes, it should be stated as one and Stage 2 implements it.
If it was never intended and the level effect is incidental, Stage 2 is simply a
removal. The answer changes what Stage 2 builds.

---

## 8. Stage 1 results (measure-only, 2026-09-02)

Implemented as `lib/learning/macro-counterfactual.ts` +
`GET /api/agents/macro-shadow?market=us|india`. It re-scores every recorded
decision with macro excluded, using the PRODUCTION scorer
(`computeWeightedAnalystScore` plus `capEtfLikeScore`) so the shadow cannot
drift from live scoring. Measure-only: it writes nothing and nothing reads it.

**This turned out to be a retrospective replay, not a forward shadow.** The
ledger already stores `weights_used` (effective, post-renormalization),
`availability_mask`, all five dimension scores, the threshold and
`entry_eligible` — 100% populated across all 5,672 US rows. Waiting N sessions
to collect what was already recorded would have delayed the answer for nothing.

### Replay fidelity had to be fixed twice before any number was publishable

| stage | match rate | cause |
|---|---|---|
| first run | 0.8646 | ETF cap not applied |
| after `capEtfLikeScore` | 0.9721 | legacy pre-cap cohort remains |
| analysed set | 1.0000 | unreplayable rows excluded, not guessed |

1. **ETF cap omitted.** 768 rows failed because production caps ETF-like scores
   at 65 after weighting (`research-agent.ts:1714`). This is a KNOWN trap — the
   Evidence Router hit it identically ("recorded=65, replayed=<uncapped>", 45
   failures across 8 symbols), which is why `capEtfLikeScore` is exported. The
   first version of this module repeated the documented mistake.
2. **Legacy cohort.** 158 rows still fail, max gap 35 points, and only 13 are
   within ±1 — so NOT rounding. 149 of 158 fall in 2026-07-06..07-22, ETFs
   recorded at `analyst_score = 100` where the capped replay says 65: scored
   before the cap existed. A row whose PRESENT cannot be reproduced cannot have
   its counterfactual trusted, so those rows are excluded from the flip counts
   **and from the denominator**, never counted as "unchanged".

> A mismatch RATE alone cannot distinguish "3% off by one point" (rounding,
> ignorable) from "3% off by 35" (a missing rule). Reporting only the rate nearly
> ended this investigation at the wrong conclusion; `replayMaxAbsMismatch` and
> `mismatchesByDate` exist because of that.

### The finding

Analysed 5,514 of 5,672 US decisions (158 excluded above).

| metric | value |
|---|---|
| certain eligibility losses without macro | **160 (2.9%)** |
| possible gains (UPPER BOUND) | 53 |
| unchanged | 5,207 |
| mean score delta | −0.68 |

**Macro is already doing what the owner wants, and the sign flips with the
regime — which is the point:**

| week | macro | mean delta without macro | certain losses | possible gains |
|---|---|---|---|---|
| 08-18 … 08-21 | **47** (risk-off) | **+2.2 to +2.6** | 0–3 | 3–20 |
| 08-24 … 08-28 | **75** (calm) | **−1.3 to −2.0** | 6–13 | 0 |
| 08-31 … 09-02 | 69 | −0.9 to −2.1 | 3–11 | 0 |

At macro 47 removing macro RAISES scores — the low regime reading was suppressing
the book. At macro 75 removing it LOWERS them — the calm reading was expanding
the book. That is exactly "trade less in a dangerous regime", already happening.

## 9. Revised recommendation

§6 proposed moving macro out of the composite. **Stage 1 substantially weakens
that**, and the owner has since confirmed the timing behaviour is intended.

The mechanism is crude — a level shift against an absolute threshold, whose
magnitude is a by-product of a weight and a cutoff each chosen for other reasons
— but its DIRECTION is correct and its size is modest (2.9% of decisions, ~1–3
score points). Ripping it out would remove a working behaviour to fix an
aesthetic complaint.

So Stage 2 is no longer "remove macro". It is: **keep the behaviour, make it
explicit and calibratable.** Express the regime response as a declared policy
with a named threshold and its own falsification test, so the amount of
suppression is a choice rather than an artefact. Whether that policy should
throttle SIZING rather than eligibility is the open design question — sizing
degrades smoothly, whereas an eligibility cliff moves a slab of the book at once.

Still **not** proposed: changing macro's weight on the basis of the Dimension
Rank IC table. That IC is zero by construction.

Stage 3 (activate the cross-sectional rank gate) is unchanged and still the
highest-leverage available change: it needs no new code, only a champion genome
with `rank_pct_min`, and it makes selection immune to common level shifts by
construction. It alters live selection, so it needs its own approval and shadow.
