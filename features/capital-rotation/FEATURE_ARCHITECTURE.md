# Feature Architecture - Capital Rotation

> Status: **P0 SHADOW BUILT 2026-07-13.** Paper/live execution remains disabled and unbuilt.
> Scope: deterministic opportunity-cost reallocation for PAPER first, LIVE approval proposals later.
> Last updated: 2026-07-13
> Update when built: `docs/arch/03-agents.md`, `docs/arch/04-database-schema.md`, `docs/arch/08-risk-and-safety.md`, `docs/arch/09-learning-loop.md`, `public/agent-diagrams/system-map.json`.

## One-line decision

Build capital rotation as a **deterministic evaluator inside the existing entry flows**, not as a new autonomous reallocation agent. It may only propose or execute a rotation after the candidate has passed every normal entry gate except cash. PositionMonitor still owns exits. Live rotation is approval-required and two-leg reconciled.

## Problem

When a market-local book is fully invested and a materially better candidate appears, the current paper/live flows skip the buy with `insufficient_cash`. Existing exits are absolute risk or thesis exits: score-below-exit, stop, target, time-stop, and partial-profit. The missing behavior is opportunity-cost reallocation: sell the weakest still-held, still-valid position only when the new candidate is materially better after cost, tax, turnover, and safety gates.

## Non-negotiable rules

1. **No LLM on the money path.** LLM output may explain a signal upstream, but rotation selection, thresholds, tax/cost math, and execution decisions are deterministic.
2. **Per-market and per-currency only.** US/USD and India/INR books are separate. No cross-market cash, NAV, alpha, turnover, or holdings aggregation.
3. **Existing gates remain authoritative.** Rotation cannot bypass owner auth, app pause, per-market pause, kill switch, drawdown breaker, market controls, account allowlists, live autonomy level, approval-required live mode, name/sector/gross caps, quality gates, correlation gates, volatility gates, re-entry cooldown, or position-count caps.
4. **PositionMonitor exits win.** If a holding would exit today for stop, target, time-stop, score-below-exit, direction flip, thesis break, or partial-profit workflow, rotation must not treat that holding as a discretionary funding source.
5. **Paper execution must be atomic.** A paper rotation is one transaction-like sell-and-buy operation. The system must not sell W and then leave the book idle because the buy failed.
6. **Live execution is two-leg and reconciled.** The live path creates an approval-required rotation proposal. The sell leg must confirm before the buy leg is allowed. Partial fills or unknown status stop the workflow in `needs_reconcile`; no automatic buy follows.
7. **Default off.** Shadow measurement is first. Paper auto-rotation and live proposals have separate flags and are both false by default.

## Prioritized design issues found and required fixes

### P0 - Sell-then-buy can create unintended de-risking

**Failure scenario:** PaperTrader sells the weakest holding, then the candidate buy fails because price moved, cap checks changed, the fill RPC rejects, or the daily notional cap is exhausted. The portfolio is now unintentionally in cash even though the rotation did not complete.

**Fix:** P1 paper execution must be a single atomic operation, preferably a Supabase RPC that validates the same snapshot, inserts both trade legs, updates/deletes the sold position, inserts the new position, adjusts `paper_portfolio.cash`, writes `rotation_events`, and aborts all writes on any failed invariant. If the existing paper fill RPC cannot support this, add a dedicated `execute_paper_rotation` RPC before enabling paper auto-rotation.

### P0 - Live rotation cannot be a one-click opaque sell-and-buy

**Failure scenario:** The app submits a live sell, assumes proceeds are available, then submits a buy while the sell is partially filled, rejected, delayed, or in unknown status. This can overspend, bypass budget truth, or buy before the account is reconciled.

**Fix:** Live rotation emits a `trade_proposals` rotation record with explicit sell and buy legs, `approval_required`, market/account/currency, idempotency key, and full reason JSON. Approval submits only the sell leg through the canonical execution gateway. The buy leg is eligible only after broker-confirmed sell fill and refreshed account/budget data. Any partial fill, unknown state, broker error, or stale account snapshot moves the proposal to `needs_reconcile` and blocks the buy.

### P0 - Rotation can fight PositionMonitor

**Failure scenario:** A holding is near a stop or has a score-below-exit signal today, but rotation sells it as "weakest" and records the action as an opportunity-cost rotation. That hides the true exit reason and corrupts learning labels.

