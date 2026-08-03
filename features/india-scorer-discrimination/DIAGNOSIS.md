# India Scorer Discrimination — Diagnosis

Status: **Diagnosis only. Nothing approved. No code, threshold, weight, or config changed. No data written.**

Date: 2026-08-02
Protocol: `CLAUDE.md` §"Scoring Data-Truth Review Protocol"
Evidence source: production Postgres (Supabase project `dionkikgdmlaotvtbnfr`), read-only `execute_sql`.
Follows from: `features/scoring-data-truth/THRESHOLD_RECALIBRATION_PROPOSAL.md` §"India is a separate problem".

---

## 0. Verdict up front

**(b) — the scorer does not discriminate on the India input set. It is not primarily a threshold problem, and it is not fine.**

But the mechanism is **not** the one hypothesised in the brief. The evidence says:

1. **Renormalisation is NOT the cause.** Applying India's exact 2-dimension
   renormalised weights (`fundamental` 0.5455 / `technical` 0.4545) to the US
   observation set moves the US pass rate from **40.6% → 42.2%**. The mechanism is
   ~1.6pp, i.e. essentially neutral. The hypothesis is falsified on production data.
2. **The distribution is not compressed. It is shifted up and is wider than the US.**
   India σ = 16.97 vs US σ = 15.09; India median 75 vs US 57. A compression story
   predicts the opposite.
3. **The real cause is the input set plus an absolute threshold.** India's two
   surviving dimensions both sit far higher than their US counterparts
   (fundamental 81.0 vs 64.7; technical 67.5 vs 44.9), on a **41-symbol** curated
   large-cap universe observed over 13 sessions in an uptrend. A fixed cut at 60
   applied to an already-pre-filtered, trending, tiny universe admits ~3 in 4
   by construction.
4. **Secondary contributor:** India structurally never pays the two dimensions
   that act as near-constant *level* penalties in the US — `insider` (93.5% of
   scored US rows are exactly 10) and `macro` (US range 57–62, σ 2.26). Neither
   discriminates in the US either; they just lower the US level into the dense
   part of the distribution around 60. So the "healthier" US 43.8% is itself
   partly an artifact.

Threshold changes would move the pass rate but would not create discrimination.
That is why this is (b) and not (a).

---

## 1. Scope, windows, and what "post-fix" means

`decision_observations` has three distinct regimes. Mixing them invalidates any
rate, so every table below states its window.

| Window | Boundary evidence |
|---|---|
| Pre-`v1.0` | `scoring_version IS NULL`, US 173 rows (07-06→07-10), India 37 rows (07-07→07-10). Excluded everywhere below. |
| `v1.0`, pre-macro-leak-fix | India rows with `availability_mask->>'macro' = true` exist **only** 2026-07-13 → 2026-07-17 (58 rows). India macro is unavailable by construction in `lib/data/scores.ts:373`. Fixed from 07-20. |
| `v1.0`, post-scoring-truth-fix | First rows carrying the corrected fundamental evidence keys (`pe_scoring_status`) appear US **2026-07-31**, India **2026-08-01**. |

Primary analysis window: **`scoring_version='v1.0' AND ts >= 2026-07-20`**
(India n=329 / 13 dates / 41 symbols; US n=1281 / 13 dates / 106 symbols).
This is the current architectural regime (no macro leak, India = 2 dims). The
strictly post-fix window is reported separately because **India has only 23 rows
in it** — stated plainly rather than glossed.

Authoritative threshold confirmed in the ledger itself: `score_threshold = 60`
on 100% of rows, both markets. `strategy_config.score_threshold` (52) is inert
and was not consulted.

---

## 2. Production score distribution — India vs US, side by side

### 2a. Primary window (`v1.0`, ts ≥ 2026-07-20)

| Metric | India | US |
|---|---:|---:|
| n | 329 | 1281 |
| distinct symbols | 41 | 106 |
| distinct dates | 13 | 13 |
| mean | 74.9 | 55.4 |
| median | 76 | 56 |
| σ | 17.65 | 22.70¹ |
| **pass ≥ 60** | **73.6%** | **40.6%** |
| pass ≥ 70 | 60.5% | 18.6% |
| pass ≥ 75 | 54.7% | 8.6% |
| pass ≥ 80 | 40.4% | 3.1% |
| pass ≥ 85 | 32.8% | 0.8% |
| percentile of 60 | p26 | p59 |

¹ σ in this row is from the F+T reconstruction column; the actual-score σ over
the full `v1.0` set is India 16.97 / US 15.09 (§2b). Both orderings agree that
India is **not** narrower than the US.

