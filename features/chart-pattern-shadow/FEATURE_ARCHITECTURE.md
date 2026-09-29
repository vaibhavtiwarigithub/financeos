# Chart-pattern detection — shadow arm

> Status: **Owner-approved; measure-only implementation built locally on 2026-09-28.**
> Date: 2026-09-28. Influence: **none.** Detection writes an observe-only ledger;
> nothing in scoring, entry, exit, or rotation reads it. Promotion to `scoreTechnicals` would be
> a separate, later, evidence-gated proposal — not authorized here.
> Context: today's research answered "does technical scoring detect chart patterns?" — no. This
> proposes how to find out whether it *should*, without repeating the mistake this codebase has
> already made once (`features/systematic-pattern-discovery/FEATURE_ARCHITECTURE.md`, parked).

## The one hypothesis

> **H1 — A confirmed double-top or double-bottom, detected deterministically from the same daily
> completed close candles ResearchAgent already reads, has positive signed forward return over the
> next 10 sessions, net of benchmark, in Kairos's own research universe.**

Declared **single** and **two-sided** (a double top predicts down, a double bottom predicts up —
tested as one signed effect, not two separate claims to be cherry-picked from). Nothing else is
tested in this pass: no head-and-shoulders, no triangles, no candlestick formations, no scoring
change, no threshold. If H1 is not clearly positive, the next-most-complex pattern is not
automatically tried next — that would just be the multiple-comparisons trap `systematic-pattern-
discovery` already flagged, one pattern at a time instead of two hundred features at once.

## Why double-top/bottom, and why not the rest of the pattern zoo

- **Geometrically well-defined.** Two comparable swing closes at roughly the same price, a
  retracement between them, and a break of the intervening trough/peak. This can be written as an
  explicit, deterministic rule with no smoothing, curve-fitting, or judgment calls — the same bar
  this codebase holds every other scoring input to.
- **Confirmable, not just visible.** The pattern is only "detected" once price breaks the neckline;
  before that it is two swing points and a guess. This avoids the single biggest source of chart-
  pattern false-positive claims (seeing the pattern only after the move that would have confirmed
  it already happened).
- **Head-and-shoulders, cup-and-handle, triangles, wedges** are harder to specify without either a
  trained model or a pile of heuristic tolerances that quietly become curve-fit knobs. Deferred
  until H1's own detector proves the methodology is worth extending.
- **Candlestick single/multi-bar patterns** (hammer, engulfing, doji) are a separate hypothesis and
  are deferred so this experiment has one fixed pattern family.

## Why this is NOT `systematic-pattern-discovery`

That parked feature mines 15-20 years of history across thousands of symbols, including delisted
names, to discover unknown effects — and is blocked on survivorship bias and multiple comparisons
because of that scope. This proposal does neither:

- **No historical data acquisition.** Detection runs forward, on candles Kairos already fetches
  for symbols already in the research universe (`fetchUsCandles` / the India candle path). This is
  prospective shadow measurement, not a historical backtest; the eligible universe can still change
  over time, so conclusions apply only to the observed live research cohort.
- **One declared hypothesis, not a feature-mining sweep.** No p-hacking risk from testing 200
  patterns at once, because there is one pattern and one signed prediction.
- **Reuses the existing observation/label infrastructure** (`decision_observations` +
  `observation_labels`) rather than building a new backtest harness.

## What the shadow arm does

`chart_pattern_shadow_runs` — measure-only, one pattern, no scoring influence.

1. On each completed research decision for an entry-eligible long (the same population
   `decision_observations` already covers), run a deterministic detector over that symbol's
   trailing ~60 daily candles (already fetched for `computeTechnicals`; no new provider call):
   - Find local swing highs/lows from closes (fixed 3-bar radius fractal).
   - A **double top** candidate: two swing highs within the fixed 2% close tolerance,
     separated by a trough at least a configured retracement below both peaks, confirmed only once
     price closes below that trough.
   - A **double bottom** candidate: the mirror condition.
   - No pattern found → an explicit `no_pattern` attempt row.
2. Write one immutable attempt for every eligible-long entry decision: `detected`, `no_pattern`, or
   `insufficient_candles`. This explicit denominator distinguishes a negative detection from a
   dead producer. Geometry is stored only for detected patterns.
3. Do not write future labels into the decision-time row. The owner-only report joins the immutable
   attempt to separately matured `observation_labels` at h5/h10/h20.
4. Construct session-indexed, non-overlapping horizon blocks from the primary benchmark's complete
   market-session calendar; average eligible-long signed pattern-event returns within each block.
   Refuse the verdict if a decision session is absent from that calendar. Do not treat
   individual symbols or overlapping horizons as independent observations.
5. Report event counts, matured counts, independent blocks, point estimate and Student-t interval.
   Fewer than 20 blocks is `insufficient`; ≥20 is `validated` only when the two-sided 95% interval's
   lower bound is positive, `contradicted` when its upper bound is negative, otherwise `undetermined`.
6. Refuse a verdict if either bounded source query is incomplete or unavailable.

