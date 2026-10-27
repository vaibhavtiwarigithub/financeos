# Macro Context, Historical Analogs, and Symbol Sensitivity

> Status: **P0 visibility + append-only US regime-state capture implemented; P1A read-only, label-mature macro outcome diagnostic approved and implemented 2026-10-27; historical-analogue forecasting remains unbuilt and is not evidence-ready.**
> Owner direction: 2026-10-16. All work in this feature is measure-only.

## Decision record

- **Why:** The owner wants Kairos to relate today's economic/market conditions to prior episodes and show how individual symbols may be affected.
- **Who:** The Kairos owner reviewing US and India research and paper-portfolio decisions.
- **ROI:** Make existing evidence understandable, then test whether regime-conditioned, symbol-specific context adds forward information beyond the deterministic scorer. No performance improvement is promised.
- **shippedAt:** 2026-10-18 for P0 visibility only (`2c7e4a44`, production READY).

## What Kairos already does

| Capability | Current behavior | What it does not establish |
|---|---|---|
| US MacroSentinel | Weekly deterministic US FRED indicators produce a market-wide `macro_regime` / `macro_score`. It can affect the common score level, but it cannot rank one US stock above another on the same run. | It does not find comparable historical episodes or estimate each company's response. |
| India macro observations | Daily collector retains dated India and global series in `india_macro_observations`; India macro remains excluded from scoring. | Historical rows are source/observation history, not a validated regime-conditioned forecast. |
| India company macro exposure | Weekly shadow regresses a symbol's daily return on NIFTY 50, USD/INR, Brent and India VIX changes. It requires 120 matched observations and 80% factor coverage and writes `india_macro_exposures`. | OLS beta/t-stat are historical associations, not causal effects, conditional forecasts, or expected returns for today's move. |
| Sector-regime diagnostic | An on-demand US diagnostic measures sector ETF relative strength versus the market on labeled research dates. | It is not conditioned on macro episodes and is not a scheduled persistent performance shadow. |
| `market_regime_runs` | Append-only schema foundation exists. | Production currently has no rows; it is not an active regime-history producer. |

## P0 shipped here: expose existing evidence

The Learning page receives an owner-only, read-only `Macro context & symbol sensitivity` panel. It shows:

1. The latest US regime snapshot and its date / indicator coverage.
2. The latest dated India macro factor observations.
3. Latest India `asof4d_v2` per-symbol exposure estimates, sample count, window, beta, t-stat, and R².
4. An explicit status that historical episode matching is not yet implemented/validated, including the production count of `market_regime_runs`.

The existing weekly US MacroSentinel now appends its validated US-local state to
`market_regime_runs` under formula version `macro-sentinel-state-v1`. The ledger
maps green/yellow/orange/red to supportive/neutral/adverse and maps unknown to
unavailable; global spillover remains unavailable. It uses the existing
append-only unique fingerprint contract and writes no new table or migration.
This starts prospective history after rollout. A same-week retry can capture the
already-recorded `macro_regime` row using its original `created_at`; it does not
bulk backfill the 17 legacy weekly snapshots or treat them as a clean
point-in-time series.

The panel does not infer or display a symbol-level expected return from beta × today's move. It does not call an LLM, fetch new provider data, write rows, or influence scoring, eligibility, sizing, rotation, exits, or execution.

## P1A implemented: market-local macro outcome diagnostic (measure-only)

The former P1 proposal is split so the application can answer the currently
supportable question without pretending the full historical-analogue model is
ready. `GET /api/learning/macro-performance?market=us|india` and the Learning
page's Macro context panel consume existing first-seen inputs, frozen research
observations, and matured `observation_labels`. This is an on-demand read: no
new table, cron, provider call, inference, or database write.

### Market-specific estimands

- **US:** The stored `macro_score` and stored `analyst_score` are evaluated as
  time-series predictors of next 2/5/10/20-session benchmark-neutral returns.
  Decisions are collapsed to one median score and one median return per
  market-local date (and instrument family where available); symbols on the
  same day are not counted as independent macro observations. The endpoint
  also reports macro's existing threshold-attribution cohorts from the frozen
  score ledger. This is research-cohort attribution, not a portfolio replay or
  causal estimate. A common macro scalar has no cross-sectional Rank IC.