### 2b. Full `v1.0` set (07-13 → 08-03), full quantile ladder

| | n | min | p10 | p25 | p50 | p75 | p90 | max | σ | pass ≥60 | in [55,65] | =0 | ≥99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **India** | 391 | 32 | 53 | 59 | **75** | 87 | **99** | 100 | 16.97 | **74.2%** | 18.9% | 0 | **45 (11.5%)** |
| **US** | 1571 | 17 | 35 | 46 | **57** | 68 | 76 | **93** | 15.09 | **43.6%** | 27.6% | 0 | **0 (0.0%)** |

The India ceiling mass is the headline shape defect: **11.5% of India composite
scores are ≥ 99 and the 90th percentile is 99.** The US composite never reaches
99 at all (max 93). A gate cannot rank names that are all pinned at the top.

### 2c. Strictly post-scoring-truth-fix window (India ts ≥ 08-01, US ts ≥ 07-31)

| | n | min | p10 | p25 | p50 | p75 | p90 | max | σ | pass ≥60 | in [55,65] |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| India | **23** | 43 | 50.8 | 55 | 84 | 97.5 | 99.8 | 100 | 20.41 | 69.6% | 4.3% |
| US | 177 | 17 | 34 | 43 | 56 | 65 | 74 | 86 | 15.23 | 42.9% | 32.8% |

India n=23 is **not** decision-grade. It is consistent with the larger window
(69.6% vs 73.6%) and with the proposal's 77.2% estimate, but it cannot on its own
support any calibration. Note also the near-threshold density: only 4.3% of India
rows land in [55,65] versus 32.8% of US rows — India's mass is nowhere near the
gate, which is another way of saying the gate is not doing work.

---

## 3. Per-dimension availability, read from the authoritative mask

Read from the `availability_mask` jsonb column and cross-checked against
`features->'weighting'->'included_dims'` — never from a non-null score.

### 3a. Availability rate (`v1.0`, full set)

| Dimension | India | US |
|---|---:|---:|
| fundamental | **99.0%** | 70.7% |
| technical | 99.7% | 98.7% |
| sentiment | **0.0%** | 96.2% |
| macro | **14.8%** (leak, §3c) | 100.0% |
| insider | **0.0%** | 38.9% |
| **mean included dims** | **2.14** | **4.05** |

### 3b. Realised dimension combinations (`v1.0`, full set)

| Market | included_dims | n | mean score | pass ≥60 |
|---|---|--:|--:|--:|
| india | fundamental, technical | 330 | 75.2 | 74.2% |
| india | fundamental, technical, macro | 57 | 68.4 | 77.2% |
| india | technical (thin/abstain) | 3 | 50.7 | 33.3% |
| india | macro (thin/abstain) | 1 | 59.0 | 0.0% |
| us | fund, tech, sent, macro, insider | 603 | 56.0 | **37.1%** |
| us | fund, tech, sent, macro (**no insider**) | 482 | 60.5 | **58.1%** |
| us | tech, sent, macro | 425 | 54.6 | 39.1% |
| us | fund, tech, macro | 18 | 54.8 | 50.0% |
| us | macro only (thin) | 19 | 51.5 | 0.0% |
| us | tech, macro | 15 | 44.5 | 13.3% |
| us | fund, tech, macro, insider | 8 | 61.9 | 50.0% |
| us | sent, macro | 1 | 46.0 | 0.0% |

Read the two bolded US rows together: **dropping the insider dimension alone
moves the US pass rate 37.1% → 58.1%.** India never carries insider. This is a
large part of the cross-market gap and it has nothing to do with India.

### 3c. India macro leak — historical, already fixed, still in the ledger

India rows with `macro` marked available exist only on 5 dates:

| date | n | macro_score min | max |
|---|--:|--:|--:|
| 2026-07-13 | 13 | 100 | 100 |
| 2026-07-14 | 8 | 60 | 60 |
| 2026-07-15 | 8 | 60 | 60 |
| 2026-07-16 | 8 | 60 | 60 |
| 2026-07-17 | 21 | 60 | 60 |

58 rows total, including the 13 rows at macro_score 100 that the code comment at
`lib/data/scores.ts:296-302` already documents. **Not a live defect** — zero
occurrences from 2026-07-20 onward. But these 58 rows are immutable ledger
entries feeding `observation_labels`, the learner, and any IC study, and they
carry a US macro verdict stamped onto Indian equities. Flagged, not fixed.