**Fix:** Rotation source eligibility must run after PositionMonitor predicates or reuse a shared deterministic `evaluateExitEligibility` helper. Holdings with any current exit, partial-profit, near-stop, near-target, stale quote, stale score, or pending order state are excluded. If a holding has an exit reason, PositionMonitor owns the exit and the learning label.

### P0 - Entry gates must be replayed after the hypothetical swap

**Failure scenario:** Candidate C passed standalone checks before the sell, but after replacing W with C the book breaches sector exposure, symbol/name cap, gross exposure, correlation, volatility, max positions, or daily notional limits.

**Fix:** The evaluator must apply a hypothetical portfolio state: remove W, add C at proposed size, then run the same portfolio-construction gates used by paper/live entry. Rotation is allowed only if the post-rotation book passes every gate.

### P1 - Score-only edge is too noisy for auto-rotation

**Failure scenario:** A one-day score fluctuation makes C beat W by the margin, causing a buy-then-rotate-out whipsaw. This is the same risk class as a phantom weekly drawdown cascade, but now it sells holdings.

**Fix:** Paper auto-rotation requires persistence: C must beat W by the configured margin in at least two consecutive eligible research runs, or the latest run plus a prior run inside a configured freshness window. Shadow mode may log single-run opportunities, but auto paper cannot act on them. Live proposals require persistence and confidence-qualified benchmark-alpha data when the alpha term is enabled.

### P1 - Cost/tax hurdle is underspecified

**Failure scenario:** `edge_value` is not mapped to dollars/rupees, so a taxable gain or spread/slippage cost can be smaller than a score gap but larger than the actual expected economic benefit.

**Fix:** Define expected value deterministically:

```text
expected_edge_value =
  target_notional *
  clamp(expected_excess_return_C - expected_excess_return_W, -cap, cap) *
  confidence_discount
```

Costs subtract estimated sell spread, buy spread, commissions/fees if any, market-impact/slippage buffer, and tax drag. For paper, tax drag is modeled and logged. For live, tax drag must use lot-level cost basis when available. If cost basis or holding period is unavailable and `tax_sensitivity` is medium/high, fail closed.

### P1 - Turnover budget needs a ledger definition

**Failure scenario:** The system treats only the sell notional as turnover in one place and sell+buy in another, allowing more churn than the mandate intended.

**Fix:** Define rotation turnover as `sell_notional + buy_notional`, measured against same-market book NAV for the current calendar month. Budget consumption is checked before execution and logged to `rotation_events`. If `investment_mandates.turnover_budget_monthly` is null, rotation budget is zero unless an explicit rotation override exists.

### P1 - Benchmark-alpha dependency can silently degrade

**Failure scenario:** Benchmark-alpha is unavailable, so rotation falls back to score-only without changing risk level. Live proposals then optimize on a weaker edge measure than expected.

**Fix:** P0/P1 shadow may write `alpha_status = unavailable` and use score-only as measurement. Paper auto-rotation may run score-only only if `rotation_allow_score_only_paper = true` and the edge margin is widened. Live rotation proposals cannot use score-only fallback; they require confidence-qualified primary-benchmark alpha or remain blocked.

### P1 - Correlation and duplicate exposure need post-swap evaluation

**Failure scenario:** W is sold and C is bought, but C is highly correlated with another retained holding, creating self-competition and no real portfolio improvement.

**Fix:** Correlation checks must compare C against the whole post-swap portfolio, not only W. Reject same issuer, duplicate ETF exposure, blocked symbols, leveraged/inverse products, and high-correlation substitutes unless an explicit allowlist exists.

### P2 - Audit trail needs lifecycle and idempotency

**Failure scenario:** A rotation decision is logged after execution with a partial reason. A retry or cron duplicate creates duplicate sell attempts or impossible-to-reconstruct learning labels.

**Fix:** `rotation_events` is append-only and lifecycle-based: `evaluated`, `rejected`, `planned`, `paper_executed`, `live_sell_submitted`, `live_sell_confirmed`, `live_buy_submitted`, `completed`, `aborted`, `needs_reconcile`. Every row includes idempotency key, market, currency, book/account, candidate, source holding, scores, alpha inputs/status, cost/tax model, turnover budget, gate outcomes, snapshot timestamps, and actor.

## Target architecture

### Components

