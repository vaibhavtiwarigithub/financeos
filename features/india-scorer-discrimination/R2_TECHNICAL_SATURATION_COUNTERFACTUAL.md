# R2 — Technical-Score Saturation: Frozen Read-Only Counterfactual

**Date:** 2026-08-03 · **Status: NOTHING HERE IS APPROVED.** No scorer, weight,
threshold, anchor, or config was changed. No code was edited. Every number below
came from `SELECT`-only queries against production
(`decision_observations`, `observation_labels`, project `dionkikgdmlaotvtbnfr`).
This document exists so the owner can approve or reject a *specific* formula
change against real numbers. It is not a proposal to ship.

Companion to `DIAGNOSIS.md` §5 / §11-R2 / §14e. Written as a separate file
deliberately — do not merge into `DIAGNOSIS.md`.

---

## 0. Headline

**The ceiling is a clamp, not a step-anchor problem.** The prevailing R2 framing —
"the ±15 / ±10 / ±10 / ±8 step functions are why the composite tops out" — is
**wrong on the production evidence**. Making those four terms continuous
(Variant A) leaves ceiling mass *unchanged* (India 51.6% → 51.3%, US 21.9% →
22.0%) while shifting admission by **+18.7pp India / +25.7pp US**. It is a
threshold cut wearing a discrimination costume.

The saturation is caused by `Math.min(100, ...)` on line 273 of
`lib/data/technicals.ts`. The pre-clamp walk exceeds 100 on **48.7% of India rows
and 19.6% of US rows**. Removing the clamp and rescaling the walk's natural
range (Variant B) collapses ceiling mass to **5.2% India / 0.9% US** at a cost
of **−2.3pp US / +5.5pp India** admission — nearly level-neutral.

**No variant improves forward-return IC in either market.** The label sample
cannot support a claim either way; see §6.

---

## 1. Window, row counts, and a mid-window code-regime caveat

| | value |
|---|---|
| Filter | `scoring_version = 'v1.0' AND ts >= '2026-07-20'` |
| India | n = **347**, 13 as-of dates, 41 symbols, 2026-07-20 → 2026-08-03 |
| US | n = **1,400**, 14 as-of dates, 107 symbols, 2026-07-20 → 2026-08-03 |
| Threshold | `decision_observations.score_threshold = 60` on 100% of rows, both markets |
| Technical weight | India **0.4545** (2 included dims, renormalised); US varies by archetype/mask, read per-row from `weights_used->>'technical'` |

### 1a. Reconstruction fidelity (the check that makes this trustworthy)

The current `scoreTechnicals` was re-implemented in SQL directly from
`features.technical` (rsi14, ema20/50, price, atr14, trend20d, volumeVsAvg20,
dataPoints, lastReturnPct, atrMultipleMove) and compared to the stored
`technical_score`:

| market | n | exact match | mismatch |
|---|--:|--:|--:|
| india | 347 | 309 (89.0%) | 38 |
| us | 1,400 | 1,154 (82.4%) | 246 |

**Every single mismatch was diagnosed and is explained by a mid-window code
change, not by a reconstruction error.** All 284 mismatched rows have
`technical_score = 20` (the breakdown-veto cap) and fire the *weak-close*
condition (`lastReturnPct < 0 AND lastRangeLocation <= 0.25`) while firing
neither ATR-crash nor high-volume-breakdown. Weak close was a **hard veto through
2026-07-31** and was demoted to warning-only from **2026-08-01** (visible cleanly
in the ledger: 0 weak-close rows escape the cap on or before 07-31; 100% escape
it from 08-01). Under the regime-aware rule, reconstruction is exact.

**Consequence, stated plainly:** the as-stored `technical_score` column mixes two
veto regimes. Every comparison below is therefore run against a **current-code
baseline "C"** — the current `scoreTechnicals` recomputed uniformly over all
1,747 rows — so that the counterfactual isolates the *formula* change from the
*veto* change. The as-stored distribution ("V0") is reported alongside for
reference but is not the comparison baseline.

Composite fidelity: `round(Σ score_d × weights_used_d)` reproduces the stored
`analyst_score` on 347/347 India and 1,309/1,400 US rows. The 91 US residuals are
one-point rounding (18 rows) and 7–17-point downshifts consistent with a
contradiction penalty applied after the weighted sum. To preserve that penalty,
every counterfactual composite below is computed as a **delta**:
`analyst_variant = round(analyst_stored + w_tech × (tech_variant − tech_stored))`.

---

## 2. Baseline distributions

### 2a. `technical_score`