### 3d. Thin-evidence / abstain rate

| Market | rows with <2 included dims |
|---|---:|
| India | 3 / 329 (0.9%) |
| US | 18 / 1281 (1.4%) |

India operates at **exactly** the 2-dimension minimum on 100% of its scored rows.
It is one dimension away from abstaining on every single name. There is no
redundancy: a single Yahoo fundamentals outage would push the entire India book
to abstain.

---

## 4. The renormalisation effect, quantified — hypothesis falsified

Three read-only reconstructions over the primary window, computed purely from
stored per-dimension score columns. No writes, no re-scoring.

| Reconstruction | India mean | India pass ≥60 | US mean | US pass ≥60 |
|---|--:|--:|--:|--:|
| **Actual production score** | 74.9 | **73.6%** | 55.4 | **40.6%** |
| **A. Force India's 2-dim renorm on both** (0.5455·F + 0.4545·T) | 74.9 | 73.6% | 55.7 | **42.2%** |
| **B. Force fixed 5-way split, unavailable dims filled at neutral 50** | 63.8 | 65.7% | 55.6 | 37.2% |

### What this decides

**Reconstruction A is the decisive test.** If renormalisation were the driver,
imposing India's exact renormalised weight vector on US names would inflate the
US pass rate toward India's. It does not: **40.6% → 42.2%, a 1.6pp move.** The
renormalisation *mechanism* is close to neutral. The brief's hypothesis is
**falsified on production data**.

**Reconstruction B bounds renormalisation's contribution.** Under the old
fixed-5 behaviour with fabricated neutral-50 fills, India would still pass
**65.7%**. So of India's 73.6%:
- ~**7.9pp** is attributable to renormalisation removing the neutral-50 drag
  (and B's fills are themselves fabricated evidence, so this is a ceiling on the
  effect, not a fair baseline);
- the remaining **65.7pp** is the input distribution.

Note also that B *compresses* India (σ 9.79 vs 17.65) — the neutral-50 fills were
the compressing force, not the renormalisation. Renormalisation **widens** India's
distribution while shifting it up.

### Where the level gap actually comes from

Decomposing the shared F+T formula:

| | fundamental contribution | technical contribution | total |
|---|--:|--:|--:|
| India | 0.5455 × 81.0 = **44.2** | 0.4545 × 67.5 = **30.7** | 74.9 |
| US | 0.5455 × 64.7 = **35.3** | 0.4545 × 44.9 = **20.4** | 55.7 |
| **gap** | **+8.9** | **+10.3** | **+19.2** |

The 19-point gap splits roughly evenly between the two dimensions. Both India
inputs are genuinely higher. This is an input problem, not a weighting problem.

---

## 5. Per-dimension distributions (availability-masked)

Computed only over rows where the mask says the dimension is available.

| market | dim | n | min | p10 | p50 | p90 | max | σ | mean | % ≥99 | % =50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| india | fundamental | 387 | 29 | 56 | **88** | 100 | 100 | 17.89 | **81.2** | **21.4%** | 0.0% |
| india | technical | 390 | 0 | 8.9 | **93** | 100 | 100 | 39.63 | 65.5 | **43.8%** | 1.3% |
| india | macro (leak) | 58 | 60 | 60 | 60 | 100 | 100 | 16.83 | 69.0 | 22.4% | 0.0% |
| us | fundamental | 1111 | 0 | 25 | 76 | 100 | 100 | 28.53 | 68.8 | 14.1% | 0.0% |
| us | technical | 1551 | 0 | 3 | **28** | 100 | 100 | 37.90 | 47.4 | 21.9% | 0.4% |
| us | sentiment | 1511 | 0 | 49 | 67 | 80 | 100 | 14.16 | 65.5 | 3.8% | 2.4% |
| us | macro | 1571 | 57 | 57 | 60 | 62 | 62 | **2.26** | 59.3 | 0.0% | 0.0% |
| us | insider | 611 | 10 | **10** | **10** | **10** | 90 | 11.80 | **12.8** | 0.0% | 3.1% |

Three defects visible here, two of which are cross-market:

1. **`technical_score` is effectively binary, both markets.** It is an additive
   ±68-point walk around a 50 baseline (`lib/data/technicals.ts:224-270`) that
   saturates. India: 43.8% at ceiling, 7.6% at floor. US: 21.9% ceiling, 13.5%
   floor. Under India's 0.4545 weight this contributes a ~45-point bimodal jump
   to the composite. Combined with a top-coded fundamental, the composite
   inherits the bimodality — which is exactly the observed India shape
   (p50 = 76, p90 = 99).
