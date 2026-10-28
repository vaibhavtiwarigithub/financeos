# SOXL / inverse ETF timing and dimension audit — 2026-10-28

## Scope

Read-only check of the latest matured SOXL/SOXS evidence and the recorded
natural SOXL paper-door outcome. No score, position, order, or account record was
changed. The live/paper execution contract remains blocked for leveraged new
entries; this audit does not recommend bypassing it.

## Evidence

The production `decision_observations` row from 2026-10-23 13:00 UTC used price
bars through 2026-10-22 and a US MacroSentinel context dated 2026-10-19:

| Symbol | Deterministic score | Macro score | Technical | Sentiment | Entry allowed | Mature h2 absolute return | Mature h2 benchmark-neutral return |
|---|---:|---:|---:|---:|---|---:|---:|
| SOXL | 46 | 65 | 20 | 63 | no | +23.00% | +21.73% |
| SOXS | 80 | 65 | 100 | 65 | no | -20.59% | -21.86% |

The same bullish/risk-on macro score contributed positively to both long SOXL
and inverse SOXS. The current deterministic score contract does not invert the
underlying-referenced macro value for inverse funds. That is a semantic gap to
measure, but changing the incumbent would also change scores and eligibility;
it is not authorized by this shadow-only comparison.

The SOXL h2 return shows the research packet preceded a large move in this
specific case. It is one labeled observation and does not establish a
repeatable forecast. The later natural SOXL door run (15:05 ET on Oct 27)
rejected its $49.01 minimum because canonical US paper cash was $0.000509. Six
open ordinary holdings marked around $9,700. This is consistent with a capital
availability blocker, separate from the leveraged entry-policy block; it was
not a stale quote or a failure to research SOXL. The prior cash reserve does
not liquidate already-open positions.

## Macro direction comparison design

`/api/learning/macro-performance?market=us` now reuses matured labels and
compares the persisted macro score with a fixed, versioned exposure-oriented
challenger for SPY, QQQ, SOXX, SOXL, TQQQ, SOXS and SQQQ. Existing macro scores
are already oriented as `100 - danger_score` (higher is more favorable for
long underlying exposure). The challenger preserves that value for the long
set and uses `100 - macro_score` for the inverse set. It evaluates each
instrument against its own absolute return; it does not assume inverse returns
are exact multi-session negatives. The sampling date uses the frozen technical
bar's `as_of` value rather than the research write timestamp.

The available exploratory history is sparse and inconsistent across the
symbols/horizons (especially SOXS/SQQQ h5/h10/h20). Some sampled series have
only 1–6 dates; only SOXL h2 has more than 12 horizon-spaced observations in
the bounded lookback. No t-statistic, calibrated forecast, winner, or promotion
is justified. Horizon-spaced observations are not an effective sample size.
Do not adjust weights or invert production scoring from these results.

## Next validation gate

Continue collecting the existing naturally scheduled observations. Before
claiming predictive value, require a correctly paired session-level cohort,
fixed instrument-specific comparison, enough non-overlapping matured windows,
uncertainty estimates robust to overlapping horizons, and a predeclared
out-of-sample comparison against the incumbent and a simple baseline. Until
then the Learning row is descriptive/insufficient and the live leveraged-entry
block remains independent.