| market | series | n | min | p10 | p25 | p50 | p75 | p90 | max | mean | σ | **% ≥99 (ceiling)** | % ≤1 (floor) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| india | V0 as-stored | 347 | 0 | 8 | 20 | 97 | 100 | 100 | 100 | 68.0 | 39.5 | **47.0%** | 4.9% |
| india | **C current-code** | 347 | 0 | 6 | 36 | 100 | 100 | 100 | 100 | 72.4 | 38.6 | **51.6%** | 6.3% |
| us | V0 as-stored | 1400 | 0 | 2 | 14 | 23 | 87 | 100 | 100 | 44.7 | 37.2 | **19.9%** | 8.6% |
| us | **C current-code** | 1400 | 0 | 0 | 9 | 47 | 93 | 100 | 100 | 47.7 | 38.8 | **21.9%** | 12.1% |

C reproduces §5's headline rates (India 43.8% / US 21.9% at ceiling) once the
weak-close regime is normalised. σ ≈ 39 on a 0–100 scale with p25 near 0 and p50
at 100 is the signature of a two-valued variable, not a score.

### 2b. `analyst_score` (composite)

| market | series | n | min | p10 | p25 | p50 | p75 | p90 | max | mean | σ | % ≥99 | **% within ±2 of 60** |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| india | V0 as-stored | 347 | 32 | 52 | 59 | 76 | 93 | 99 | 100 | 75.1 | 17.8 | 13.8% | 5.8% |
| india | **C** | 347 | 32 | 53 | 64 | 79 | 93 | 100 | 100 | 77.0 | 17.4 | 15.6% | 5.2% |
| us | V0 as-stored | 1400 | 17 | 35 | 46 | 56 | 65 | 74 | 88 | 55.5 | 14.2 | 0.0% | 12.1% |
| us | **C** | 1400 | 17 | 35 | 46 | 58 | 67 | 75 | 88 | 56.4 | 14.9 | 0.0% | 12.4% |

The US "% within ±2 of 60" of 12.4% reproduces §14e's 11.6% on this window. The
knife-edge is real and it is the reason §4 exists.

### 2c. Where the ceiling actually comes from

Computed on the pre-clamp walk `W = 50 + rsi + ema50 + ema20 + trend + volume`
(theoretical range −13 … +118):

| market | % rows with W > 100 (clamped high) | % with W < 0 (clamped low) | observed min W | observed max W | % on the flat RSI top (rsi 60–72 → +25) |
|---|--:|--:|--:|--:|--:|
| india | **48.7%** | 5.2% | −11.9 | 118.0 | 37.2% |
| us | **19.6%** | 9.5% | −11.8 | 118.0 | 15.7% |

48.7% vs a 51.6% ceiling rate for India; 19.6% vs 21.9% for US. **The clamp
accounts for essentially the whole ceiling mass in both markets.** The step
anchors are a second-order contributor. The flat RSI segment (60–72 → constant
+25) is the secondary tie source and is *inside* the clamped region for most
rows, so it is currently invisible.

---

## 3. The variants, defined precisely enough to implement

All variants keep the breakdown veto, the `dataPoints < 15 → 50` rule, the
`Math.round`, and the RSI anchor curve **unchanged**. Only the four non-RSI terms
and/or the output clamp differ.

Let `px = features.technical.price`, `atr = atr14`, `e20 = ema20`, `e50 = ema50`,
`vol = volumeVsAvg20`, and `bull` / `bear` be the existing direction test
(`priceVsEma20 === "above" || trend20d === "up"`, and its mirror).

### Variant A — ATR-normalised distance (continuous anchors, clamp retained)

Replaces the three positional/volume step functions with continuous, volatility-
scaled equivalents. This is the literal reading of R2 as written in `DIAGNOSIS.md`.

```
ema50_term = 15 * clamp( ((px - e50) / atr) / 2.0, -1, +1 )   // saturates at 2 ATR
ema20_term = 10 * clamp( ((px - e20) / atr) / 1.0, -1, +1 )   // saturates at 1 ATR
volume_term = (bull ? +8 : bear ? -8 : 0) * clamp( (vol - 1.0) / 0.5, 0, 1 )
trend_term  = unchanged (±10 step)
output      = clamp( round(W_A), 0, 100 )      // clamp RETAINED
```

Falls back to 0 for a term when `atr` is null/0 or the EMA is null.

### Variant B — unclamped rescale (anchors retained, clamp removed)

The minimum possible change. Every existing anchor is kept exactly; only the
truncation is replaced with a linear map of the walk's own analytic range
`[-13, +118]` onto `[0, 100]`.

