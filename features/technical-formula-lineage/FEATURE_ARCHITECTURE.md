# Direct MACD and versioned formula evidence

Owner request: 2026-10-21. Direct MACD in technical scoring is explicitly
authorized, not a new shadow. Formula/feature diagnostics are read-only.
This supersedes the earlier MACD-only measure boundary, and ONLY that boundary.

## Decision and scope

Why: make the owner-requested momentum input real, and make later formula
comparisons interpretable. Who: the owner, US/India equity/ETF research.
Expected ROI: improved traceability and testability; better returns are NOT
established. Record release evidence in WORK_LOG.md.

- Keep the exact old technical scorer callable as `scoreTechnicalsV1` for
  frozen `kairos_technical_score_v1` trials. Never relabel historical rows.
- Active `technical_dimension_v2_macd` = clamp(round(v1 score +
  `5*tanh(MACD histogram / ATR14)`), 0, 100). Require the fully warmed 12/26/9
  MACD (34 closes), finite line/signal/histogram and positive finite ATR.
  Missing/incomplete MACD contributes zero, with unavailable status.
- The existing breakdown veto and <15-candle neutral rule take precedence;
  MACD cannot lift a vetoed name above 20. No new eligibility or exit gate.
- Five points is a bounded policy prior, not a fitted optimum. MACD overlaps
  existing momentum; do not add separate line/zero-cross/crossover bonuses.
  No raw-dollar thresholds across differently priced/currency symbols.
- Keep outer weights, thresholds, live enablement and native crypto formula
  unchanged. Ordinary research score changes can naturally affect subsequent
  decisions through existing gates; no historical rescore or forced trade.

## Reuse and lineage

Extend `lib/data/technicals.ts`, not a new indicator stack. Compute previous
bar MACD state only from the same candle slice. A true crossover needs 35
closes; positive histogram alone is NOT called a crossover.

One typed formula manifest names technical, fundamental, sentiment, macro,
insider and composite methods. Unchanged dimensions get a current baseline
identity whose scope starts now, not a retroactive assertion that their entire
history used one formula. Store actual configuration/weights/mask/ETF cap and
a deterministic fingerprint alongside method IDs. Every coefficient, anchor,
input rule or applicability change requires a new ID and updated manifest.

Reuse `research_packets.raw_data`, `agent_signals.signal_breakdown`,
`decision_observations.features` and existing per-dimension history JSON.
No migration. `score_source=deterministic_v1` remains the existing deterministic
execution-authority protocol, NOT the formula identity. Do not change that
string without migrating all gates. Strategy/scoring_version is not repurposed.

Council lineage retains its own prompt/output contract, actual/requested model,
execution source/effort roster and independent/debated stage. Freeze the
aggregation method version in new run snapshots. This does not change prompts,
rosters, inference volume, consensus math or trading influence.

## Feature diagnostics and use

Completion amendment (2026-10-21): the same read-only reader also exposes the
five recorded dimension scores and recorded composite, partitioned by their
own frozen method identity and instrument family. Missing/inapplicable dimension
availability is excluded, not converted to a neutral score. These rows can have
different available samples and are NOT a paired winner leaderboard. A Show
selector switches between score formulas and the nine fixed RSI/MACD rules
without another data request. No score formula changes in this amendment.

Diagnostic plan v2 fixes the latest symbol/session observation before checking
each indicator's availability; a missing latest value cannot select an earlier
complete observation. Labels must have matured by the read cutoff. Unknown
historical families stay unknown; do not classify them with today's taxonomy.
Council comparisons also separate frozen families. New read-time identities
do not rewrite any stored evaluator result.

Live-QA follow-up: v3 excludes rows explicitly recorded as crypto from these
regular-market diagnostics. Crypto requires a native 24/7 session/label owner;
it must not acquire stock-session inference merely because settlement is USD.
Unknown historical families remain unknown, not reclassified today.

The same reader offers a paired technical-current versus frozen-v1 diagnostic
only when BOTH scores were recorded together in the decision-time score trace
and its current score equals the observation's technical score. It reuses the
matched-score statistics owner and retains the stricter 15-name formula floor,
not the council's five. It compares identical outcomes/observations within each
recorded family and reports descriptive paired IC lift, never P&L or adoption.
Missing latest traces remove their slots, not resurrect older complete scores.
Single-symbol cross-sectional comparisons remain undefined; old v1 traces are
never reconstructed from current provider data. No new inference or collector.

Read windows are horizon-aware: h2/5/10/20 use 90/120/240/480 calendar days.
A fixed 90-day window could never satisfy the existing h10/h20 descriptive
session floors. Pagination reads the complete selected scope (up to 60,000
label/run rows, then explicit refusal, never a silently clipped result).
The feature query projects only required JSON paths and score/session fields,
not full research packets. Wider capacity is not an inference pass: calendars,
actual qualifying dates, mature outcomes and sample validity must still pass.

The council price read starts no earlier than the earliest actual forecast
decision (with a one-day timezone margin), not the whole potential read span.
The shared availability-label owner memoizes only deterministic daily calendar
states in a private 2,048-entry cache; availability/cutoff/price decisions are
not cached. Numerical label semantics and version stay unchanged. A regression
checks calendar work scales with unique dates, not forecasts multiplied by bars.

Reuse the Prediction Lab read-only endpoint and panel. Predeclare RSI level
and bands, MACD/ATR histogram, signal relation, zero relation, and confirmed
bullish cross above/below zero. Do not search unlimited periods/thresholds.

Separate market, horizon, formula identity and entry-versus-holding cohort.
Cross-sectional IC ranks multiple symbols on the same session (>=5). For a
selected symbol use time-series rank correlation and non-overlapping horizon
windows; a single-symbol cross-sectional IC is undefined. Binary rules also
need triggered/control counts and return contrasts, not just a correlation.
Both signs and losing rules remain visible. Multiplicity/selection means all
these are exploratory; no uncalibrated p-value or "best stock formula" claim.

Prefer pooled market/instrument rules, then regularized sector/industry
interactions only if they replicate on untouched time windows. Individual
stock overrides require independent evidence beyond the pooled rule. Purge
overlapping train/test outcomes, log all attempted variants, inspect neighboring
parameters and costs, and confirm forward. No autonomous parameter mutation.

Historic rows missing formula/state provenance remain legacy/unknown or missing;
never infer yesterday's crossover from sparse research timestamps. Point-in-time
fundamentals/sentiment cannot be manufactured from current API responses.

## Acceptance and release

Test bullish/bearish/zero MACD, price scaling, missing/invalid ATR, warmup,
unchanged V1 edge, veto precedence, deterministic lineage fingerprint and
unknown-history handling; test diagnostics cohorts/constant values/overlap.
Verify US and India source rows, TypeScript/full suite, secret scan, main sync,
Vercel READY and real authenticated UI. Do not trigger trades or paid research
to verify collection; the next natural research/evaluator run proves writing.

Sources: Fidelity MACD guide (12/26/9 and whipsaws),
https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd
and Bailey et al., The Probability of Backtest Overfitting,
https://carmamaths.org/jon/backtest2.pdf . These support definitions/validation
discipline, not the profitability of this chosen five-point contribution.
