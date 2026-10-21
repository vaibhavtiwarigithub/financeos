# Prediction measurement completion and QA

Date: 2026-10-21. Release: `e30afb05`, Vercel production READY
(`dpl_4Pnp3ToFKVeAK57BEADhsAoyDgMG`, aliases assigned).
Scope: approved P0/P1 measurement work, not a complete audit
of every FinanceOS feature. Standard feature QA, not public-site SEO or a
cross-browser certification. Production verification is recorded after release.

## Completed implementation

- Stored dimension/composite score diagnostics, grouped by frozen formula and
  instrument family, entry/holding cohort, market and horizon.
- Nine fixed RSI/MACD rule diagnostics; no threshold search or automatic fitting.
- A paired current-technical versus recorded frozen-v1 comparison on identical
  observations/outcomes, preserving the 15-symbol formula cross-section floor.
- Latest observation slots fixed before availability checks; missing latest
  features/traces cannot select older complete observations.
- Labels bounded by their maturity/write time; no future label writes in a read.
- Narrow JSON projections; missing scores are excluded rather than zero-filled.
- Horizon-aware 90/120/240/480-day windows. The old fixed 90-day ceiling could
  never reach the h10/h20 descriptive session floors. Reads remain paginated,
  bounded and fail closed on oversized or failed scopes.
- Council comparisons separate frozen instrument families and reject blank
  baselines/invalid decision timestamps. Historical unknown identity stays unknown.
- Known crypto rows are excluded from the regular-market calendar rather than
  silently using equity-session labels for a 24/7 asset. Native crypto unchanged.
- Shared statistics owner; independent Bartlett quadratic-form reference tests.

The production read-only check independently verified 60 US observations with
technical v2, configuration hashes and frozen v1 score traces. All 60 actual
technical scores matched their recorded trace; the largest v2-v1 change was
three technical points. This proves collection/consistency, not better returns.
India's latest research predated the MACD release; its next natural write still
needs verification. No forced research, inference, setting change or broker action.

## Statistics audit

The seeded test runs 1,000 repetitions per declared zero-edge scenario. At the
INAPPROPRIATE normal |t|>1.96 cutoff, false-positive rates were:

| Synthetic sample | False positives |
|---|---:|
| 120 independent h1 observations | 4.3% |
| 24 overlapping h10 observations | 36.8% |
| 120 overlapping h10 observations | 16.0% |

This validates arithmetic and exposes normal-reference miscalibration, not an
app trading error rate or a universal replacement critical value. The UI keeps
t descriptive, with an explicit warning. No significance or promotion pass.
Reference: [statsmodels Bartlett HAC API](https://www.statsmodels.org/stable/generated/statsmodels.stats.sandwich_covariance.cov_hac.html),
with `use_correction=false`; irregular session gaps use the explicitly tested
distance-kernel extension rather than claiming statsmodels supports that input.

## Verification

- Focused tests cover raw-score availability, frozen families, formula identity,
  future labels, projected JSON paths, duplicate/missing latest slots, paired
  score alignment, strict sample floors and horizon-aware lookbacks.
- Full regression, TypeScript, production build, staged secret scan and live
  owner/anonymous access checks are required before release is called complete.
- Latest local result: 4,093 passed / 8 skipped; 36 focused tests and TypeScript
  passed. The initial 78-page Next production build passed; generated build-path
  config was restored. The follow-up independently passed its Vercel production
  build. Staged secret scans passed. The JSON report is local-only, outside repo.
- Standard live QA exercises the Show selector, horizon/cohort/symbol controls,
  empty paired evidence and 375/768/1440px contained table scrolling.
- Initial production release `fb56f96f` passed eight US/India feature/horizon
  requests but exposed a main US council GET timeout. The follow-up bounds
  price reads to actual forecast dates and memoizes only deterministic calendar
  day states, not prices or availability decisions; the performance regression
  checks at most 245 calendar evaluations for 100 forecasts over 240 daily marks.
  Deployed `e30afb05` passed all main requests; US h10 took 4.25 seconds.
- Marketing SEO, other pages, Lighthouse and Safari/Firefox are outside this
  scoped feature verification; do not infer they were audited.

### Final live checks

- All 16 main/feature requests returned 200 (US and India, h2/5/10/20).
- Main h2 matched 600 US / 250 India runs; h5 290 / 65. h10/h20 council
  outcomes remain unmatured, not a producer failure or a reason to fabricate IC.
- Feature matched rows for US h2/5/10/20: 876/937/726/552; India:
  579/571/475/296. Four known crypto rows were excluded at US h2 and h5.
- Recorded dimension rows and RSI/MACD rows displayed independently via Show.
  The paired view explicitly states that new v2/v1 future labels are not mature.
- INFY.NS holding h2 returned 26 matched rows, non-overlapping time-series mode,
  no single-symbol t and no cross-sectional paired comparison.
- Owner form submissions, both market selectors and symbol/cohort/series
  controls worked. At 375px, the 1,050px table stays in a 300px region;
  ArrowRight moved its focused scroller by 40px without page overflow.
  768px and 1440px layout checks passed; mobile screenshot inspected.
- After a fresh post-cutover navigation, main automatic GET returned 200 and
  there were zero browser console errors. Anonymous feature GET returned 401.

Sign-off: approved for this scoped release. No data were promoted to trading.
This final verification commit changes documentation only.

## Remaining queue and exact gates

1. **Forward verification:** India's next natural research write and subsequent
   scheduled council/evaluator batch; new MACD outcomes must mature. Never
   manufacture rows or re-label history to make a cell appear ready.
2. **Confirmatory inference:** a declared precision/endpoint/dependence and
   multiplicity design plus calibrated inference. The null audit above is NOT
   completion of that gate. No universal |t| threshold is authorized.
3. **Broader P0 production parity audit:** constructor, lot/cost/partial-exit,
   replay/purge and attribution-writer provenance checks listed as NOT PERFORMED
   in the architecture review remain required before portfolio-impact claims.
   Scoped source inspection confirms that `simulatePortfolio` consumes
   predeclared events, enforces cash/name/fractional constraints and uses pooled
   average cost; it does not itself run the sector/volatility/correlation
   constructor or exact tax-lot selection. The attribution writer validates
   provenance/result fields and immutable retries, not economic parity of the
   producer. Neither owner can be treated as proof of production-equivalent
   trading. No simulator defaults or money-path logic were changed here.
4. **P2 sealed measurement persistence:** separate storage/migration approval
   and the architecture's maturity/review gate; read-time hashes are not sealed
   experiments. No new schema is applied in this release.
5. **P3 prompt challenger/score-hidden ablation:** separately approved cost and
   paired pilot/precision design. No extra LLM calls are authorized here.
6. **P4 supported strategy family:** freeze actual rules, universe, calendar,
   costs and purged OOS protocol. The existing full-sample replay seam must
   continue refusing a false OOS seal.
7. **P5 program-specific portfolio impact:** explicit baseline/intervention and
   canonical production-parity replay producer. Score IC is not portfolio P&L.
8. **P6 critic/review loop and adoption:** later bounded proposal/confirmation
   gates; no autonomous prompt, formula, weight or trading change.

Future inference also requires verified exchange-calendar coverage for the
dates it uses. Widening read capacity does not invent unsupported future sessions.
Other app programs retain their own work-log/architecture gates; this release
does not claim the entire historic backlog, Guardian execution, broker lifecycle
or every Upgrade Path attribution producer is complete.