```
W_C    = 50 + rsi_term + ema50_step + ema20_step + trend_step + volume_step   // existing terms
output = round( 100 * (W_C + 13) / 131 )       // no clamp needed; range is exact
```

### Variant AB — both

Variant A's continuous terms, run through Variant B's rescale (A's walk has the
identical analytic range, so the same map applies).

### Known limitation of all three

`trend20d` is persisted **only as its trichotomised label** (`up`/`down`/`flat`);
the underlying 20-day return is not in `features.technical`, and this
reconstruction is forbidden from refetching market data. **The ±10 trend term
therefore could not be made continuous in any variant.** A real implementation
should also continuise it; this counterfactual understates what a full continuous
technical would achieve on that one term.

---

## 4. Ceiling mass, before vs after

| market | variant | n | min | p10 | p25 | p50 | p75 | p90 | max | mean | σ | **% ≥99** | % ≤1 | distinct values |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| india | C (baseline) | 347 | 0 | 6 | 36 | 100 | 100 | 100 | 100 | 72.4 | 38.6 | **51.6%** | 6.3% | 57 |
| india | A | 347 | 0 | 54 | 73 | 100 | 100 | 100 | 100 | 85.9 | 20.4 | **51.3%** | 0.6% | 55 |
| india | **B** | 347 | 1 | 14 | 38 | 86 | 94 | 95 | 100 | 68.9 | 32.5 | **5.2%** | 0.3% | 63 |
| india | AB | 347 | 9 | 51 | 66 | 86 | 94 | 97 | 100 | 79.3 | 18.6 | **5.8%** | 0.0% | 60 |
| us | C (baseline) | 1400 | 0 | 0 | 9 | 47 | 93 | 100 | 100 | 47.7 | 38.8 | **21.9%** | 12.1% | 95 |
| us | A | 1400 | 0 | 47 | 55 | 73 | 94 | 100 | 100 | 71.9 | 23.0 | **22.0%** | 0.7% | 85 |
| us | **B** | 1400 | 1 | 10 | 17 | 45 | 81 | 94 | 100 | 47.5 | 32.0 | **0.9%** | 0.1% | 91 |
| us | AB | 1400 | 4 | 46 | 52 | 65 | 82 | 94 | 100 | 66.2 | 19.7 | **1.6%** | 0.0% | 87 |

Read this table carefully:

- **Variant A does not reduce ceiling mass at all** (51.6→51.3, 21.9→22.0). It
  compresses the *bottom* of the distribution toward 50 (India p10 6→54, US p10
  0→47, US p50 47→73) and leaves the top pinned. Mean moves +13.5 India /
  +24.2 US. That is a level shift, not a discrimination fix.
- **Variant B is the fix for saturation.** Ceiling 51.6%→5.2% (India),
  21.9%→0.9% (US), with mean essentially unmoved in the US (47.7→47.5) and mildly
  down in India (72.4→68.9).
- **Variant AB** is best on shape (lowest σ, no floor, no ceiling) but inherits
  A's large upward level shift.

---

## 5. THE ADMISSION FLIP TABLE

Baseline = C (current code recomputed uniformly). Threshold = 60 on every row.
Composites carried through the per-row `weights_used->>'technical'` delta so any
contradiction penalty is preserved.

| market | variant | n | pass @ base | pass @ variant | **flip IN** | **flip OUT** | **net pp** | mean composite shift | mean \|shift\| |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| india | A | 347 | 268 (77.2%) | 333 (96.0%) | **65** | **0** | **+18.7** | +6.2 | 6.4 |
| india | **B** | 347 | 268 (77.2%) | 287 (82.7%) | **19** | **0** | **+5.5** | −1.5 | 3.2 |
| india | AB | 347 | 268 (77.2%) | 331 (95.4%) | **63** | **0** | **+18.2** | +3.1 | 7.8 |
| us | A | 1400 | 638 (45.6%) | 998 (71.3%) | **360** | **0** | **+25.7** | +7.4 | 7.5 |
| us | **B** | 1400 | 638 (45.6%) | 606 (43.3%) | **17** | **49** | **−2.3** | 0.0 | 2.0 |
| us | AB | 1400 | 638 (45.6%) | 912 (65.1%) | **309** | **35** | **+19.6** | +5.7 | 7.5 |

### 5a. Named flip samples (largest composite moves)

**Variant A, flip IN — India:** SBIN.NS 07-29 (59→82, tech 20→70) ·
POWERGRID.NS 08-01 (54→77, tech 22→72) · ONGC.NS 07-29 (49→72, tech 10→60) ·
IOC.NS 07-25 (52→75, tech 9→59) · SBIN.NS 07-24 (59→82).

