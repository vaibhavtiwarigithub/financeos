# Predeclared hypothesis — dimension IC vs the composite

**Registered:** 2026-08-24
**Status:** FROZEN. Predeclared BEFORE the out-of-sample window opens.
**Out-of-sample window opens:** decision dates **>= 2026-08-25**
**Cleanliness verified at registration:** the latest `decision_observations.ts`
was 2026-08-24 and **zero rows existed on or after 2026-08-25**, so the window
contains nothing that was looked at while forming these claims. (The DB clock
had already rolled to 2026-08-25 02:07 UTC when this was written — the cutoff
was checked against actual row dates rather than assumed from "today".)

**Registered in-system:** `learning_log` row
`82d9f4e6-17a9-455c-a43b-1b41660a7cd0`, `signal_adjusted = none__predeclared_hypothesis`
(`old_weight = new_weight = 0` denotes no change made).
**Nothing changes on the basis of this document.** Passing earns the right to
*propose* a weight change through the normal challenger/promotion path. It is not
permission to re-weight anything.

## Why this is being registered rather than acted on

The motivating numbers below were measured on data that already existed. Fitting
weights to them would be selecting on the same sample that produced them — the
exact failure the evidence discipline exists to prevent, and the reason the
+20% exit target was not changed on a t=1.35 counterfactual.

**Multiple testing is explicit:** 5 dimensions x 2 markets x 3 horizons = **30
cells** were examined before these claims were written. At |t| ~ 2 roughly 1.5
false positives are expected by chance. That is why the bar below is t >= 2.0 on
NEW dates, and why the marginal India cells are predeclared as expected failures
rather than quietly dropped.

## In-sample evidence (2026-08-24, date-clustered, `benchmark_neutral_return`)

| Market | Horizon | Dates | IC fundamental | t | IC technical | t | IC composite |
|---|---|---|---|---|---|---|---|
| US | h5 | 27 | +0.041 | 0.97 | −0.030 | −0.72 | +0.009 |
| US | **h10** | 20 | **+0.114** | **4.60** | −0.003 | −0.06 | +0.052 |
| US | **h20** | 16 | **+0.125** | **2.82** | **−0.187** | **−6.58** | **−0.100** |
| India | h5 | 25 | −0.038 | −0.61 | +0.050 | 0.71 | −0.032 |
| India | h10 | 20 | −0.147 | −2.09 | +0.187 | 2.76 | +0.125 |
| India | h20 | 9 | +0.106 | 0.74 | −0.012 | −0.08 | +0.051 |

Live weights: fundamental 30 / technical 25 / sentiment 20 / macro 15 / insider 10.
So in the US roughly **70% of the weight sits on dimensions with ~zero or negative
IC**, diluting the 30% that carries signal.

## Hypotheses

### H1 — US fundamental carries real predictive signal
**Claim:** `fundamental_score` has positive date-clustered IC against
`benchmark_neutral_return` at h10 in the US.
**Passes if:** on **>= 20 decision dates entirely after 2026-08-24**, mean IC > 0
with **t >= 2.0**.
**Fails if:** t < 2.0, or mean IC <= 0.

### H2 — US technical is neutral-to-inverted at h20
**Claim:** `technical_score` has non-positive IC at h20 in the US.
**Passes if:** on **>= 16 new dates at h20**, mean IC < 0 with **t <= -2.0**.
**Fails if:** mean IC >= 0, or |t| < 2.0.

### H3 — the consequential one: the US composite is worse than fundamental alone
**Claim:** at h10, `IC(fundamental_score) > IC(analyst_score)` in the US.
**Test:** paired by decision date (same dates, same universe), so the market
window cancels.
**Passes if:** on **>= 20 new dates**, mean paired difference > 0 with **t >= 2.0**.
**Fails if:** t < 2.0.

### H4 — India h10 is predeclared as EXPECTED TO FAIL
**Claim:** India's h10 result (composite +0.125, technical +0.187, fundamental
−0.147) is a single-horizon artifact and will NOT replicate.
It vanishes at h5 (+0.050 technical, t=0.71) and flips at h20 on 9 dates.
**Registered as an expected failure so that a later replication cannot be
presented as confirmation of something that was never predicted.** If it DOES
replicate at t >= 2.0 on >= 20 new dates, that is a genuine surprise and worth
more than the US result.

## Preconditions before any hypothesis may be read

- Only observations whose decision date is **>= 2026-08-25**.
- Only labels with a non-null `benchmark_neutral_return` at the stated horizon.
- Tainted trades and provisional/unconfirmed benchmark rows are excluded from
  any downstream performance claim (they do not affect IC, which reads labels
  directly, but the exclusion is stated so the two evidence paths cannot drift).
- Date-clustered throughout: one decision date = one draw. Same-day observations
  share a market shock and are NOT independent.

## The test (re-runnable verbatim)

```sql
-- Set the cutoff ONCE. Do not widen it to reach significance.
WITH j AS (
  SELECT o.market, l.horizon_days h, o.ts::date d,
         l.benchmark_neutral_return fwd,
         o.fundamental_score f, o.technical_score t, o.analyst_score comp
  FROM decision_observations o
  JOIN observation_labels l ON l.observation_id = o.id
  WHERE l.benchmark_neutral_return IS NOT NULL
    AND o.ts::date >= DATE '2026-08-25'          -- out-of-sample only
),
pd AS (
  SELECT market, h, d,
         corr(f, fwd) icf, corr(t, fwd) ict, corr(comp, fwd) icc,
         corr(f, fwd) - corr(comp, fwd) AS paired_diff,
         count(*) n
  FROM j GROUP BY market, h, d HAVING count(*) >= 5
)
SELECT market, h, count(*) AS dates,
  round(avg(icf)::numeric,4) ic_fundamental,
  round((avg(icf)/NULLIF(stddev_samp(icf)/sqrt(count(*)),0))::numeric,2) t_fund,
  round(avg(ict)::numeric,4) ic_technical,
  round((avg(ict)/NULLIF(stddev_samp(ict)/sqrt(count(*)),0))::numeric,2) t_tech,
  round(avg(icc)::numeric,4) ic_composite,
  round(avg(paired_diff)::numeric,4) fund_minus_composite,
  round((avg(paired_diff)/NULLIF(stddev_samp(paired_diff)/sqrt(count(*)),0))::numeric,2) t_paired
FROM pd GROUP BY market, h ORDER BY market, h;
```