- **India:** Macro is still structurally **not enabled in the composite**.
  The endpoint evaluates each existing India factor separately against matured
  forward benchmark-neutral returns by instrument family. A factor observation
  is usable only when both `obs_date <= decision date` and its first-seen
  `fetched_at <= decision timestamp`; historical rows fetched later are never
  backdated into the feature set. The output is a time-series association of
  one shared daily factor state with per-date family-average outcomes, not a
  per-symbol causal exposure or an India macro score.
- **All instrument families:** Fundamental availability/applicability stays
  governed by `dimensionApplicability` and instrument taxonomy. Macro is a
  market/factor context, not an issuer fundamental. ETF, commodity, leveraged,
  and operating-company outcomes are reported separately only when the
  immutable research cohort and taxonomy permit; leveraged results remain
  daily-return evidence and do not validate intraday stops or holding rules.
- **LLM council:** Its frozen input packet already contains the deterministic
  dimension scores and stored feature evidence, including a `macro` score field.
  The council output is a single 0–100 relative-attractiveness forecast; it
  does not emit a separate macro forecast or prove that it used any specific
  dimension. The council’s existing per-model and composite label evaluation
  remains the way to assess that forecast. This implementation neither changes
  the council prompt nor adds inference.

### Evidence contract

- Uses only completed `observation_labels` with non-null
  `benchmark_neutral_return`, matched to their immutable decision timestamp.
- Reports per-market, per-family, per-factor/score-series and horizon: matched
  dates, symbol rows, missing factor/label coverage, Spearman rank correlation,
  and horizon-spaced non-overlapping date-window count. Window count is not an
  effective sample size and dates/windows are not asserted to be independent
  macro episodes.
- Inferential t-statistics and “validated” status are withheld. No promotion
  threshold is crossed by this diagnostic; sparse macro episode history and
  repeated regimes remain explicit limitations.
- Empty or immature cohorts are `insufficient`, not a zero score, failed
  collector, or neutral/pass result. Query failures remain visible errors.
- India beta estimates remain historical co-movement only. They are shown in
  P0 context but are not multiplied by current shocks to manufacture a return
  forecast. US historical analog status remains separate from the legacy
  `macro_regime` consumer.

### Non-goals and promotion boundary

This stage does not add macro to India's composite, change US macro's current
score contribution, tune thresholds/weights, change instrument-family
applicability, affect council prompts or scores, or alter any portfolio or
trading behavior. The existing US MacroSentinel score and India macro shadow
remain independent. Any future regime/sector interaction, policy sizing, or
money-path use needs its own frozen version, point-in-time data contract,
paired portfolio replay, out-of-sample review, and separately approved
promotion. A descriptive correlation is not evidence that changing a formula
will improve returns.

## Correct design for a future historical-analogue shadow

The desired question is not “what happened in one vaguely similar crisis?” It is:

> Given only the macro and market information available at decision time, do a small, predeclared set of comparable prior states improve the distributional forecast of future same-market benchmark-relative returns for a symbol or sector?

The future shadow must:

1. **Use point-in-time inputs.** Preserve observation, publication/availability time, source, revision/vintage, and quality. Revised macro values cannot be backfilled into earlier decision dates as if they were known then.
2. **Keep markets separate.** US effects use USD and a US benchmark; India uses INR and NIFTY. A US macro regime cannot stand in for India's domestic state.
3. **Represent state and exposure separately.** A market-wide state (rates, inflation/activity, volatility, breadth, FX/oil where relevant) is interacted with a reviewed symbol/industry exposure. Do not add another same-for-all scalar to the composite and call it stock selection.
4. **Use a small frozen feature set and deterministic matching.** Standardize only with training-period data; predeclare distance, lookback, candidate count, and non-overlap/purge rules. Unknown industry exposure remains unmapped.
5. **Report outcomes, not anecdotes.** For each market, sector, and eligible symbol, report forward 5/10/20-session raw and benchmark-excess return distributions, sample and independent-window counts, uncertainty intervals, and missing-data coverage. Compare against unconditional and deterministic-score baselines.
6. **Withhold conclusions on thin evidence.** Separate market regimes into distinct episodes, not daily rows. Overlapping horizons do not count as independent. Insufficient support must render “insufficient,” never a neutral forecast or a pass.
7. **Evaluate forward-only.** Freeze a declaration/code version before collecting predictions. Measure per-horizon IC/t-stat and portfolio-level paired results only after labels mature, with multiple-testing control and walk-forward splits.
8. **Stay shadow-only.** Promotion requires separately reviewed, market-local evidence and explicit owner approval. No current macro feature may directly buy, sell, size, widen a stop, or change a target.