**Variant A, flip IN — US:** INDA 07-25 (31→61, tech 13→61) · IBIT 07-30
(50→71, tech 32→82) · ASHR 07-22 (39→60, tech 14→64) · SPHQ 07-29 (40→61,
tech 7→57) · XAR 07-22 (44→65, tech 8→58).
*A promotes names whose technicals scored 7–32 to 57–82 purely because the
distance to the EMA was under one ATR. A stock below both EMAs on a downtrend is
being re-labelled as neutral-to-positive. Note the flip-ins are heavily ETFs —
low-ATR-relative-drift instruments are exactly what A rewards.*

**Variant B, flip IN — India:** BANKBARODA.NS 07-28 (56→61) · KPEL.NS 07-20
(55→60) · BANKBARODA.NS 07-31 (56→60) · PFC.NS 07-24 (58→62) · MUTHOOTFIN.NS
07-24 (59→63).

**Variant B, flip IN — US:** TSM 07-29 (59→62) · NFLX 07-21 (58→61) · NFLX
07-22 (59→62) · TSM 07-28 (57→60) · ASML 08-01 (58→61).

**Variant B, flip OUT — US:** INDY 08-01 (65→58, tech 93→81) · VTV 07-29
(65→59, tech 100→86) · VTV 07-27 (65→59) · FEZ 08-03 (65→59, tech 100→86).
*B's flip-outs are exactly the names the clamp was manufacturing: technicals
pinned at 100 that the uncapped walk scores in the mid-80s.*

### 5b. Why the flip table is the load-bearing table

`DIAGNOSIS.md` §14e measured 11.6% of US rows within ±2 points of 60; this window
reproduces it at 12.4%. A counterfactual that reported only "ceiling mass fell"
would have let Variant A through as a saturation fix while it silently opened US
admission from 45.6% to 71.3% with **zero** names flipping out — a pure loosening
of the gate. Variant A's composite distribution also *increases* the knife-edge
population (US within ±2 of 60: 12.4% → 15.5%; AB → 21.2%), so it makes the gate
more sensitive, not less, on top of moving it.

---

## 6. Does it rank better? — Spearman IC

Per-(market, as-of-date) Spearman IC of technical score vs
`observation_labels.benchmark_neutral_return`, then averaged across dates
(standard cross-sectional IC). Dates with fewer than 8 labelled names dropped.

**Sample constraint stated up front:** matured labels barely overlap the
counterfactual window. Within `ts >= 2026-07-20` there are only **3 India dates
at h2, 2 at h5, and zero at h10**; US has 3 dates at h2 and 1 at h5. That is not
a sample. The table below therefore uses **every labelled observation in
`decision_observations`** (2026-07-06 → 2026-07-22), which is version-independent
because the reconstruction reads only `features.technical`. **This is a
different, earlier window than §2–§5.**

| market | h | **n dates** | n obs | IC current (C) | IC A | IC B | IC AB | σ(IC) | t(C) | t(A) | t(B) | t(AB) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| india | 2 | **12** | 147 | −0.061 | −0.088 | −0.077 | −0.090 | 0.291 | −0.72 | −1.11 | −0.93 | −1.16 |
| india | 5 | **11** | 130 | −0.087 | −0.111 | −0.132 | −0.140 | 0.264 | −1.09 | −1.41 | −1.85 | −2.02 |
| india | 10 | **7** | 65 | +0.044 | +0.005 | +0.016 | −0.011 | 0.388 | 0.30 | 0.03 | 0.12 | −0.09 |
| us | 2 | **12** | 530 | −0.061 | −0.047 | −0.060 | −0.039 | 0.385 | −0.55 | −0.41 | −0.53 | −0.34 |
| us | 5 | **8** | 332 | +0.163 | +0.188 | +0.155 | +0.185 | 0.205 | 2.25 | 2.29 | 2.06 | 2.07 |
| us | 10 | **2** | 58 | — | — | — | — | — | — | — | — | — |

Honest reading:

- **India: no variant improves IC at any horizon.** Every variant moves h2 and h5
  slightly *more negative*. With 11–12 dates and σ(IC) ≈ 0.27–0.29, none of these
  cells is distinguishable from zero — and none is distinguishable from each
  other either. **This sample cannot decide whether any variant ranks better in
  India.** Reporting the −0.09 vs −0.06 gap as a result would be false precision.
- **US h5** is the only nominally significant cell (IC +0.163, t = 2.25, 8 dates).
  A (+0.188) and AB (+0.185) are nominally higher, B (+0.155) nominally lower —
  all four are within one standard error of each other. Eight dates cannot
  separate them, and eight overlapping dates in one directional tape is not
  out-of-sample evidence of anything.