`CapitalRotationEvaluator` lives in `lib/trading/capital-rotation.ts` and is pure/deterministic. It returns a plan, not side effects.

```ts
type RotationDecision =
  | { action: 'reject'; reason: string; audit: RotationAudit }
  | { action: 'shadow'; plan: RotationPlan; audit: RotationAudit }
  | { action: 'paper_execute'; plan: RotationPlan; audit: RotationAudit }
  | { action: 'live_propose'; plan: RotationPlan; audit: RotationAudit };
```

Call sites:

- `app/api/agents/paper-trade/route.ts`: after C has passed every normal entry gate except cash, call evaluator at the `insufficient_cash` branch.
- `app/api/agents/trader/route.ts`: proposal generation only. It may produce a rotation proposal, never submit an order directly.
- PositionMonitor is not a call site for discretionary rotation. It owns exits and may expose reusable exit predicates.

### Evaluator inputs

- Market-local candidate signal C: symbol, market, currency, score, direction, confidence, horizon, expected alpha if available, quote, target notional.
- Market-local open positions with fresh quote, fresh score, stop/target state, holding age, lot/cost basis if available, pending order state.
- Same-market book state: cash, NAV, exposure by name/sector, position count, monthly turnover used, daily notional used.
- Mandate/config: `turnover_budget_monthly`, `min_holding_days`, `max_holding_days`, `tax_sensitivity`, `max_position_pct`, score threshold, exit threshold, rotation flags.
- Safety state: app pause, market controls, kill switch, drawdown breaker, live autonomy mode, account allowlist, approval-required state.
- Benchmark-alpha state: primary benchmark excess return, confidence, status, window metadata.

### Source holding eligibility

A holding W is sellable only if all are true:

- Same `market` and `currency` as candidate C.
- Still held, no pending order, no stale quote/score, no account/book mismatch.
- Not below exit threshold, not direction-flipped, not stop/target/time-stop/partial-profit eligible today.
- Not near stop or near target inside configured buffers.
- Holding age is at least `min_holding_days`.
- Selling W would not violate tax/cost guardrails.
- Selling W plus buying C improves the post-swap portfolio after all gates replay.

### Decision rule

Rotation is allowed only if all are true:

1. C is eligible and blocked only by cash.
2. W is the weakest sellable holding by fresh deterministic score, with alpha tie-break when available.
3. `score(C) - score(W) >= rotation_margin`.
4. Edge persists across the configured run count/window.
5. Expected edge value after confidence discount is positive after all costs and tax drag.
6. Monthly turnover budget remains available after `sell_notional + buy_notional`.
7. Post-swap book passes every entry and portfolio gate.
8. C is not a duplicate/correlated substitute for retained holdings.
9. Per-run and per-day rotation caps are not exhausted.
10. The feature flag for the current phase/action is enabled.

## Data model

### `rotation_events`

Append-only audit ledger. No UPDATE or DELETE except service migration repair.

Required columns:

- `id`, `created_at`, `owner_user_id`
- `market`, `currency`, `book_type` (`paper` or `live`), `account_id` nullable for paper
- `idempotency_key` unique per candidate/run/book
- `status`
- `candidate_symbol`, `source_symbol`
- `candidate_signal_id`, `source_position_id`
- `candidate_score`, `source_score`, `score_edge`
- `benchmark_id`, `alpha_status`, `candidate_alpha`, `source_alpha`, `alpha_edge`
- `sell_notional`, `buy_notional`, `turnover_consumed`
- `cost_model_json`, `tax_model_json`, `gate_results_json`, `audit_json`
- `trade_proposal_id` nullable, `paper_trade_ids` nullable

RLS: owner read only; service role writes. Public, anon, and authenticated direct writes revoked.

### Config

Prefer a small `rotation_config` table keyed by owner/market/book type, or explicit `strategy_config` columns if the codebase already centralizes strategy flags there. Required flags:

- `rotation_shadow_enabled` default true for measurement only once built.
- `rotation_paper_execute_enabled` default false.
- `rotation_live_proposals_enabled` default false.
- `rotation_allow_score_only_paper` default false.
- `rotation_margin_score`, `rotation_persistence_runs`, `rotation_cooldown_days`, `max_rotations_per_run`, `max_rotations_per_day`.

Implementation must not overload global `trading_enabled`; rotation has its own flags in addition to all existing money-path flags.

## Phasing

