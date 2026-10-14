# Feature Architecture: Live Recommendation Tracker and Guardian Scorecard (PROPOSAL)

## Status
**DRAFT proposal, 2026-10-14. Not implemented. Needs explicit approval ("Approved, implement" plus answers to the decisions below).**
Measure-only and display-only: it never places, arms or cancels an order, never changes a stop, and never activates the Guardian.

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
