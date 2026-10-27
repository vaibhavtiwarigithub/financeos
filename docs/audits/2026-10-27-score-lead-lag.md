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

## Complete computed cells: all horizons and versions

These exploratory cells include immature current-version samples so their short history is visible. Undefined and missing results must not be interpreted as zero predictive value. Changes are day-to-day score differences, not returns. No cell is a validated signal or a significance claim.

| Market | Dimension | Formula | Input | Horizon | Past IC | Future IC | Momentum-controlled future IC | Qualifying days | Paired rows |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| us | composite | composite_formula_v1_20261021 | level | 1 | +0.234 | +0.103 | -0.031 | 3 | 165 |
| us | composite | composite_formula_v1_20261021 | level | 2 | +0.125 | +0.017 | -0.093 | 2 | 92 |
| us | composite | composite_formula_v1_20261021 | change | 1 | +0.357 | -0.059 | +0.083 | 1 | 67 |
| us | composite | composite_formula_v1_20261021 | change | 2 | undefined | undefined | undefined | 0 | 4 |
| us | composite | composite_leveraged_uncapped_v2_20261022 | level | 1 | undefined | undefined | undefined | 0 | 4 |
| us | composite | legacy/unknown | level | 1 | +0.198 | +0.020 | +0.027 | 67 | 5405 |
| us | composite | legacy/unknown | level | 2 | +0.283 | +0.023 | +0.031 | 67 | 5405 |
| us | composite | legacy/unknown | level | 5 | +0.419 | +0.041 | +0.042 | 65 | 5233 |
| us | composite | legacy/unknown | level | 10 | +0.536 | +0.017 | +0.063 | 60 | 4784 |
| us | composite | legacy/unknown | level | 20 | +0.622 | +0.021 | +0.045 | 50 | 3899 |
| us | composite | legacy/unknown | change | 1 | +0.392 | +0.029 | +0.024 | 64 | 4613 |
| us | composite | legacy/unknown | change | 2 | +0.253 | +0.007 | +0.005 | 64 | 4613 |
| us | composite | legacy/unknown | change | 5 | +0.139 | +0.011 | +0.010 | 62 | 4481 |
| us | composite | legacy/unknown | change | 10 | +0.082 | +0.007 | +0.018 | 57 | 4123 |
| us | composite | legacy/unknown | change | 20 | +0.035 | -0.004 | +0.003 | 47 | 3338 |
| us | fundamental | fundamental_dimension_v1_20261021 | level | 1 | -0.113 | +0.025 | -0.081 | 3 | 118 |
| us | fundamental | fundamental_dimension_v1_20261021 | level | 2 | -0.190 | -0.030 | -0.167 | 2 | 66 |
| us | fundamental | fundamental_dimension_v1_20261021 | change | 1 | +0.122 | -0.135 | -0.122 | 1 | 45 |
| us | fundamental | fundamental_dimension_v1_20261021 | change | 2 | undefined | undefined | undefined | 0 | 3 |
| us | fundamental | legacy/unknown | level | 1 | +0.029 | +0.034 | +0.034 | 67 | 3816 |
| us | fundamental | legacy/unknown | level | 2 | +0.027 | +0.018 | +0.013 | 67 | 3816 |
| us | fundamental | legacy/unknown | level | 5 | +0.036 | +0.027 | +0.029 | 65 | 3699 |
| us | fundamental | legacy/unknown | level | 10 | +0.079 | +0.058 | +0.050 | 60 | 3393 |
| us | fundamental | legacy/unknown | level | 20 | +0.097 | +0.076 | +0.072 | 50 | 2778 |
| us | fundamental | legacy/unknown | change | 1 | -0.076 | -0.012 | -0.056 | 29 | 3184 |
| us | fundamental | legacy/unknown | change | 2 | -0.103 | -0.012 | -0.036 | 29 | 3184 |
| us | fundamental | legacy/unknown | change | 5 | -0.114 | -0.001 | -0.022 | 28 | 3100 |
| us | fundamental | legacy/unknown | change | 10 | -0.102 | +0.034 | -0.000 | 26 | 2865 |
| us | fundamental | legacy/unknown | change | 20 | -0.075 | +0.026 | -0.010 | 20 | 2327 |
| us | technical | legacy/unknown | level | 1 | +0.241 | -0.008 | -0.001 | 67 | 5366 |
| us | technical | legacy/unknown | level | 2 | +0.353 | -0.015 | -0.008 | 67 | 5366 |
| us | technical | legacy/unknown | level | 5 | +0.531 | +0.001 | -0.001 | 65 | 5194 |
| us | technical | legacy/unknown | level | 10 | +0.688 | -0.050 | +0.004 | 60 | 4745 |
| us | technical | legacy/unknown | level | 20 | +0.812 | -0.051 | -0.048 | 50 | 3866 |
| us | technical | legacy/unknown | change | 1 | +0.518 | +0.019 | +0.013 | 63 | 4580 |
| us | technical | legacy/unknown | change | 2 | +0.357 | +0.002 | +0.003 | 63 | 4580 |
| us | technical | legacy/unknown | change | 5 | +0.195 | -0.009 | -0.001 | 61 | 4448 |
| us | technical | legacy/unknown | change | 10 | +0.136 | -0.005 | +0.011 | 56 | 4090 |
| us | technical | legacy/unknown | change | 20 | +0.084 | -0.025 | -0.010 | 46 | 3310 |
| us | technical | technical_dimension_v2_macd | level | 1 | +0.365 | +0.006 | +0.088 | 3 | 169 |
| us | technical | technical_dimension_v2_macd | level | 2 | +0.327 | +0.073 | +0.156 | 2 | 92 |
| us | technical | technical_dimension_v2_macd | change | 1 | +0.611 | -0.112 | +0.108 | 1 | 67 |
| us | technical | technical_dimension_v2_macd | change | 2 | undefined | undefined | undefined | 0 | 4 |
| us | sentiment | legacy/unknown | level | 1 | +0.078 | +0.029 | +0.023 | 67 | 5253 |
| us | sentiment | legacy/unknown | level | 2 | +0.079 | +0.032 | +0.026 | 67 | 5253 |
| us | sentiment | legacy/unknown | level | 5 | +0.064 | +0.014 | +0.009 | 65 | 5102 |
| us | sentiment | legacy/unknown | level | 10 | +0.072 | +0.010 | +0.012 | 60 | 4687 |
| us | sentiment | legacy/unknown | level | 20 | +0.063 | +0.013 | +0.032 | 50 | 3818 |
| us | sentiment | legacy/unknown | change | 1 | +0.013 | +0.023 | +0.026 | 64 | 4542 |
| us | sentiment | legacy/unknown | change | 2 | -0.019 | +0.008 | +0.003 | 64 | 4542 |
| us | sentiment | legacy/unknown | change | 5 | -0.028 | +0.015 | +0.013 | 62 | 4422 |
| us | sentiment | legacy/unknown | change | 10 | -0.027 | +0.006 | +0.006 | 57 | 4084 |
| us | sentiment | legacy/unknown | change | 20 | -0.040 | +0.017 | +0.010 | 47 | 3300 |
| us | sentiment | sentiment_dimension_v1_20261021 | level | 1 | +0.185 | +0.321 | -0.003 | 3 | 143 |
| us | sentiment | sentiment_dimension_v1_20261021 | level | 2 | +0.329 | +0.345 | -0.080 | 2 | 77 |
| us | sentiment | sentiment_dimension_v1_20261021 | change | 1 | -0.264 | +0.204 | +0.138 | 1 | 59 |
| us | sentiment | sentiment_dimension_v1_20261021 | change | 2 | undefined | undefined | undefined | 0 | 4 |
| us | macro | legacy/unknown | level | 1 | undefined | undefined | undefined | 0 | 5207 |
| us | macro | legacy/unknown | level | 2 | undefined | undefined | undefined | 0 | 5207 |
| us | macro | legacy/unknown | level | 5 | undefined | undefined | undefined | 0 | 5040 |
| us | macro | legacy/unknown | level | 10 | undefined | undefined | undefined | 0 | 4598 |
| us | macro | legacy/unknown | level | 20 | undefined | undefined | undefined | 0 | 3716 |
| us | macro | legacy/unknown | change | 1 | undefined | undefined | undefined | 0 | 4525 |
| us | macro | legacy/unknown | change | 2 | undefined | undefined | undefined | 0 | 4525 |
| us | macro | legacy/unknown | change | 5 | undefined | undefined | undefined | 0 | 4394 |
| us | macro | legacy/unknown | change | 10 | undefined | undefined | undefined | 0 | 4038 |
| us | macro | legacy/unknown | change | 20 | undefined | undefined | undefined | 0 | 3254 |
| us | macro | macro_dimension_v1_20261021 | level | 1 | undefined | undefined | undefined | 0 | 169 |
| us | macro | macro_dimension_v1_20261021 | level | 2 | undefined | undefined | undefined | 0 | 92 |
| us | macro | macro_dimension_v1_20261021 | change | 1 | undefined | undefined | undefined | 0 | 67 |
| us | macro | macro_dimension_v1_20261021 | change | 2 | undefined | undefined | undefined | 0 | 4 |
| us | insider | insider_dimension_v1_20261021 | level | 1 | +0.004 | -0.133 | -0.022 | 2 | 70 |
| us | insider | insider_dimension_v1_20261021 | level | 2 | +0.003 | -0.050 | +0.115 | 1 | 38 |
| us | insider | insider_dimension_v1_20261021 | change | 1 | +0.000 | -0.283 | -0.227 | 1 | 26 |
| us | insider | insider_dimension_v1_20261021 | change | 2 | undefined | undefined | undefined | 0 | 1 |
| us | insider | legacy/unknown | level | 1 | -0.023 | -0.011 | +0.001 | 67 | 2205 |
| us | insider | legacy/unknown | level | 2 | -0.064 | -0.033 | -0.020 | 67 | 2205 |
| us | insider | legacy/unknown | level | 5 | -0.063 | -0.070 | -0.066 | 65 | 2137 |
| us | insider | legacy/unknown | level | 10 | -0.079 | -0.112 | -0.124 | 60 | 1965 |
| us | insider | legacy/unknown | level | 20 | -0.023 | -0.144 | -0.147 | 50 | 1634 |
| us | insider | legacy/unknown | change | 1 | -0.046 | -0.062 | -0.016 | 13 | 1860 |
| us | insider | legacy/unknown | change | 2 | -0.060 | -0.003 | +0.034 | 13 | 1860 |
| us | insider | legacy/unknown | change | 5 | +0.034 | +0.015 | +0.028 | 13 | 1806 |
| us | insider | legacy/unknown | change | 10 | -0.035 | -0.006 | -0.018 | 12 | 1667 |
| us | insider | legacy/unknown | change | 20 | +0.004 | +0.051 | +0.032 | 10 | 1371 |
| india | composite | composite_formula_v1_20261021 | level | 1 | +0.225 | +0.005 | -0.117 | 2 | 89 |
| india | composite | composite_formula_v1_20261021 | level | 2 | +0.367 | -0.022 | -0.079 | 1 | 43 |
| india | composite | composite_formula_v1_20261021 | change | 1 | +0.401 | +0.134 | +0.212 | 1 | 27 |
| india | composite | legacy/unknown | level | 1 | +0.170 | +0.004 | -0.033 | 65 | 1552 |
| india | composite | legacy/unknown | level | 2 | +0.228 | +0.016 | -0.032 | 65 | 1549 |
| india | composite | legacy/unknown | level | 5 | +0.358 | +0.013 | -0.057 | 63 | 1274 |
| india | composite | legacy/unknown | level | 10 | +0.470 | -0.004 | -0.122 | 58 | 890 |
| india | composite | legacy/unknown | level | 20 | +0.567 | -0.072 | -0.181 | 39 | 572 |
| india | composite | legacy/unknown | change | 1 | +0.068 | -0.005 | +0.011 | 64 | 1059 |
| india | composite | legacy/unknown | change | 2 | +0.021 | -0.009 | -0.004 | 64 | 1056 |
| india | composite | legacy/unknown | change | 5 | +0.068 | -0.056 | -0.043 | 60 | 896 |
| india | composite | legacy/unknown | change | 10 | +0.058 | -0.077 | -0.112 | 53 | 638 |
| india | composite | legacy/unknown | change | 20 | +0.035 | -0.012 | +0.010 | 35 | 410 |
| india | fundamental | fundamental_dimension_v1_20261021 | level | 1 | +0.044 | -0.180 | -0.232 | 2 | 89 |
| india | fundamental | fundamental_dimension_v1_20261021 | level | 2 | +0.091 | -0.092 | -0.109 | 1 | 43 |
| india | fundamental | fundamental_dimension_v1_20261021 | change | 1 | undefined | undefined | undefined | 0 | 27 |
| india | fundamental | legacy/unknown | level | 1 | -0.127 | -0.003 | +0.006 | 65 | 1548 |
| india | fundamental | legacy/unknown | level | 2 | -0.194 | -0.014 | +0.003 | 65 | 1546 |
| india | fundamental | legacy/unknown | level | 5 | -0.262 | -0.048 | +0.014 | 63 | 1271 |
| india | fundamental | legacy/unknown | level | 10 | -0.296 | -0.158 | -0.000 | 58 | 887 |
| india | fundamental | legacy/unknown | level | 20 | -0.311 | -0.132 | -0.022 | 39 | 569 |
| india | fundamental | legacy/unknown | change | 1 | -0.201 | -0.013 | -0.066 | 33 | 1059 |
| india | fundamental | legacy/unknown | change | 2 | -0.110 | +0.044 | -0.012 | 33 | 1056 |
| india | fundamental | legacy/unknown | change | 5 | -0.102 | +0.053 | +0.015 | 28 | 896 |
| india | fundamental | legacy/unknown | change | 10 | -0.032 | +0.074 | +0.036 | 25 | 638 |
| india | fundamental | legacy/unknown | change | 20 | +0.027 | +0.072 | +0.021 | 16 | 410 |
| india | technical | legacy/unknown | level | 1 | +0.145 | -0.010 | -0.067 | 65 | 1532 |
| india | technical | legacy/unknown | level | 2 | +0.237 | +0.001 | -0.082 | 65 | 1529 |
| india | technical | legacy/unknown | level | 5 | +0.417 | -0.004 | -0.113 | 63 | 1262 |
| india | technical | legacy/unknown | level | 10 | +0.554 | -0.008 | -0.188 | 58 | 888 |
| india | technical | legacy/unknown | level | 20 | +0.711 | -0.039 | -0.223 | 39 | 572 |
| india | technical | legacy/unknown | change | 1 | +0.111 | +0.014 | +0.030 | 64 | 1048 |
| india | technical | legacy/unknown | change | 2 | +0.036 | -0.006 | +0.016 | 64 | 1045 |
| india | technical | legacy/unknown | change | 5 | +0.080 | -0.065 | -0.038 | 60 | 888 |
| india | technical | legacy/unknown | change | 10 | +0.080 | -0.080 | -0.105 | 53 | 637 |
| india | technical | legacy/unknown | change | 20 | +0.048 | -0.028 | -0.002 | 35 | 410 |
| india | technical | technical_dimension_v2_macd | level | 1 | +0.287 | +0.117 | +0.084 | 2 | 89 |
| india | technical | technical_dimension_v2_macd | level | 2 | +0.452 | +0.034 | +0.054 | 1 | 43 |
| india | technical | technical_dimension_v2_macd | change | 1 | +0.397 | +0.138 | +0.188 | 1 | 27 |