2. **`insider_score` does not discriminate in the US; it is a constant level
   penalty.** 503 of 538 scored US rows (93.5%) are exactly **10**, i.e.
   `buyRatio = 0` in `scoreInsider` (`lib/research-agent.ts:151`). Distribution
   of scored US insider values: `10 → 503`, `50 → 18`, `48 → 10`, `90 → 7`. At
   0.10 weight this is a near-uniform −4-point shift, not a signal.
3. **`macro_score` does not discriminate in the US either** — range 57–62, σ 2.26,
   identical across all names on a given date. It is a market-wide level term
   carrying 0.15 weight.

Together (2) and (3) apply ~25% of US weight to two terms that are constant
cross-sectionally on any given day. They move the US *level* down into the dense
region around 60 and thereby manufacture the "healthier" 43.8% US pass rate.
**The US baseline this diagnosis is being contrasted against is itself partly an
artifact.** India simply lacks the artifact.

---

## 6. Every default / fallback in the India scoring path, with production hit rate

Enumerated from `lib/data/scores.ts` and `lib/research-agent.ts`. "Reaches the
weighted score" is the money-path question — a default that is masked out is
excluded from the score entirely.

| # | Default | Code | India hit (primary window) | US hit | Reaches weighted score? |
|--:|---|---|--:|--:|---|
| 1 | ETF fundamental baseline 55 | `scores.ts:118` | **0 / 329** | 0 / 1281 | Would (ETF path) — never fires |
| 2 | "No fundamental data" baseline 55 | `scores.ts:124` | **3 / 329 (0.9%)** | 317 / 1281 (24.7%) | **No** — all 3 / all 317 masked out |
| 3 | Sentiment neutral 50 (all branches) | `scores.ts:225,249,276` | **329 / 329 (100%)** | 42 / 1281 (3.3%) | **No** — masked out on 100% of India rows |
| 4 | Insider neutral 50 | `scores.ts:476`, `research-agent.ts:121,129,142,147,156` | **329 / 329 (100%)** | 743 / 1281 (58.0%) | **No** — masked out |
| 5 | India macro neutral 50 (hard-coded) | `scores.ts:373-386` | **329 / 329 (100%)** | n/a | **No** — `available:false` by construction |
| 6 | Macro stale/failed → 50 | `scores.ts:403,437,469` | n/a | 0 / 1281 | **No** |
| 7 | Sector P/E omitted (unmapped taxonomy) | `scores.ts:151` | **0 / 23** post-fix | 16 / 87 post-fix | Omits component (no default assigned) |
| 8 | `scoreTechnicals` <15 candles → 50 | `technicals.ts:225` | 1.3% of India tech rows sit at exactly 50 | 0.4% | Gated by `technicalDataPoints >= 15` |
| 9 | Breakdown veto hard-cap 20 | `technicals.ts:236` | present in evidence, `vetoed:false` on sampled rows | — | Yes when it fires |
| 10 | Equal-split when all included weights are 0 | `weighted-score.ts:50` | 0 | 0 | Never fires |

**Cross-check performed:** zero rows in either market have a default-valued
dimension that the mask nonetheless marks available.

```
fund_default_but_included:  india 0 / us 0
f55_excluded:               india 3 / us 317   (all correctly masked out)
s50_excluded:               india 329 / us 42
i50_excluded:               india 329 / us 743
m50_excluded:               india 329 / us 0
```

**Conclusion for protocol §2: there is no silent money-path default in the India
scoring path.** The availability mask is doing its job correctly. This rules out
the most obvious explanation and is a genuinely clean result for the fix that
landed earlier. The 74% pass rate is *not* caused by fabricated neutral evidence.

---

## 7. Provider taxonomy / units / enum mapping coverage

Post-fix rows only (India n=23, US n=87 with the corrected evidence keys).

| market | pe_scoring_status | n | mean fundamental | % at ≥99 |
|---|---|--:|--:|--:|
| india | applied (`yahoo_sector`, mapping `direct`) | 23 | 83.5 | 30.4% |
| us | applied (`finnhub_industry`, mapping `crosswalk`) | 47 | 84.8 | — |
| us | applied (`yahoo_sector`, mapping `direct`) | 3 | 97.0 | — |
| us | omitted_unmapped_sector | 16 | 71.8 | 0.0% |
| us | omitted_missing | 18 | 19.6 | 0.0% |
| us | omitted_outlier | 5 | 70.6 | 0.0% |

