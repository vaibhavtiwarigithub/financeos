# Feature Architecture: Live Recommendation Tracker and Guardian Scorecard

## Approved exact-stop measurement extension — 2026-10-22

Owner approved the preceding discussion with “go”. Why: measure whether the
actual suggested stop adds value, including premature exits, instead of showing
generic buy-idea stop arms as Guardian evidence. Who: the owner, both market
views. ROI: trustworthy incremental outcome evidence without new inference or
trading authority. ShippedAt: 2026-10-22; measurement runtime `0242a4d4`
verified production READY. The same release includes the shared display and
nightly persisted evidence; the older buy-idea stop experiment is explicitly
labelled separately and does not revise an actual Guardian stop.

Reuse `live_recommendations`, `live_recommendation_marks` and the existing
22:30 UTC nightly job. Add `market` and nullable `guardian_contract` to the
recommendation and nullable `guardian_outcomes` to marks. No new table, route,
model or order mechanism. Existing rows retain null contracts (legacy/ungraded).
Service-only invoker triggers capture actual future stop suggestions from the
position ledger and plans, with stop, quantity, capture timestamp, source,
episode identity and fixed evaluation version. Plan/ledger revisions are all
retained; earliest-first, non-overlapping 20-session windows per market/account/
symbol supply the descriptive aggregate. Do not imply statistical independence.

Daily OHLC cannot know the intraday path following a suggestion. Predeclare
next regular-session open after its market-local capture date as the common
starting mark for stop and unchanged-holding arms. Evaluate exact market-calendar
sessions at h2/5/10/20 only after all required closes mature; missing, malformed,
duplicate or unsupported-calendar data is unavailable, not a zero outcome.
Stop-market simulation sells at the worse of the daily open and frozen stop,
less an explicitly disclosed 10-basis-point incremental sell-cost assumption.
Report gross and modeled-net differences separately; costs are illustrative,
not observed broker fees. Sale proceeds remain cash, with no reinvestment or
interest. Never call this portfolio attribution or actual realized P/L.

Store stop and hold returns, delta, loss avoided/upside sacrificed, maximum
drawdown estimates, stop-touch date, sample/data coverage and monetary delta only
when frozen quantity is known. Aggregate each horizon separately: mean/median,
notional-weighted delta, counts and coverage; never sum overlapping horizons.
Confirmed response requires a linked Guardian plan/proposal and an unambiguous,
same-account/market/symbol SELL broker fill after suggestion. Arming, submission,
holdings changes or stop touches alone are not proof. Partial fills stay partial;
unlinked exits stay unknown. Confirmed exit proceeds are not lot-level realized
profit or proof the recommendation caused the sale.

One shared display inside both existing Recommendations & Guardian scorecards.
Show exact-stop metrics separately from generic buy-idea rule experiments.
India remains empty until actual app suggestions exist; do not fabricate a stop
from existing Kite GTTs or enable India's unbuilt execution workflow. US legacy
snapshot-derived P/L/response labels must say inferred/unrealized, not actual
realized/followed evidence. Owner-only APIs, no-store responses, service-only
append-only evidence, existing read-only source permissions. Tests must reject
gap-at-stop optimism, intraday lookahead, missing sessions, duplicate/revised
episode inflation, unmatched/partial fills, mixed currencies and fake zeroes.

Implementation detail: the existing raw Yahoo replay reader is reused only by
the nightly producer for versioned suggestions; chart cache rows with mixed
adjustment bases are not used. No raw-history call occurs before a horizon
matures. Daily symbol fetches are bounded to 20/market in three-request batches,
oldest-attempt first, with a 45-second shared and 22-second per-market allowance
reserving time for database writes; deferred coverage surfaces in health. First matured outcomes retain their complete price window
and are reused rather than restated. Known split/dividend/action windows from
both the existing corporate-action ledger and price provider are unavailable
until share/cash treatment is verified: persist `excluded_corporate_action`,
not a zero return or a failing producer, and do not repeatedly fetch a completed
excluded window. Source failures and genuinely missing matured bars still raise
health alerts. Stop-formula lineage not supplied by
the source is explicitly `unrecorded`; evaluation lineage is v1, not a claimed
new stop formula. Historical dates/levels are not retrospectively frozen.

