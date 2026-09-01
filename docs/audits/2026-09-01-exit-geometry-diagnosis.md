# Exit geometry — what the counterfactual actually says

Frozen diagnosis, 2026-09-01. **Evidence only. No stop, target, time stop, order or exit
was changed.** `/api/agents/exit-geometry-shadow` writes nothing; it derives everything from
`observation_labels` MFE/MAE.

Raw responses: `net._http_response` ids **9264** (us h10), **9265** (india h10),
**9266** (us h5), **9267** (india h5), fetched 2026-09-01 11:18 UTC.

## Cohort (frozen)

Entry-eligible long observations only — the route skips `entry_eligible !== true`.

| cohort | obs | dates | symbols | ATR coverage | decision window |
|---|---:|---:|---:|---:|---|
| US h10 | 900 | 26 | 80 | 94.1% | 2026-07-06 → 2026-08-13 |
| India h10 | 424 | 26 | 45 | 97.6% | 2026-07-07 → 2026-08-13 |
| US h5 | 1,333 | 28 | 113 | 95.4% | 2026-07-06 → 2026-08-17 |
| India h5 | 541 | 30 | 49 | 98.2% | 2026-07-07 → 2026-08-17 |

All four clear the 20-distinct-date floor. The h10 window ends 2026-08-13 because later
decisions have not matured a 10-day label yet.

## 1. The live target is unreachable, and that is measured, not inferred

| cohort | target hits | share | timeouts | share |
|---|---:|---:|---:|---:|
| US h10 | 28 | 3.1% | 683 | **76%** |
| India h10 | **0** | 0.0% | 395 | **93%** |
| US h5 | 24 | 1.8% | 1,139 | 85% |
| India h5 | **0** | 0.0% | 524 | 97% |

The configured +19.2% target fires **zero times across 965 India observations**. The time
stop is not competing with the target — it IS the exit policy, because nothing else
triggers. This reproduces the production exit ledger, where 132 of 179 closed lots (73.7%)
exited on the clock. The counterfactual and the live book agree, which is the main reason
to trust the rest of this.

## 2. Tightening the target makes expectancy WORSE — in every cohort

US h10, by target width:

| config | mean return | win rate | target hits |
|---|---:|---:|---:|
| ATR 2.8 / **7.3** | **0.911%** | 54.8% | 10 |
| baseline 7.5% / 19.2% | 0.616% | 52.0% | 28 |
| 7.5% / 10% | 0.586% | 53.1% | 117 |
| 7.5% / 6% | 0.460% | 55.5% | 266 |
| 7.5% / **4%** | 0.398% | **61.4%** | 376 |

The same monotone shape appears in all four cohorts: **the widest target ranks first, the
tightest ranks last.** Tightening to 4% raises the win rate to 61.4% and cuts mean return by
a third — more frequent small wins, worse expectancy.

**This refutes the intuitive fix.** "The target is never hit, so make it reachable" would
have reduced returns in every cohort measured.

## 3. The recoverable loss is in the STOP, not the target

`stop 2.8ATR / target 7.3ATR` ranks first in **3 of 4** cohorts. Against baseline on US h10:

| | baseline (7.5% stop) | ATR 2.8 stop |
|---|---:|---:|
| stop-outs | 185 | **131** (-29%) |
| timeouts | 683 | 706 |
| target hits | 28 | 10 |
| mean return | 0.616% | **0.911%** |

It does not exit on target either. The entire gain comes from **a volatility-scaled stop
firing 29% less often** — positions that a fixed 7.5% band killed on noise survive to the
time stop. The time stop remains dominant in both arms.

## 4. Cross-cohort margins — thin everywhere except US h10

ATR 2.8/7.3 minus baseline, mean return:

| cohort | margin |
|---|---:|
| US h10 | **+0.295pp** |
| India h10 | +0.073pp |
| India h5 | +0.051pp |
| US h5 | **-0.041pp (LOSES)** |

One cohort carries the result. Three are inside anything that could be called noise, and
the arm loses outright on the largest cohort by row count (US h5, n=1,333).

## 5. Why this is a ranking, not a result

- **14 configs x 4 cohorts is a search.** The best-looking arm on a 14-arm grid is inflated
  by selection. The route's own note says the grid is "subject to overlap and
  multiple-testing caveats".
- **No confidence intervals, no t-statistics** are produced. Differences of 0.05-0.30pp are
  reported without dispersion.
- **Overlapping forward windows.** Consecutive decision dates share most of their 10-day
  window, so 26 dates is nowhere near 26 independent observations.
- **Ambiguity rises as geometry tightens** — US h10 reaches 18.2% ambiguous at 3.5%/4%,
  against a 20% refusal ceiling. The tight arms are also the least trustworthy.

## What this licenses

- Retiring the belief that a reachable price target would improve exits. It would not.
- **One** predeclared forward hypothesis about the STOP, tested with multiplicity control.

## What this does NOT license

- Changing any live stop, target, or time stop.
- Treating +0.295pp as an expected improvement. It is the best of 14 on one cohort.
- Concluding the time stop is harmful. Every arm here keeps it, and the best arm times out
  MORE often than baseline (706 vs 683).
- Any cross-market claim. India h10 recorded zero target hits; its geometry question is not
  the same question as the US one.

## Method note

The intuition that started this — "time stops are crap, exit on indicators" — was half
right. Time exits do dominate (76-93%). But the proposed remedy was measured and is wrong,
and the real defect sits one step away in the stop. Worth recording: the diagnosis that
survived is not the one anyone predicted.