- **US h10 is undeterminable** (2 dates, `corr` degenerate on one).
- **The clamp removal is nearly rank-preserving by construction**, which is why
  B's IC tracks C's so closely. B fixes *ties*, not *ordering*: it un-collapses
  the 48.7% India / 19.6% US of rows that were all being assigned the identical
  value 100. Whether breaking those ties helps requires outcomes for the tied
  names, which this sample does not have.

---

## 7. Recommendation

**Recommend: Variant B, and only Variant B, and only as a proposal for a frozen
prospective test — not as a merge.**

Reasoning:

1. **It fixes the stated defect and nothing else.** Ceiling mass 51.6% → 5.2%
   (India) and 21.9% → 0.9% (US). Floor mass likewise collapses.
2. **It is nearly admission-neutral.** US −2.3pp net (17 in / 49 out); India
   +5.5pp (19 in / 0 out). Every other variant is a 19–26pp gate loosening in
   disguise, which §14e says must be treated as a threshold change requiring its
   own approval.
3. **It is the smallest possible diff** — delete the `Math.max(0, Math.min(100,…))`
   truncation and replace it with the `(W + 13) / 131 × 100` map. No anchor, no
   weight, no threshold moves. Every existing calibration decision survives.
4. **It flips out exactly the right names** (VTV, FEZ, INDY at technical 100 →
   81–86), which is the mechanism it is supposed to correct.

**Reject Variant A as specified in R2.** The evidence contradicts R2's premise:
continuising the step anchors does not reduce ceiling mass (51.6→51.3,
21.9→22.0) because the anchors were never the binding constraint. What A does is
compress the lower half toward 50 and admit 360 extra US observations with zero
offsetting exclusions. `DIAGNOSIS.md` §11-R2 should be corrected on this point.

**Do not adopt AB yet.** It has the best distributional shape but carries A's
+19.6pp US / +18.2pp India admission shift. If continuous positional terms are
wanted, they must be proposed with a *simultaneous* threshold recalibration and
approved as a combined change, not slipped in as a saturation fix.

**Sequencing, if B is ever pursued:** B is a scoring change with a −2.3pp US /
+5.5pp India admission side effect. It should be frozen behind a shadow score
column and run prospectively for ≥ 20 independent labelled dates per market
before it touches the live `technical_score`. R2 remains a *blocker* for R1 only
in the sense that the ceiling ties make any cross-sectional rank degenerate —
B removes the ties; it does not by itself supply the ranking evidence R1 needs.

---

## 8. What this cannot tell us

1. **Whether any variant predicts better.** §6 is the honest answer: 7–12
   independent as-of dates per cell, σ(IC) ≈ 0.2–0.39, no cell separable from any
   other. This counterfactual establishes that B fixes *saturation*; it does
   **not** establish that B fixes *ranking*. Ceiling reduction was never the goal
   and this document does not claim to have hit the real one.
2. **The IC window is not the flip window.** Flip and distribution results cover
   2026-07-20 → 08-03. IC covers 2026-07-06 → 07-22, because matured labels do
   not yet exist for the later window. They are two different tapes.
3. **The trend term could not be continuised.** Only `trend20d`'s trichotomised
   label is persisted, not the raw 20-day return, and refetching market data was
   out of scope. All three variants keep a ±10 step there.
4. **Single-regime, single-direction tape.** ~4 weeks, 41 India / 107 US symbols,
   one market regime. Nothing here says how B behaves in a drawdown.
5. **The as-stored baseline is contaminated.** 284 of 1,747 rows carry a
   superseded weak-close hard veto (§1a). All comparisons run against the
   current-code baseline C instead, which is correct for the counterfactual but
   means the "before" column is not literally what production emitted.
6. **The `(W + 13) / 131` rescale is analytic, not fitted.** It maps the walk's
   theoretical range, not its empirical one (observed −11.9 … +118.0). An
   empirical or percentile-based map would spread the middle further and was not
   tested here; a percentile map would also be date-dependent, which changes the
   score's meaning from absolute to cross-sectional and belongs with R1, not R2.
7. **No causal claim about India vs US.** B helps both markets. It does not
   explain why India's *level* runs higher; §5 of `DIAGNOSIS.md` attributes that
   to the missing insider/macro level penalties, which B does not touch.
8. **Ordering within the veto cohort is untouched.** All vetoed rows still take
   the flat cap of 20 in every variant. That is its own tie mass and was
   deliberately left alone.

---

**Nothing in this document is approved. No code was changed. All queries were
read-only.**