## If a hypothesis passes

It becomes a *candidate*, not a change. The path is unchanged: propose a
challenger in `strategy_versions`, run it in shadow, then paper, then a governed
promotion with owner approval and separate US/India gates. A passing IC test does
not by itself authorise re-weighting a live score.

## If a hypothesis fails

Record the failure here and stop. Do not widen the window, drop a horizon, or
change the threshold to rescue it — those are the three standard ways a
predeclared test becomes a fitted one.

---

## Addendum — 2026-08-24, same day, before any out-of-sample data

The baseline table above was computed with **Pearson** correlation. Two
corrections, recorded here rather than by rewriting the predeclaration.

### 1. Rank IC (Spearman) is the correct headline

Pearson IC is outlier-sensitive; rank IC is the standard skill measure. The
gap between them is large enough to change the characterisation:

| market | dim | Pearson IC (h10) | rank IC (h10) | t (rank) |
|---|---|---|---|---|
| us | fundamental | +0.114 (t=4.60) | +0.069 | 2.19 |
| us | technical | -0.003 | +0.012 | 0.19 |
| us | composite | +0.052 | +0.055 | 1.09 |
| india | fundamental | -0.147 | -0.022 | -0.39 |
| india | technical | +0.187 | +0.166 | 2.40 |
| india | composite | +0.125 | +0.098 | 1.86 |

The directional finding (US fundamental > 0, India technical > 0, both
composites below their own best dimension) survives. The magnitude of the US
fundamental edge does not: it halves.

### 2. The US pool was diluted by the ETF fundamental placeholder

381 of 1407 US h10 observations (27%) carry `fundamental_score = 55.0` with
stddev 0.0 — the ETF/metal placeholder, not a measurement. India's cohort is
100% single stocks and contains none. The US-vs-India fundamental comparison
in the predeclaration was therefore not like-for-like.

US h10, single stocks only (19 dates, ETFs and metals excluded):

| dim | rank IC | t |
|---|---|---|
| fundamental | +0.090 | 2.86 |
| technical | -0.010 | — |
| composite | +0.071 | 1.27 |

### Consequences for H1-H4

- All four hypotheses are to be evaluated on **rank IC**, on the
  **single-stock cohort**, per market. Blended-cohort numbers are not a valid
  test of a dimension-weighting hypothesis.
- The h10 single-stock rank IC values above are the frozen baseline for the
  US arm. India's baseline is unchanged (its cohort was already clean).
- Thresholds and kill conditions in the predeclaration are unchanged.

### Still not measured

Quantile (top-vs-bottom quintile) return spread, IC stddev / hit rate across
dates, IC decay across h5/h10/h20, and Newey-West correction for overlapping
h20 windows. IC mean alone can be positive while the top bucket earns nothing.
None of these are worth running at 20 dates; revisit at >=60.

### 3. Duplicate observations per symbol-date

The research cron writes an observation on each run (13:00 / 17:00 / 18:00
UTC). Verified on GLD 2026-08-24: three rows, identical scores. A symbol
scored three times receives three times the weight in a cross-sectional rank
correlation, which violates the one-decision-one-draw assumption WITHIN a
date (the date-clustering in the predeclaration only handles it BETWEEN
dates).

Baseline must dedup to one observation per (market, symbol, date). Using the
earliest row of the day.

## Final frozen baseline — rank IC, deduped, single-stock cohort, h10

| market | dates | avg names/date | fundamental | t | technical | t | composite | t |
|---|---|---|---|---|---|---|---|---|
| us | 19 | 35.4 | +0.076 | 2.40 | -0.014 | -0.19 | +0.051 | 0.93 |
| india | 20 | 15.1 | -0.046 | -0.82 | +0.173 | 2.51 | +0.106 | 2.04 |

This supersedes both the original Pearson table and addendum item 1 as the
baseline H1-H4 are measured against. Thresholds and kill conditions unchanged.

The load-bearing finding is unchanged across all three corrections: in both
markets the composite scores BELOW that market's own best single dimension
(us 0.051 < 0.076; india 0.106 < 0.173). The blend is destroying signal.

India averages 15.1 names per date. Cross-sectional rank IC on 15 names is
noisy; treat the India arm as weaker evidence than its t-stat suggests.

### ETF fundamental placeholder — verified live, working as intended

Checked 2026-08-24 production rows. `scoreFundamentals` still returns 55 for
ETFs, by design, but `features.weighting` confirms it is excluded from the
composite:

```
included_dims:    ["technical","sentiment","macro"]
applied_weights:  fundamental 0, technical 0.4167, sentiment 0.3333, macro 0.25
renormalized:     true
```

GLD 2026-08-24: fundamental 55, technical 100, analyst_score 65 (ETF cap).

The second 55 in `scoreFundamentals` — the missing-provider-data default on a
REAL stock, which DOES carry full fundamental weight — fired 0 times between
2026-08-15 and 2026-08-24 in both markets. That path is the one worth
monitoring; it is currently clean.

The 55s remain in HISTORICAL rows, which is why the cohort filter above is
required for any measurement spanning that period.