## Status
**IMPLEMENTED 2026-10-14** (owner: "go with recommendations", i.e. the recommended defaults below). Measure-only and display-only: it never places, arms or cancels an order, never changes a stop, and never activates the Guardian.

Decisions taken: (1) all six Robinhood accounts, read-only; (2) the buy ideas count as recommendations; (3) history backfilled; (4) daily revision is a written note plus shadow stop arms, no auto-change; (5) stuck `pending_review` proposals were closed out on 2026-10-14 by a 5-minute sweeper (migration 20261014171102) after the owner asked; the tracker reads `expired` as no decision.
Deviations from the draft: response state lives on the daily mark row (2 recommendation tables instead of 3, plus `live_guardian_revisions`); `risk_review` recommendations are not recorded (224 distinct account/symbol/reason keys in the snapshots, noise rather than advice); the stop-rule shadow runs on matured buy ideas at their proposal price because only one Guardian stop has ever been suggested.
Files: migration 20261014162931, `lib/live-recommendations/core.ts`, `app/api/agents/live-recommendations/route.ts`, `app/api/live-portfolio/recommendations/route.ts`, `components/dashboard/RecommendationsPanel.tsx`, tests `live-recommendations-core` and `live-recommendations-wiring`.

The stored live-recommendation ledger above remains US/Robinhood-specific. On
2026-10-19, the India Live Portfolio received a separate read-only scorecard
that uses India `decision_observations` and matured `observation_labels` against
the NIFTY 50. It deliberately does not read US recommendation rows or infer
India buy-response history from current holdings. See
`features/india-live-guardian-scorecard/FEATURE_ARCHITECTURE.md` for its data
contract, limitations, and separate future work for a persistent India
recommendation/response ledger.

## What the owner asked for (2026-10-14)
On the Live Portfolio page, show ALL recommendations; record whether each was taken or not; track how each fared against its symbol; revise the Guardian daily from that evidence; count how many times the Guardian alerted, the price to sell at, and current P/L depending on what was done.

## What exists today (verified in production)
| Source | What it holds | Row count |
|---|---|---|
| `trade_proposals` | BUY ideas for the live account, each with `price_at_proposal`, thesis, risk check | 148 (147 `pending_review`, 1 filled), 28 symbols, 61 days |
| `agentic_position_ledger` | detected position changes in account 605420660, with `suggested_stop_price` | 2 rows (one IBIT manual buy, stop suggestion $33.60) |
| `guardian_protection_plans` / `_events` | Stage 1 arm-a-stop plans and their immutable events | 0 / 0 (no plan was ever created) |
| `live_exit_ladder_shadow` | would-sell signals for live holdings | 28 rows, last 2026-09-16 |
| `holding_risk_snapshots` | daily per-holding risk posture (hold / review) with reasons, all 6 Robinhood accounts | 3,289 rows since 2026-07-12 |

Findings that shape the design:
1. **The recommendation stream is the 147 BUY ideas, not the Guardian.** The Guardian has alerted once in its life. All 147 proposals sit in `pending_review` with an approval window of 30 minutes (every one is past expiry but was never marked expired), so in practice they were never actionable and never closed out.
2. **Hypothetical outcome of those 147 ideas** (bought at `price_at_proposal`, closes from `price_cache`): +0.14% average at 5 sessions vs SPY +0.47% (131 with data, 50% positive); +1.03% at 10 sessions vs SPY +0.95% (117 with data, 47% positive). No evidence yet that the ideas beat the market.
3. **Taken / not taken must be inferred.** Only the agentic account is watched intraday. The other accounts have daily holdings snapshots, so a buy shows up as a quantity increase the next day, a sell as a decrease.

## Design