**India sector mapping coverage is 23/23 = 100% `direct` via `yahoo_sector`**, with
zero unmapped keys. Yahoo returns GICS-style sector names ("Consumer Defensive",
"Financial Services") which hit `SECTOR_PE_NORM` directly. The US path goes
through the `finnhub_industry` crosswalk and loses 16/87 (18.4%) to
`omitted_unmapped_sector`.

**This is a real asymmetry and it runs in the wrong direction for India's pass
rate**: India gets the P/E component applied nearly always; the US omits it on
~18% of names. But note the *units* concern the protocol asks about:
`SECTOR_PE_NORM` is a table of **US sector-median P/Es** (technology 30,
financials 14, energy 12, …) applied unchanged to Indian equities. NSE large-cap
sector P/Es are structurally different from US ones. Applying a US benchmark to
an Indian name systematically biases `pe_vs_sector_ratio`. Observed post-fix
India ratios cluster near or below 1.0 (ITC 0.81 → +8; AXISBANK 0.99 → +8),
awarding the bonus band rather than the penalty band.

Field availability (primary window):

| market | profit_margin | roe | eps | rev_growth | pe_ratio |
|---|--:|--:|--:|--:|--:|
| India | 99.1% | 78.7% | 99.1% | 99.1% | 99.1% |
| US | 72.3% | 72.4% | 72.4% | 72.3% | 62.0% |

Yahoo fills India's fundamental fields far more completely than the US provider
chain fills the US ones. `scoreFundamentals` is **additively asymmetric**: each
present field can add up to +20/+15/+15/+5/+15 but subtracts only −20/−10/−10/−10
and only on genuinely bad readings. More fields present on a profitable large-cap
therefore means a higher score almost monotonically. India's fundamental mean of
**81.0 with 20.4% top-coded at 100** is that mechanic meeting a universe of 41
profitable NSE large caps.

---

## 8. Does the India score rank forward returns? (protocol §5)

Joined `decision_observations` to `observation_labels` on
`benchmark_neutral_return`, ranked within `(market, as-of date)`.

| market | horizon | n | independent dates | symbols | Pearson IC | Spearman IC | mean bn-return, pass | mean bn-return, fail |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| india | h2 | 114 | 9 | 36 | −0.098 | 0.018 | +0.0011 | −0.0003 |
| india | h5 | 93 | 8 | 34 | 0.009 | −0.001 | +0.0086 | +0.0030 |
| india | h10 | 28 | **3** | 27 | 0.234 | 0.105 | +0.0063 | −0.0155 |
| us | h2 | 363 | 9 | 81 | −0.179 | −0.098 | −0.0021 | +0.0090 |
| us | h5 | 165 | 6 | 64 | 0.129 | 0.178 | −0.0006 | −0.0131 |
| us | h10 | 2 | 2 | 1 | — | — | — | — |

**Interpretation: India's IC is indistinguishable from zero at h2 and h5, the two
horizons with usable date counts.** Spearman 0.018 and −0.001. The h10 value of
0.234 rests on **3 independent dates** and must not be read as evidence of skill.
US IC also flips sign by horizon.

This is consistent with, but does not by itself prove, verdict (b). Neither
market's score demonstrates outcome discrimination on this data. The distinction
is that the US score at least *separates names* cross-sectionally; the India
score does not separate them and also does not predict.

**Stated plainly: there are not enough independent post-fix market dates to fit
or validate a threshold in either market, and this diagnosis does not attempt to.**

---

## 9. Duplicate scorer / endpoint search (protocol §8)

- Both markets write `score_source = 'deterministic_v1'` on 100% of rows in the
  primary window. No second scorer is writing to the ledger.
- `computeWeightedAnalystScore` (`lib/scoring/weighted-score.ts`) is the single
  shared implementation, consumed by `lib/research-agent.ts` and
  `lib/validation/engine.ts`. No drifted copy found.
- `rank_score`, `final_score`, `p_win`, `setup_type`, `expected_return_bps` are
  **entirely NULL** (0 / 1610 rows). The cross-sectional rank machinery
  (`lib/scoring/rank.ts`, `features/cross-sectional-rank/`) exists in code but is
  **not populating production**. This is directly relevant to the remedies below.
- `evidence_confidence` is populated on 100% of rows and is not currently used as
  a gate.

---

## 10. Verdict

**(b), with a specific and testable mechanism — and it is not the one the brief
proposed.**

The India gate admits 73.6% of scored names because:

