# Codex result — three-day architecture-to-implementation review

Date: 2026-09-03
Reviewed range: `07d142ab..146e9b89` (2026-08-31 through 2026-09-03)

## Verdict

Four shared defects were confirmed and fixed locally:

1. Edge-readiness independence used a flat five-calendar-day gap for every horizon. It now uses
   `ceil(horizonSessions * 7 / 5)`, so h5/h10/h20 require 7/14/28 calendar days.
2. Run accounting classified a run with expected skips plus unavailable inputs as blocked. It now
   reports `partial_unavailable`; a blocker requires zero expected skips.
3. India quote corroboration used Upstox historical candles, which can represent the prior market
   session. It now batches Upstox Full Market Quotes and uses `last_trade_time`; a fetch timestamp
   is deliberately not treated as evidence that the symbol traded in the current session.
4. Upgrade Path Router readiness combined different candidate tuples and required all historical
   proofs to remain inside the 72-hour evaluation TTL. It now mirrors the activation RPC: ten
   passing market sessions for one exact tuple in the trailing 45 calendar days, with only the
   selected evaluation required to be fresh.

The LLM truncation claim was not a surviving production defect. The six alleged post-fix failures
occurred before the complete fix was committed/deployed; five predated the retry commit and the
sixth preceded both the token-floor and duration commits. Forty-five later calls through the end of
the inspected interval had zero failures. Three call sites were nevertheless made explicit about
the 16,000-token reasoning budget so the router floor is a safety guard rather than routine control
flow.

## Mutation and build evidence

Each behavioral fix has a detector that was mutation-checked:

- restoring the flat edge window fails two readiness tests;
- restoring the broad blocker predicate fails the mixed-outcome accounting test;
- replacing the live Upstox quote call with the historical-candle path fails the source detector;
- relaxing the Router tuple match to market-only changes the count and fails the registry test.

The full repository suite passed: 270 test files passed (1 skipped), 2,428 tests passed (7 skipped).
TypeScript and the production Next.js build also passed. These prove the local checkout, not a
deployment.

## Architecture findings

### OOS runner is not ready to schedule

The brief's proposed `costPolicy.oneWayBps = 5` would record metadata but would not make the result
cost-adjusted. The current runner computes raw IC, `includedInIc` is false, and no production
predeclared experiment manifest exists. A truthful scheduled OOS run still needs:

- an approved, predeclared trial/family manifest;
- turnover and net-of-cost computation, not merely a stored cost-policy number;
- a persisted Benjamini-Hochberg/FDR contract;
- a point-in-time India membership source.

No route or schedule was added because doing so now would falsely label a raw result as
`pit_walk_forward_cost_adjusted_fdr`.

### Schema/deployment checks

- `strategy_template_shadow_configs` is absent in production, consistent with its migration being
  explicitly marked not applied.
- `exit_stop_shadow_runs` exists but has zero rows.
- `trial_family_ledger` exists with four rows.
- `strategy_evaluations` exists with zero rows.
- `backtest_experiments` has 18 rows.
- `price_cache` contains the provenance columns and 75,425 rows; its restatement table has 47,386
  rows. A nonzero restatement is not automatically corruption because OHLC/volume and provenance
  qualification may legitimately change.

## Decisions requested in the brief

### 1. Edge calibration

Use horizon-aware spacing. The old five-day rule over-counted h10/h20 observations drawn from
overlapping forward-return windows. The policy version is now `edge-readiness.v2-horizon-spaced`.
Existing IC history remains immutable; readiness is re-derived under the new policy.

### 2. Run accounting

The 16 eligible / 13 expected-skip / 3 unavailable case is degraded/partial, not blocked. It should
warn because coverage was incomplete, while preserving the distinction between intentional
eligibility refusal and a system that could not operate.

### 3. Execution cost

Five basis points per side is defensible only as a clearly labelled, conservative replay placeholder;
it is not a universal India mid-cap execution model. NSE notes that impact cost varies with the
security, order size, time, and side, and is a better liquidity measure than quoted spread alone:
https://www.nseindia.com/static/products-services/indices-impact-cost

The next shadow should estimate market-, liquidity-, session-, and order-notional-specific cost from
executable book snapshots: half-spread plus depth-weighted impact for the proposed quantity, with
fees and taxes separate. Do not calibrate from the existing 205 fills: all echo the same five-basis-
point assumption and therefore contain no empirical cost variation.

### 4. Bid/ask fill path

Real quotes should eventually drive paper-fill simulation, but raw `ask` must not simply be inserted
into the current formula because that can charge both the observed spread and the same modeled
slippage again. Validate freshness, an uncrossed positive book, and available depth; calculate buy
VWAP through asks or sell VWAP through bids for the intended quantity; then apply only a separately
calibrated residual-impact term.

### 5. India corroboration provider

Use the already-integrated Upstox provider rather than adding a vendor first. Its official Full
Market Quote response includes last price, last trade time, OHLC, and market depth:
https://upstox.com/developer/api-documentation/get-full-market-quote/

Its read-only analytics token is valid for one year and supports Market Quote APIs:
https://upstox.com/developer/api-documentation/analytics-token/

Kite remains a fallback, not the primary cron dependency, because its access token expires at 6 AM
the next day: https://kite.trade/docs/connect/v3/user/

### 6. Evidence Router promotion

- **US: do not promote.** Its latest evaluation fails quality, has one eligibility flip, and the
  exact tuple has only four distinct full-passing sessions.
- **India: eligible for an owner-controlled canary, not silently activated by this audit.** The
  latest selected evaluation is fresh through 2026-09-06, is a full pass with zero flips and zero
  review items, and has 23 distinct passing sessions for its exact tuple.

The former System Health alert reporting US 5 / India 6 and asking for an eligibility-flip guard is
stale: the guard exists and the counts were computed under the defective adapter. Deploy the adapter
fix, resolve that stale alert, then activate India alone as a monitored canary. US must remain shadow.

### 7. Macro Stage 2

Choose a **sizing-throttle shadow**, not an eligibility cliff. The exact Stage 1 replay across 5,143
modellable US rows changed scores by 2.83 points on average, produced 152 downward versus 35 upward
threshold crossings, and increased dispersion about 21%. A cliff would create another discontinuity
around a threshold and amplify availability-mask effects. A bounded monotone sizing throttle preserves
cross-sectional ranking and is reversible.

There is not enough evidence to choose or activate a throttle curve. Require prospective,
market-local dangerous-regime observations and compare benchmark-relative return, drawdown,
turnover, and foregone upside before changing the money path.

## Remaining non-blocking debt

Production `agent_config.max_tokens` values remain misleading because those rows do not currently
control the call-site budget. Either make the configuration authoritative end-to-end or remove the
dead field from operational displays. Also review the tracked agent-skill copies separately; they
add substantial repository surface and should not be removed casually because local tooling may
depend on them.
