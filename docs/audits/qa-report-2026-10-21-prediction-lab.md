# Prediction measurement completion and QA

Date: 2026-10-21. Scope: approved P0/P1 measurement work, not a complete audit
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
- Local result: 4,092 passed / 8 skipped; 29 focused tests passed. TypeScript
  and the 78-page Next production build passed. Generated build-path config was
  restored. The JSON regression report is local-only, outside the repository.
- Standard live QA exercises the Show selector, horizon/cohort/symbol controls,
  empty paired evidence and 375/768/1440px contained table scrolling.
- Marketing SEO, other pages, Lighthouse and Safari/Firefox are outside this
  scoped feature verification; do not infer they were audited.

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
