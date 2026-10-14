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

## 4. Follow-up audit (same day): why the composite is inverted
All figures US, benchmark-neutral 10-session return, 2026-07-06..10-13. "Spread" = mean excess return of the top fifth minus the bottom fifth of names by that score, per session.

**Technical is a momentum recipe, and every component is inverted** (pooled mean excess by bucket):
| Component | Rewarded bucket | Penalized bucket |
|---|---|---|
| price vs EMA50 | above: -1.119% (n=3,364) | below: +0.630% (n=2,514) |
| price vs EMA20 | above: -0.846% | below: +0.164% |
| 20-day trend | up: -1.024% | down: +0.673% |
| RSI14 | 60-72 (paid +25): -1.292%; >72: -2.642% | 35-50: +0.409% |
Per-indicator rank IC (h10, 68 sessions): RSI14 -0.032 (t -0.37), volume vs avg +0.018, relative strength vs SPY -0.010, last-day return +0.024: none significant. Consistent inversion across independent indicators points to a short-term reversal regime, not a single sign bug.

**Stability across halves** (37 then 36 sessions):
| Score | First half spread | Second half spread |
|---|---|---|
| Composite | -1.67% | +0.30% |
| Fundamental | +1.88% | +2.01% |
| Technical | -2.64% | +0.42% |
| Sentiment | +3.11% | -0.07% |
| Insider | -0.14% | -1.81% |
Only fundamental is positive in both halves. Technical and sentiment flip with the regime. Insider is negative in both.

**Insider quality issue (design, not noise).** Available for only 39.9% of US observations (neutral 50 is the default for the 61% without data; 1.2% have data AND score exactly 50). When available the stored evidence reads e.g. "SEC Form 4: 0 buys ($0) vs 105 sells ($109.3M) in 90d. Buy ratio 0%" -> score 10. Routine insider selling (compensation, 10b5-1 plans) is scored as strongly bearish, which penalizes large caps that always sell.

**Frozen variants** (weights fixed in advance, no fitting; the CHOICE of variants was made after seeing the full-sample table, so this is still in-sample):
| Ranking by | First half spread | Second half spread | Top-fifth excess (1st / 2nd half) |
|---|---|---|---|
| Current composite | -1.50% | +0.24% | -0.42% / -0.76% |
| Composite without insider | -1.88% | +1.00% | n/a |
| Fundamental + sentiment (0.30/0.20, renormalized) | +2.26% | +1.25% | n/a |
| Fundamental only | +1.93% | +2.33% | +1.21% / +0.32% |

## 5. What this means and what to do (nothing changed live)
- The current composite's top fifth had NEGATIVE excess return in both halves; a fundamental-only ranking was positive in both. That is the strongest finding, and it is still 3 months, one regime, overlapping windows, and a variant chosen with hindsight.
- The defensible next step is a pre-registered FORWARD shadow of three fixed variants (fundamental only; fundamental + sentiment; current minus insider) scored on every new observation and judged only on data that did not exist when they were declared. No live weight changes until a forward window shows a positive spread and top-fifth excess with adequate effective sample.
- Separately: the insider scorer treating routine selling as bearish deserves its own fix proposal (e.g. score only open-market buys, or net discretionary flow), also shadow-first.
- Not yet analysed: the 40% average cash (deployment constraints vs name caps vs lack of qualifying entries) and India (this audit is US only).

## 6. Cash drag, and what the XLK comparison really measures (follow-up, same day)
Average cash share by week (US, EOD rows only): week of 07-06 79%, 07-13 58%, 07-20 44%, then 26-39% through September, 55% in the week of 09-28 (owner consolidation from 15 to 8 names closed positions; max 92%), 17% in the week of 10-05 and 10% in the week of 10-12. The book STARTED 2026-07-06 at 100% cash and took about three weeks to build, so the 39.8% full-window average is front-loaded. Three whole weeks (07-27, 08-03, 08-10) have no EOD rows at all, so any average over the available rows is biased; only 51 of 71 trading days exist.

Fair comparison once the book was built (2026-08-20 to 2026-10-13, 36 aligned date pairs, 67% invested on average):
| | Return |
|---|---|
| US paper book | +1.09% |
| SPY | +1.41% |
| SPY scaled to the invested share | +0.95% |
| Invested sleeve alone | -0.33% |
| XLK | +7.01% |

Reading: after the build-out the book is roughly in line with SPY once cash is accounted for (+1.09% vs +0.95% scaled), and the invested sleeve lagged SPY by about 1.7 points over 36 sessions (not significant). XLK beat SPY by about 5.6 points in the same window, so the 'XLK has beaten us' gap is mostly the tech sector's own outperformance, not evidence of a broken strategy. The honest benchmark for a diversified book is SPY (or an equal-weight index), not a single-sector ETF.

