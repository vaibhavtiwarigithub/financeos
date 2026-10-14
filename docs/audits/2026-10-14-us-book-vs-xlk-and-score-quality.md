# US paper book vs XLK/SPY, and whether the scores rank stocks (read-only audit, 2026-10-14)

Triggered by the owner: "XLK has beaten our portfolio consistently for the past 4 months; there has to be something wrong in our scoring."
Nothing was changed. All numbers are production SQL, US market only. Window: 2026-07-06 (first end-of-day book row) to 2026-10-13.

## 1. The performance gap (50 aligned date pairs; the book has only 51 EOD rows for ~71 sessions)
| | Return |
|---|---|
| US paper book | +1.22% |
| XLK | +7.05% |
| SPY | +3.82% |
| Average share invested | 59.8% (cash 40%) |
| XLK scaled to the invested share | +4.21% |
| Invested sleeve alone (dNAV / prior positions value, chained) | +0.38% |
| Sleeve beta to SPY / to XLK | 0.95 / 0.40 |

Cash drag explains a large part of the gap, but not all: the invested sleeve returned +0.38% while carrying SPY-like risk (beta 0.95).
Data caveats: (a) only 51 EOD rows exist for ~71 sessions, so every comparison pairs the same dates; an earlier chained query that mixed multi-day book returns with one-day benchmark returns reported XLK at +0.20% and was wrong. (b) History starts 2026-07-06 (about 3.3 months, not 4).

## 2. Do the scores rank stocks? (rank IC and top-fifth minus bottom-fifth, benchmark-neutral 10-session return, 68 sessions, ~87 names per session)
| Score | Mean rank IC | t (overlap-adjusted) | Top fifth | Bottom fifth | Spread |
|---|---|---|---|---|---|
| Composite (analyst_score) | +0.028 | 0.39 | -0.605% | +0.159% | **-0.764%** |
| Fundamental | +0.091 | 1.55 | +0.753% | -1.187% | +1.940% |
| Technical | -0.033 | -0.42 | -1.208% | +0.025% | -1.233% |
| Sentiment | +0.034 | 0.62 | +0.621% | -1.022% | +1.643% |
| Insider | -0.094 | -1.54 | -0.494% | +0.418% | -0.912% |

Entry decision: names flagged `entry_eligible` returned -0.446% excess at 10 sessions (3,288 obs, 43.5% beat the benchmark) versus -0.190% for non-eligible (2,698 obs).
Composite weights (balanced profile): fundamental 0.30, technical 0.25, sentiment 0.20, macro 0.15 (a constant per day, cannot rank), insider 0.10.

## 3. What this does and does not show
- The composite does not rank stocks in this sample, and its top fifth is inverted. Technical and insider (35% of the weight) are inverted; fundamental and sentiment rank correctly. The inversion looks like technical/insider diluting and overwhelming fundamental/sentiment.
- NOT established: that this is a bug, or that reweighting would work. No single dimension is significant (|t| <= 1.6), returns overlap (10-session windows), the sample is one regime (a tech-led rally), and picking the dimensions that did best in-sample is data snooping. A technical score that rewards momentum will look inverted in a mean-reverting stretch without being buggy.
- Required before any live scoring change (Scoring Data-Truth Review Protocol): decompose the technical and insider dimensions by indicator and sign; check availability masks and neutral defaults (insider is available for ~61-65% of names); a frozen walk-forward counterfactual (fit on the first half, judge on the second); US and India separately.