## Current readiness and blockers

Production verification on 2026-10-16:

- `india_macro_exposures`, method `asof4d_v2`: 148 rows `ok`, 9 rows `insufficient_observations`, with valid rows spanning 2026-09-11 through 2026-10-12; the sample window has 124–360 observations.
- `market_regime_runs`: 0 rows before rollout of this capture. After rollout, one row is appended per unique weekly US state; India remains empty until an approved India regime producer exists.
- Legacy US `macro_regime`: 17 weekly snapshots from 2026-06-29 through 2026-10-12; the small count and sparse state episodes do not support reliable historical episode inference.
- India factor histories include daily market/volatility/FX/oil observations, but the symbol-return ledger available to this application begins materially later than the oldest factor history. Historical inference must use the overlapping, label-mature interval and preserve source timing.
- US currently has no equivalent per-symbol macro-exposure producer in the app.

### Exploratory pilot result (2026-10-16)

The read-only India proxy check is recorded in
`docs/audits/2026-10-16-macro-sector-pilot.md`. It used production NIFTY,
ITBEES, BANKBEES, JUNIORBEES, India VIX, USD/INR and Brent history. The fixed
non-overlapping 20-session VIX-high cohort had only one window (windows are not
necessarily independent macro episodes); 5-session
differences varied by sector and macro variable. The stored benchmark series
are close-only, while historical macro rows do not preserve original release
timestamps. Therefore this is a data-readiness diagnostic, not a point-in-time
prediction test, not evidence of incremental value, and not a reason to change
scoring. The richer local ALFRED vintage archive (1991 onward) and NSE bar/action
archive (2020 onward) are available in `%USERPROFILE%\\.kairos\\evidence`; they
need a matched total-return sector/index dataset before a valid replay.

An official-source check found that NSE Indices' historical reports expose
sector-index Total Returns Index (TRI) observations and a one-year Nifty IT
request returned dated values. However, the site's [Terms of Use](https://www.niftyindices.com/terms-of-use)
prohibit systematic or automated data collection without express written
consent. NSE's research-data list includes historical index data in its
first-basket category, which can be free or at-cost; this is not a blanket
license and does not override the site terms. The endpoint is therefore **not
approved for a Kairos collector or bulk downloader**. The next gate is written
permission or a licensed dataset, plus confirmation of use and retention terms.
TRI methodology is documented by
[NSE Indices](https://www.niftyindices.com/resources/index-concepts/total-return-index).

Therefore P0 makes existing evidence visible but does **not** claim the requested historical-analogue capability is complete. P1 requires a reviewed point-in-time input contract and a market-local, append-only prediction/evaluation producer; do not mark it ready merely because the P0 panel exists.

## Acceptance criteria for future P1B historical analog forecasting

- Reproducible, versioned feature vector and input fingerprint for each market-local as-of date.
- No data whose `available_at` exceeds the decision timestamp.
- Analog dates are distinct episodes and horizon-purged; training/validation boundaries are time-based.
- Every displayed effect states its own sample size, independent windows, market, benchmark, horizon, source coverage, and confidence interval.
- A mutation test proves a future value cannot change a prior as-of feature or result.
- Compare against unconditional return and the existing deterministic score on identical rows.
- A visible `insufficient` state when independent analog windows are inadequate.
- No money-path imports or changed score/order behavior.
- For NSE Indices TRI, documented permission/licensing for automated collection,
  retention, and the intended research use before any scripted acquisition.