## Statistics, declared in advance

- Two-sided mean paired against benchmark-neutral forward return: double-top decisions and
  double-bottom decisions contribute with opposite expected sign, combined as "predicted direction
  minus benchmark" so a real effect in either pattern shows up as positive.
- One mean per non-overlapping horizon-sized block per market; event rows are not independent.
- Student-t two-sided 95% interval and 20-independent-block floor before positive validation.
- US and India reported and required to pass **separately**. A pooled cross-market average is not
  evidence, per this project's own standing rule.
- Reports pattern frequency (how often it fires at all) alongside the return statistic — a pattern
  that fires twice a year in the whole universe is operationally uninteresting even if the point
  estimate looks good.

## Non-negotiable rules (carried over from every other shadow in this codebase)

1. **No LLM.** Swing detection, tolerance bands, and confirmation are arithmetic on completed closes, nothing
   else.
2. **Per-market.** US and India patterns/statistics never combine.
3. **Zero influence.** `chart_pattern_shadow_runs` is read only by its owner-only report, Upgrade
   Path status and liveness probe. `scoreTechnicals`, entry eligibility, the exit ladder, and
   rotation do not consume this feature.
4. **Fail-closed.** Missing candle history is recorded as `insufficient_candles`; an unmatured
   label is absent from the report until the labeler writes it. Neither becomes a guessed pattern or outcome.
5. **Append-only ledger,** same trigger pattern as every other `*_shadow_runs` / `*_events` table
   (`rotation_events`, `upgrade_path_shadow_book_runs`).

## Data model

### `chart_pattern_shadow_runs`

- `id`, `created_at`
- `market` (`us`|`india`), `symbol`, `detection_status`, optional `pattern_type`
- `swing1_date/close`, `swing2_date/close`, `neckline_date/close`, confirmation date/close
- non-null `decision_observation_id` FK, `candles_through_date`, candle provider, detector version/config
- No outcome columns: future evidence is joined from immutable `observation_labels` after maturity.
- One attempt per observation, including `no_pattern` and `insufficient_candles` controls.

RLS: owner-read only for the authenticated owner; service-role SELECT/INSERT only. No anon access,
and no authenticated INSERT/UPDATE/DELETE/TRUNCATE grants.

### Producer and report

ResearchAgent performs a fail-soft side-write immediately after inserting the canonical
`decision_observations` row. It adds no provider call or cron. A write failure raises a System Health
warning; the liveness probe and Upgrade Path expose collection state. The owner-only
`/api/agents/chart-pattern-shadow?market=us|india` endpoint joins matured labels and reports
independent-block intervals. With `symbol=<ticker>`, it returns the symbol's latest attempt and candle
provenance for the symbol research page's **Price & Technicals → Candle-pattern evidence** panel. This
is explicitly shadow evidence, not an addition to the technical score. A missing table or failed read
is rendered as unavailable—not as “no pattern.” The market report is descriptive event evidence, not
paired portfolio P&L.

## Upgrade Path registration

Registers in `lib/shadows/registry.ts` as `attributionClass: "operational_only"` because a forward
return signal study is not a portfolio-level baseline/variant replay. It is categorized as
`Scoring`, visible in market-local Upgrade Path status, and cannot claim portfolio improvement.

## Phasing

### P0 — Detection + shadow measurement (this proposal)

Build the detector, the table, the producer, the report. No code path outside this feature reads
the table. This is the entire scope of what "approved" would authorize.

### P1 — Promotion review (separate future proposal, not pre-approved)

Only after P0 reports `validated` in **both** markets independently: propose how (if at all) a
confirmed pattern would enter `scoreTechnicals` — as a bounded adjustment, not a new dominant
factor, and only for the exact confirmed geometry tested in P0. Explicitly requires a fresh owner
approval; P0 passing is not itself that approval.

### Out of scope, this proposal and P1

Head-and-shoulders, triangles, wedges, cup-and-handle, candlestick formations, any ML/CV-based
pattern classifier, any change to `scoreTechnicals`, entry eligibility, exit ladder, or rotation.

## Open questions for the owner

Resolved by owner request and implementation: side-write reuses existing research candles; the
3-bar pivot radius, 2% extreme tolerance and 3% retracement are explicit, unlearned starting values;
P0 remains double-top/bottom only. These constants are not optimized or literature-validated. No
pattern is proven until the separate-market report passes its predeclared block and interval gates.

## Implementation status

Source, owner-only report, Upgrade Path/liveness registration, tests, and architecture
chapter updates are implemented and deployed to production in main commit
`a9b8c3abae1b4eb1a4edf031ac6d58af7d30d2e7` (Vercel deployment
`dpl_D3XZ5KminbCmyFTXGxd8XUDXJ4Xh`, READY 2026-09-29). Production schema migration
`20260929215738` is applied and its RLS/append-only controls are verified. The shadow is
collecting prospective evidence only; it has not established predictive value or portfolio
P&L improvement. Wait for sufficient matured, independent market-local observations before
considering any separate scoring proposal.