1. **The gate is absolute where the problem is relative.** A fixed cut at 60
   applied to a **41-symbol** curated NSE large-cap universe over a 13-session
   window in which 73.6% of observations were above their EMA20 and mean RSI14
   was 58.1. In the US the same window had 42.0% above EMA20 and mean RSI14 49.8.
   The score is functioning as a market-direction proxy, and India's window was
   directional. A rising market makes an absolute threshold vacuous.
2. **Both surviving India dimensions are top-heavy and one is binary.**
   Fundamental mean 81.0 with 20.4% top-coded at 100; technical 43.8% at ceiling
   and 7.6% at floor. A weighted average of a top-coded score and a near-binary
   score cannot produce a discriminating continuum — hence India p90 = 99 and
   11.5% of composites ≥ 99.
3. **Two dimensions are structurally absent, and the ones that are absent are
   precisely the two that (mis)calibrate the US level.** Insider (93.5% constant
   at 10) and macro (σ 2.26) are level terms, not discriminators. India does not
   pay them. Removing insider alone lifts US pass 37.1% → 58.1%.
4. **Renormalisation is not the cause** (§4, Reconstruction A: 40.6% → 42.2% when
   imposed on the US). It contributes at most ~7.9pp of India's 73.6% (§4,
   Reconstruction B), and it *widens* rather than compresses.
5. **It is not a silent-default problem.** §6 proves zero default leakage into the
   weighted score in either market.

**Why not (a):** raising the India threshold to ~79 would reproduce the US 40.6%
admission rate, but §5 and §8 show the India score does not order names by
anything (43.8% tied at the technical ceiling, IC ≈ 0). Cutting a non-ordering
score at a higher point selects on noise more confidently. A threshold move
changes *how many* pass; it cannot create the ranking the gate needs.

**Why not (c):** a legitimate "pre-filtered universe" defence would require the
India screener to be doing the discrimination upstream, with the score acting
only as a veto. That defence fails on its own terms — `entry_eligible` is 73.3%
for India (vs 40.4% US), i.e. the score gate is the *last* filter and it passes
almost everything through to the portfolio layer. The only thing standing between
a 73.6% admission rate and the book is position sizing and the name cap. On a
41-symbol universe with 2 dimensions and 0.9% margin to abstain, that is not a
deliberate design; it is an unexamined consequence.

---

## 11. Candidate remedies — ranked PROPOSALS, explicitly NOT approved

None of these is approved. None has been implemented. Each states the evidence
that would justify it.

### R1 — Make the India gate cross-sectional (rank-based) rather than absolute
**Highest expected value.** Replace/augment the absolute 60 cut with a
within-(market, date) percentile cut over the day's scored cross-section. This
directly addresses the mechanism: it is invariant to the market-wide level shift
that a directional window produces, and it forces the gate to *order* names.

- The machinery may already exist: `lib/scoring/rank.ts` and
  `features/cross-sectional-rank/FEATURE_ARCHITECTURE.md`. `rank_score` /
  `final_score` are NULL on 100% of production rows — **verify whether that
  feature is built-but-unwired before proposing new code.**
- Evidence to justify: a frozen read-only replay showing, per India date, which
  names a top-k rank cut admits versus the current absolute cut, plus IC of the
  rank-cut cohort vs the absolute-cut cohort at h5/h10 once ≥ 20 independent
  post-fix India dates exist.
- Blocker: 41 symbols and typically 18–43 observations/day. A percentile cut on a
  20-name cross-section is itself noisy. Needs a universe-size floor.

### R2 — Fix `technical_score`'s saturation before touching any threshold
43.8% of India technical scores are at the ceiling and 21.9% of US. A dimension
that is binary on ~half its inputs cannot rank. Candidates: continuous anchors
for the EMA20/EMA50/trend/volume terms (they are currently ±15/±10/±10/±8 step
functions), or normalising the raw walk to a distribution rather than clamping.

- Evidence to justify: the ceiling/floor rates in §5, plus a read-only
  reconstruction showing the composite's ceiling mass under a continuous
  technical, per market.
- Note this fixes both markets, not just India — it is not an India patch.

### R3 — Give India a third and fourth dimension so it stops running at the abstain floor
India is at exactly 2 included dimensions on 100% of rows (§3d). Two candidates
already exist in the codebase and are currently *thesis evidence only*:
- `lib/india-macro.ts` (NSE FII/DII flows) → a genuine India macro dimension;
- GDELT news sentiment (per the India data-coverage memory) → an India sentiment
  dimension.