### A. Recommendation ledger (append-only): `live_recommendations`
One row per recommendation, deduplicated by `dedup_key`.
- `kind`: `buy_idea` (from `trade_proposals`), `guardian_stop` (from `agentic_position_ledger.suggested_stop_price` / plans), `exit_signal` (from `live_exit_ladder_shadow` non-hold actions), `risk_review` (from `holding_risk_snapshots` when posture changes to `review`, once per position per reason, not daily).
- `account_id`, `symbol`, `issued_at`, `reference_price` (price at issue), `level_price` (stop / sell price when applicable), `qty_suggested`, `horizon_sessions` (default 10, the system's horizon), `source_table`, `source_id`, `rationale` snapshot.
- One-time backfill from the sources above, then incremental sync nightly.

### B. Response detection (append-only events): `live_recommendation_responses`
Per recommendation, a status with evidence, re-evaluated nightly until the horizon passes:
`pending` (window open) -> `taken` / `partly_taken` (matching quantity increase within the window, with the account, quantity and next-snapshot price) / `not_taken` (window closed, no matching change) / `expired_unanswered` (the 30-minute approval window passed with no decision, the current state of all 147). For sells and stops: `followed` (position reduced near the level) / `ignored`.
Evidence comes from `agentic_position_ledger` (agentic account, intraday) and day-over-day deltas in `holding_risk_snapshots` (all accounts), plus `trade_proposals.status`/fill fields when a proposal is approved. Daily-snapshot inference cannot see intraday round trips; the page says so.

### C. Outcome marks (append-only, one row per recommendation per session): `live_recommendation_marks`
- `symbol_return_pct` since issue (close vs reference), `benchmark_return_pct` (SPY), `excess_pct`.
- If taken: actual P/L from the account's average cost vs current price. If not taken: the hypothetical P/L at reference. Both are labelled, never blended.
- For stops and sell levels: `level_touched` (did the session low or close reach the level), date first touched, P/L if sold at the level vs holding now ("what following it did").
- Hypothetical fills ignore slippage and liquidity; the page says so.

### D. Guardian scorecard and daily revision (shadow, never auto-applied)
Daily job computes, over matured stop suggestions: alerts issued, stops touched, **saved** (touched and price kept falling by at least X) vs **premature** (touched then recovered above entry within the horizon), and expected P/L by stop rule. It evaluates alternative stop rules as shadow arms on the SAME suggestions (current mandate stop 7% below cost; volatility-scaled 2.8 ATR, the rule the paper side already shadows; a wider fixed stop) and publishes a plain-language daily note: "Over N matured suggestions, rule A would have saved $X and cost $Y in premature exits vs the current rule." Any change to the live Guardian stop rule is a separate proposal for owner approval; it is a safety rule and is never changed by this job.
With one Guardian alert so far the scorecard will say 'insufficient evidence' for months; the daily-revision value comes from the buy-idea and exit-signal streams, and from applying the same stop arms to every live holding as a counterfactual.

### E. Display: new "Recommendations & Guardian" section on the Live Portfolio page (viewer-safe stored rows)
1. KPI strip: recommendations issued (30 / 90 days), taken, not taken, expired unanswered; average excess return vs SPY for taken vs not taken; Guardian alerts issued and stops touched.
2. Timeline table, newest first, sortable on every column (reuse the Trades-tab sorting helper): date, symbol, kind, reference price, level, your response, P/L now (actual or hypothetical, clearly tagged), symbol return, SPY return, excess, status.
3. Guardian card: alert count, each stop with distance from current price, touched or not, "if followed" P/L, current P/L based on what you did.
4. Daily revision note and the shadow-arm comparison with its sample size.
5. Mobile-first: cards under 640px, table above; filters All / Taken / Not taken / Expired.

## Non-goals and safety
- No order, arm, cancel or stop change anywhere. The Guardian's own gates (flags, allowlist, market controls) are untouched.
- No change to proposal generation, expiry behavior or the approval window (a separate decision: 30 minutes may simply be too short to act on).
- Aggregates are stored rows only; no model or broker call from the page.

## Cost / size
New: 3 append-only tables (RLS on, no client grants), one nightly job (`kairos-live-recommendations`), 1 viewer-safe read route, 1 page section, tests. No LLM calls. Estimated 6-8 files plus docs.

## Decisions needed
1. **Accounts in scope:** all six Robinhood accounts read-only (recommended; the buy ideas apply to the book as a whole) or only the agentic account 605420660?
2. **Treat the 147 BUY ideas as recommendations** (recommended) or only Guardian/exit alerts?
3. **Backfill** the 147 historical ideas and the one IBIT suggestion (recommended) or start from today?
4. **Daily revision:** shadow arms plus a written note only (recommended; no auto-change), confirm.
5. Should the stuck `pending_review` proposals be closed out as `expired` in the source table? (Changes `trade_proposals` data; separate approval.)