### P0 - Shadow-only measurement

Built 2026-07-13. The evaluator and append-only audit rows are implemented. On `insufficient_cash`, PaperTrader records whether a rotation would have been eligible and why. No sell, no buy, no proposal. This validates frequency, churn pressure, score persistence, priceability, and missing tax/lot data.

**P0 readiness completion (2026-07-22):** New shadow rows reuse the
canonical paper exit-plan projection so a holding already due for a time,
score, stop, or target exit cannot be mislabeled as a rotation source. They
also record distinct-run persistence, current-month paper turnover, mandate
budget/tax sensitivity, the existing 5 bps-per-leg paper slippage floor,
post-swap constructor replay, and measured candidate-to-remaining-book
correlation from frozen `symbol_daily_returns`. Missing or truncated evidence
fails closed and is recorded in `p1_blockers`; no value is guessed as zero.
Agents -> Rotation exposes these blockers per market. This is measurement and
visibility only: it does not grant P1 permission.

### P1 - Paper auto-rotation, still default off

After P0 evidence is reviewed, enable market-by-market paper execution only. Requires atomic paper RPC, persistence, post-swap gate replay, turnover budget, cost/tax model, and complete audit rows.

**Current enforcement (2026-07-22):** P1 is not approved. A production audit
found the US paper flag enabled while several required gates above were still
absent. It was reset to false, and migration `20260722185000` adds a database
constraint that prevents either market from enabling paper rotation. The old
money-moving RPC is replaced by a claim-verifying stub that always returns
`p1_guardrails_incomplete` and performs no ledger mutation. P0 shadow
measurement is the only reachable phase until a later migration removes that
constraint and introduces a fully reviewed P1 transaction.

**Containment correction (2026-08-10):** Migration `20260723120000` later
removed that containment and enabled both paper rows, but the caller only
rechecked score spread, persistence, cooldown and count caps. It did not enforce
the P1 readiness result and did not read `rotation_allow_score_only_paper`.
Four paper rotations executed; their small realized cohort was negative in both
markets. Migration `20260811033335` disables paper execution again, and the
caller now refuses score-only execution when the default-false flag is not
explicitly enabled. P0 measurement remains active. This is containment, not a
claim that the four-trade result proves rotation lacks edge.

### P2 - Live approval proposals

After P1 shows low churn and net-positive behavior, add live proposal generation. Owner approval is required. Sell and buy legs are reconciled separately through the canonical gateway. No autonomous live rotation in this phase.

### P3 - Optional owner-approved automation

Out of scope for this architecture. Would need a separate architecture review, broker canary evidence, live reconciliation evidence, and explicit owner approval.

## What is sound in the original design

- The core product idea is useful: fully invested books need an opportunity-cost path, otherwise the system holds mediocre but not-yet-exit positions while better candidates are skipped.
- Keeping rotation deterministic and per-market is correct.
- Using mandate fields such as turnover budget, min holding days, tax sensitivity, and max position percent is the right fit.
- Putting live behind approval-required proposals is correct.
- Using benchmark-alpha as an edge tie-break is appropriate once benchmark-alpha has confidence-qualified data.

## Recommended build order

1. [Done] Add P0 shadow evaluator and `rotation_events` audit table.
2. [Done] Reuse the canonical paper exit-plan projection so rotation cannot relabel true exits.
3. [Done for P0 measurement] Replay the post-swap paper constructor and measured candidate correlation; live remains out of scope.
4. [Done for P0 measurement] Add persistence, turnover, friction, tax-evidence, and truncation tests.
5. [Blocked] Validate a score-to-forward-return mapping, configure an owner-approved turnover budget, and collect independent-session evidence before designing a new atomic P1 RPC.
6. [Done] Add owner-visible market-local rotation readiness reporting.
7. Add live proposal generation only after P1 paper evidence is reviewed.

## Single riskiest assumption to validate first

The riskiest assumption is that the current deterministic score plus benchmark-alpha has enough signal stability to justify selling a still-valid holding. Validate this in P0 shadow mode before allowing any paper or live rotation.

## Explicit non-goals

- No autonomous live sell-to-buy workflow.
- No rotation across US and India.
- No score-only live fallback.
- No new standalone reallocation agent that initiates orders independently.
- No LLM override or LLM-generated tax/cost/edge math.
- No implementation code until this architecture is approved.