- Evidence to justify: production coverage/freshness of each source per India
  trading day, and a demonstration that each has non-degenerate cross-sectional
  variance (the US macro dimension's σ of 2.26 is the anti-pattern to avoid —
  do not add a fourth constant).
- Caution: FII/DII flows are market-wide, so as a *macro* term they would be
  another constant. They would add level, not discrimination. Prefer the
  per-symbol sentiment source if only one can be built.

### R4 — Correct the US-derived sector P/E benchmark for India
`SECTOR_PE_NORM` is a US sector-median table applied unchanged to NSE names
(§7). This biases India's `pe_vs_sector_ratio` and feeds the +18/+8 bonus bands.

- Evidence to justify: production distribution of India `pe_vs_sector_ratio` by
  sector against actual NSE sector medians; a frozen flip table for the P/E
  component under India-local norms.
- Lower priority: only 23 India rows carry the corrected evidence so far, and
  the component is one of five in `scoreFundamentals`.

### R5 — Re-examine `insider_score` and `macro_score` as US *level* terms
Not an India remedy, but it changes the baseline this diagnosis is measured
against. Insider is a constant 10 on 93.5% of scored US rows; macro has σ 2.26.
Together they carry 0.25 of US weight while contributing no cross-sectional
information. The US 43.8% pass rate is partly their artifact.

- Evidence to justify: the §5 distributions, plus IC of each dimension alone
  against matured labels once enough dates exist.
- Do **not** act on this concurrently with any India change — it would confound
  both observation windows.

### R6 — Raise the India threshold (quantile-match to US ~79)
**Listed for completeness and recommended against**, consistent with the
rejection of Option A in `THRESHOLD_RECALIBRATION_PROPOSAL.md`. It would
reproduce a US admission rate that is itself an artifact (§5), on a score with
IC ≈ 0 (§8), while changing nothing about ordering. Any such write belongs in
market-local `trading_mandates`, never `strategy_config`.

- Evidence that would change this: ≥ 20 independent post-fix India dates with
  matured h5/h10 labels showing a monotone score→return relationship, plus a
  predeclared objective covering return, drawdown, turnover, and costs.

### Suggested sequencing
R2 (fix the saturating input) → R1 (make the gate relative) → R3 (add real
dimensions) → R4 → R5. **R6 only if R1–R3 land and a threshold is still
mis-set.** Changing the threshold first would lock in a number fitted to a broken
score shape, which is exactly the failure the prior proposal identified.

---

## 12. What could NOT be determined

Stated plainly rather than glossed.

1. **Post-scoring-truth-fix India is n=23 over 2 dates.** Every "post-fix" India
   number here is directional only. The primary window (n=329) mixes pre- and
   post-fix fundamental scoring; the fix's effect on India could not be isolated.
2. **No decision-grade outcome evidence.** 3–9 independent as-of dates per
   horizon per market. India h10 has 3 dates. Nothing here can fit or validate a
   threshold, and this diagnosis does not attempt to.
3. **Whether India's 74% is "wrong" in P&L terms is unproven.** The diagnosis
   establishes that the gate does not *discriminate*. Whether admitting 74% of a
   curated NSE large-cap universe would have lost money is not answerable from 13
   sessions in a single directional regime. India h5 mean benchmark-neutral
   return was positive for both pass (+0.0086) and fail (+0.0030) cohorts.
4. **Regime confounding is not separable.** The 13-session window was directional
   for India and choppy for the US. How much of the 19-point input gap is
   structural (universe quality) versus transient (regime) cannot be decided
   without a longer history or a replay across regimes.
5. **`lib/scoring/rank.ts` was not audited.** It was located and confirmed
   unpopulated in production (`rank_score` NULL on 1610/1610 rows), but whether it
   is complete, partially built, or abandoned was not determined. R1 depends on
   this answer.
6. **The India screener's upstream filtering was not traced to source.** The
   41-symbol universe's construction (fixed NIFTY list vs. dynamic screen) was
   inferred from `discovery_source` values (`india_screener`, `india_holding`,
   `manual`) and symbol count, not read from the screener code. This matters for
   evaluating the (c) defence more rigorously than §10 does.
7. **The 58 leaked-macro India rows (2026-07-13 → 07-17) remain in the immutable
   ledger.** Their downstream effect on `observation_labels`, the learner, and any
   champion/challenger evaluation was not traced. Flagged; no remediation
   proposed here (the ledger is append-only by design).

---

## 13. Addendum — R1 investigated and REFUTED as specified (2026-08-03)

