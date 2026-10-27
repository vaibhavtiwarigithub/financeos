# Do Kairos scores forecast moves or follow them?

Audit date: October 27, 2026. Read-only analysis; no scores, weights, positions, trading settings or production schema changed.

The older technical and composite scores are much more closely associated with rallies that already happened than with the next five-session return. This supports the concern that a high score often describes an existing trend without establishing that the trend will continue. It does not establish causality or prove that every possible formula fails.

## Scope and timing

The export contains 7,691 frozen symbol/session observations dated July 20–October 26, 2026: 5,769 US and 1,922 India. The requested filters do not yield a June cohort. We retained 7,372 samples; 319 lacked an adjusted anchor. Price history contains 46,312 adjusted closes across 505 symbols. Unknown price bases were excluded. The first research observation per symbol/session is selected before checking data availability, so later, more convenient observations cannot replace it.

Only session-validated, original research observations with matching market/local decision session are included. Scores must precede that session close. Dimensions require an available-data flag; unavailable is not a neutral score. Historical formula lineage is incomplete: 5,496 US and 1,786 India observations have no detailed formula-version map. They are explicitly legacy/unknown, not certified as one unchanged formula.

For research in session D, the past h-session return ends at D−1 close. The future return starts at D close, after research, and ends at D+h close. Thus the research-day move cannot count as a prediction. This conservative close-after-research convention differs from the production entry-eligible diagnostic. It cannot assess capturing a move earlier that same day.

Each cell averages daily cross-sectional Spearman rank correlations, with at least five available names and nonconstant inputs. +1 means perfect ranking, 0 no rank association, −1 reversed ranking. These are not hit rates, profits or causal coefficients. Both past and future returns must exist for a paired row. Each day has equal weight. Market calendars are separate. Horizons are 1, 2, 5, 10 and 20 sessions.

## Five-session comparison: older scores

| Market | Dimension | Earlier move correlation | Later move correlation | Paired rows | Qualifying days, before/after |
|---|---|---:|---:|---:|---:|
| us | composite | +0.419 | +0.041 | 5233 | 65/65 |
| us | fundamental | +0.036 | +0.027 | 3699 | 65/65 |
| us | technical | +0.531 | +0.001 | 5194 | 65/65 |
| us | sentiment | +0.064 | +0.014 | 5102 | 65/65 |
| us | macro | undefined | undefined | 5040 | 0/0 |
| us | insider | -0.063 | -0.070 | 2137 | 65/65 |
| india | composite | +0.358 | +0.013 | 1274 | 63/63 |
| india | fundamental | -0.262 | -0.048 | 1271 | 63/63 |
| india | technical | +0.417 | -0.004 | 1262 | 63/63 |

Technical: US +0.531 before versus +0.001 after; India +0.417 before versus −0.004 after. Composite: US +0.419 versus +0.041; India +0.358 versus +0.013. This is a substantial timing mismatch in this historical sample. Negative past association for fundamentals can reflect valuation becoming less attractive after price rises; it does not imply a valuation score should track short-term rallies.

A market-wide macro score that is constant within a day cannot rank that day’s stocks, so its cross-sectional IC is undefined. That does not test whether macro works as a time-series regime control. Sparse insider/sentiment availability also limits what can be inferred.

## Do score changes follow earlier moves?

Changes require a score on the immediately preceding market session, matching formula version and configuration, and availability on both days. This excludes arbitrary gaps and known version transitions; unknown historical lineage remains a limitation.

| Market | Dimension change | Earlier move correlation | Later move correlation | Paired rows | Qualifying days, before/after |
|---|---|---:|---:|---:|---:|
| us | composite | +0.139 | +0.011 | 4481 | 62/62 |
| us | fundamental | -0.114 | -0.001 | 3100 | 28/28 |
| us | technical | +0.195 | -0.009 | 4448 | 61/61 |
| us | sentiment | -0.028 | +0.015 | 4422 | 62/62 |
| us | macro | undefined | undefined | 4394 | 0/0 |
| us | insider | +0.034 | +0.015 | 1806 | 13/13 |
| india | composite | +0.068 | -0.056 | 896 | 60/60 |
| india | fundamental | -0.102 | +0.053 | 896 | 28/28 |
| india | technical | +0.080 | -0.065 | 888 | 60/60 |

Technical changes also relate more strongly to already completed moves: US +0.195 before versus −0.009 after; India +0.080 versus −0.065. This complements the score-level result without establishing an executable reversal strategy.

## Does the score add information beyond momentum?

Two checks were run. First, daily partial Spearman correlations remove the cross-sectional ranks of prior 1-, 5- and 20-session returns from both the score and forward-return ranks. The calculation uses Pearson correlation of rank residuals, requires ten names, and excludes degenerate residuals. This is descriptive conditioning, not an out-of-sample forecast.

| Market | Score | Five-session partial forward correlation | Qualifying days |
|---|---|---:|---:|
| us | composite | +0.042 | 65 |
| us | technical | -0.001 | 65 |
| india | composite | -0.057 | 63 |
| india | technical | -0.113 | 63 |

Second, one fixed illustrative chronological experiment compares ridge regression using known prior 1/5/20-session return ranks with the same inputs plus composite score rank. Lambda is fixed at 10; no parameter search. First two-thirds of eligible dates train and the last third test; any training label ending on or after the first test date is purged. Inputs are same-day cross-sectional ranks. The training target is demeaned within its session. At least 20 training and 10 test sessions are required.

| Market | Horizon | Train/test days | First test day | Momentum-only test IC | With composite test IC |
|---|---:|---:|---|---:|---:|
| us | 2 | 42/23 | 2026-09-21 | -0.161 | -0.146 |
| us | 5 | 38/22 | 2026-09-18 | -0.151 | -0.132 |
| india | 2 | 41/22 | 2026-09-18 | +0.091 | +0.074 |
| india | 5 | 37/21 | 2026-09-17 | +0.003 | -0.003 |

Adding composite improves the negative US results slightly, but they remain negative; it worsens the India results. This bounded trial does not establish useful incremental predictive power. The historical sample has already been inspected by the project, so this is exploratory out-of-sample analysis, not a sealed forward validation or a strategy recommendation.

## Current version is immature

The versioned technical_dimension_v2_macd has only two qualifying US days and one India day for the two-session comparison. Those cells are insufficient to judge predictive value. The older headline cannot be assigned to this current version. Current h5/h10/h20 evidence must mature naturally; do not backfill old outcomes into a new formula identity.

## What this answers, and what remains unproved

The audit checks all six available score series individually and the composite at five horizons, in levels and day-to-day changes, with separate version groups. Full cells are in lead-lag.csv and results.json beside this report. It tests partial momentum adjustment and one fixed chronological composite mapping. It does not exhaust all mathematics, test every RSI/MACD threshold, prove per-symbol skill, estimate strategy profit, or find an optimal formula.

No formal t-statistic or confidence claim is made here: overlapping horizons and common market/sector moves create dependence. Sessions divided by horizon is not an estimated effective sample size. Many exploratory cells introduce selection risk. The researched universe changes over time and excludes symbols never researched; adjusted-price availability can select survivors. Legacy formula/configuration coverage and source publication timestamps are incomplete. Frozen observations do not by themselves prove every upstream feature was point-in-time correct. These limits prevent treating the table as production-readiness evidence.

VOO has adjusted cache coverage; the India index has no adjusted rows in this export. Results use raw-return cross-sectional ranks. Subtracting one common benchmark return from all names on an aligned session preserves that session’s ranks, but does not supply benchmark-relative portfolio P&L or solve differing-horizon/missing-mark problems. No alternative unverified India benchmark is substituted.

## Next safe implementation

Reuse Learning / Prediction Lab and the existing dimension-diagnostics, technical-feature-diagnostics and score-price-divergence modules. Add a clearly separated reactive-versus-predictive view only through the approved architecture workflow: fixed past/future windows, level/change, formula identity, availability, cohort counts and momentum-controlled comparison. Do not create another disconnected shadow table or duplicate evaluator.

Evaluate a small predeclared challenger against the unchanged incumbent on frozen matched cohorts and untouched forward sessions. For technical inputs, separate trend state from entry timing rather than rewarding a completed rally as automatic future upside. Keep current formulas, thresholds and risk controls until adequate paired evidence exists. For macro test regime interactions/time-series behavior; for fundamentals retain appropriate longer horizons. Portfolio construction, execution, cash drag and exit quality require separate cost-aware paired portfolio replay; even a predictive rank signal does not establish profit.

Chronological validation reference: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html . Lagged predictive tests do not establish causality: https://www.statsmodels.org/stable/generated/statsmodels.tsa.stattools.grangercausalitytests.html .

## Verification and retained artifacts

The local calculation completed with synthetic checks for reactive versus unrelated future series, reverse ranks, tied ranks and undefined constant scores. Results were regenerated after correcting partial correlation to Pearson correlation of rank residuals. Raw exports and computation scripts remain outside the public repository. This report and a sanitized audit record contain no credentials, account identifiers or holdings. No live model inference or trading operation was used.

Additional scope limits: this deterministic-cohort audit does not evaluate LLM council forecasts or individual technical subfeatures. Asset classes/sectors are pooled within each market; sector and instrument-type conditioning remain separate hypotheses. The final output has 124 cells; cells without enough valid paired data are absent, not zero. Unique frozen slots, exclusion totals and paired qualifying-day counts were checked. Input SHA-256: 1beedf15bf859757637f1245bb8f47199ea5d4e012a85406b04cab622c1f3672. TypeScript check passed. No new continuous evaluator or app screen was built by this read-only audit.