R1 carried an explicit prerequisite: *"verify whether that feature is
built-but-unwired before proposing new code."* Verified. The answer changes R1
from "highest expected value" to "cannot work as written."

### 13a. The feature is built AND wired — the gate is merely off

`computeComparableRank` is imported and executed by
`app/api/agents/research/cron/route.ts:465` on every non-catch-up research cycle.
It persists rank provenance to `universe_snapshot_scores` (not to
`decision_observations`, which is why `rank_score` / `final_score` / `p_win`
being NULL there was a red herring — those columns belong to a different,
unused idea).

The hybrid entry gate exists at `route.ts:509`. It is inert because
`champion.genome.entry.rank_pct_min` defaults to `0`, and
`isRankRejected` returns `false` whenever `rankPctMin === 0`.

So R1 was never a build. It is a one-value activation.

### 13b. But the rank carries no cross-sectional information

Production, `universe_snapshot_scores` joined to `universe_snapshots`, 30 days:

| Market | `ok` | `degraded` | `excluded_held` | `excluded_abstain` | avg `group_n` | max `group_n` |
|---|---:|---:|---:|---:|---:|---:|
| India | **0** | 92 | 222 | 71 | 4.9 | 7 |
| US | **0** | 40 | 1,178 | 210 | 4.6 | 7 |

**`rank_quality = "ok"` occurs zero times in either market.** Comparable groups
(market × asset-type × sector) average ~5 members against floors of
`RANK_MIN_GROUP_EQUITY_INDIA = 15` and `RANK_MIN_GROUP_EQUITY_US = 20`, and never
exceed 7. The empirical percentile branch has never executed in production.

Every eligible row therefore uses the pre-registered degraded transform,
`clamp01((analyst_score − 45) / 35)`. Verified exactly, not inferred:

```
rows matching clamp01((score-45)/35) to 1e-4 :  India 92/92    US 40/40
corr(rank_pct, analyst_score)                :  India 0.859    US 0.996
```

India's correlation sits below 1.0 only because of clamping — not because of any
ranking. `rank_pct` is a deterministic monotone rescaling of `analyst_score`.

**Consequence: a rank cut is arithmetically identical to an absolute score cut.**
`rank_pct_min = 0.6` is exactly `analyst_score ≥ 66`. R1's stated premise — that
a percentile gate is "invariant to the market-wide level shift that a directional
window produces" — is false under current production data. It would re-spell the
absolute threshold, not replace it.

### 13c. And it would not fix discrimination anyway

| Market | eligible n | at `rank_pct = 1.0` | pass at 0.6 | pass at 0.8 |
|---|---:|---:|---:|---:|
| India | 92 | **43 (46.7%)** | 81 (88.0%) | 61 (66.3%) |
| US | 40 | 2 (5.0%) | 25 (62.5%) | 11 (27.5%) |

Nearly half of India's rank-eligible names are **tied at the ceiling** and cannot
be ordered against each other by construction. A 0.6 cut admits 88% — *worse*
selectivity than the current 73.6% at the absolute 60.

### 13d. What this changes

- **R1 is refused in its current form.** Activating `rank_pct_min` for India
  today would gate on a value that contains no ranking information, and would
  loosen rather than tighten admission. Do not set it.
- **R1 has a real prerequisite of its own**, additional to R2: comparable groups
  must reach their sample floors before the empirical percentile can ever run.
  With a 41-symbol India universe spread across sectors, group_n ≈ 5 is
  structural. Either the universe grows, or the grouping coarsens (drop sector,
  rank within market × asset-type), or the floors are re-derived. That is a
  change to `features/cross-sectional-rank`, not to the India scorer.
- **R2 is confirmed as the root, and now for a second reason.** The rank ceiling
  at 46.7% is downstream of the composite ceiling, which is downstream of
  `technical_score` saturating (43.8% of India technical scores at the ceiling,
  §5). Fixing saturation is a precondition for *any* ordering-based gate, rank
  or otherwise.

Sequencing stands as written in §11 — R2 first — but R1 is now blocked behind a
grouping fix as well, not merely behind R2.

### 13e. Not done, and why

No code changed. `scoreTechnicals` is a live money-path formula; the
Scoring Data-Truth Protocol requires a frozen read-only counterfactual of
expected threshold flips before it is altered, and that counterfactual does not
exist yet. R2 remains a proposal awaiting owner approval, with its required
evidence unchanged: composite ceiling mass under a continuous technical, per
market, reconstructed read-only.
