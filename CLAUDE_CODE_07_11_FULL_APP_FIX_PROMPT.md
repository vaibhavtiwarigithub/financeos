# Claude Code implementation prompt — FinanceOS full-review remediation

Repo: `C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`

You are the senior builder for a live-money trading system. Read, in order:

1. `AGENTS.md`
2. `WORK_LOG.md`
3. `PRD.md`
4. `knowledge/KNOWLEDGE_INDEX.md`
5. `07_08_FULL_APP_REVIEW.md`
6. The production files and migrations cited by each finding

The review is based on current commit `cbf8617` and live read-only Supabase evidence from 2026-07-11. Do not assume every finding is correct: reproduce each one from code/schema first. If a claim is false, document exact counter-evidence and do not make a speculative change.

## Hard safety rules

- Claim the task in `WORK_LOG.md` before editing.
- Do not place, preview, cancel, or modify a real broker order while fixing/testing.
- Do not enable `AUTONOMOUS_LIVE_ENABLED`, `live_auto_enabled`, or any autonomous market mode.
- Do not enable live trading. The owner must make live-state changes explicitly.
- All schema changes are new additive migrations. Never edit an applied migration.
- Never delete or rewrite append-only ledgers. Corrections are new events/projections.
- LLMs may propose hypotheses/explanations, but may not control money limits, accounts, promotion, kill switches, code, numeric production weights, or order submission.
- New positions remain long-only. Risk-reducing SELLs require fresh exact-account held quantity.
- Preserve manual-live request behavior unless a safety defect requires failing closed.
- No hardcoded secret/account token. Robinhood trading account remains `605420660`; `965848641` is read-only.
- Inspect the dirty worktree first and preserve unrelated user/Codex changes.

## Required implementation order

### Phase A — immediate P0 safety and accounting

#### A1. Explicit paper/live kill-switch context

Files: `lib/kill-switches.ts`, every caller including paper-trade, trader, `lib/trading/execute-order.ts`, autonomous-live, and Kite.

- Replace mode inference from `live_auto_enabled` with an explicit typed argument:
  `checkKillSwitches(svc, { market, book: "paper" | "live", accountId?: string })`.
- Paper callers pass `book:"paper"`.
- Any live order caller must pass `book:"live"` and the already resolved exact account.
- Live checks require positive, currency-correct, recent account snapshots. Define/document freshness and test it.
- Do not compare live account equity with static `START_NAV`. Introduce an immutable owner-approved/per-account baseline or derive a conservative verified baseline from that account's first snapshot. If baseline is unavailable, fail closed for BUY.
- Separate “risk increase allowed” from “risk reduction allowed.” A tripped drawdown/daily-loss/accuracy switch blocks BUY/new exposure. It must not block a SELL that has passed fresh exact-account held-quantity verification. `security_locked` may still block everything.
- Ensure a kill switch disables only the affected market, not unrelated markets, unless a separate global emergency lock is used.

Acceptance tests:

- L3 manual live with `live_auto_enabled=false` queries live data, never paper data.
- Paper trade always queries paper data.
- Stale/missing live snapshot blocks BUY.
- A $36.56 account is not measured against a $10,000 static peak.
- Tripped switch blocks BUY but allows a verified held-only SELL; over-sell and holdings lookup failure still block.

#### A2. One canonical Kite execution path with account identity

Files: `app/api/kite/order/route.ts`, `lib/trading/execute-order.ts`, Kite adapter/client, account resolver.

- Make the Kite route an owner/CSRF-gated facade over the canonical proposal and `executeApprovedOrder()` service.
- Remove its direct budget-v1 and broker-submit implementation.
- Resolve `active_account_india`; require an allowlisted `(broker='kite', market='india', account_number, role='trading')` row.
- Fetch Kite profile/user identity read-only and compare it to configured account before any reservation.
- Preserve confirmation UX and manual override audit behavior through canonical input fields.

Acceptance tests: null account, wrong profile, absent allowlist, expired token, correct identity, BUY, held SELL, ambiguous broker response, duplicate click.

#### A3. Durable broker acknowledgment

File: `lib/trading/execute-order.ts`.

- After broker success, append a durable broker acknowledgment event containing broker order ID/raw status before returning normal success.
- Check event and projection update errors.
- Boundedly retry only the database persistence, never broker submission.
- If persistence still fails, return 202 with `needs_reconcile=true`, emit a CRITICAL alert containing the known broker ID/order row, and leave a recoverable reconciliation record. Never return `{ok:true}`.
- Apply equivalent semantics to Robinhood and Kite adapters.

Acceptance test: injected DB failures after broker ACK never submit twice and never return normal success.

#### A4. Repair PositionMonitor accounting

File: `app/api/agents/position-monitor/route.ts`; optional new migration.

- Confirm deployed `paper_portfolio` has no `open_positions` column.
- Prefer removing that field from the update unless a real consumer requires it; otherwise add it via a new migration before code ships.
- Check the portfolio update and `paper_performance` write errors. On failure, mark `agent_runs` failed and create a health alert.
- Add deterministic invariant check per market/currency:
  `NAV = cash_balance + sum(open qty * current_price)` within currency rounding.
- Provide a read-only reconciliation script/report for existing inconsistent rows. Do not mutate live DB during verification and do not delete ledgers. Any eventual correction must be owner-approved and recorded as a corrective event.
- Correct structured exit reasons so a direction flip is not rendered as `68 < 37`.

Acceptance tests: clean DB entry/exit/partial exit/two markets; invariant; missing-column simulation; direction-flip explanation.

#### A5. New migration: RPC/grant/session fixes

- Revoke `reserve_live_order_budget(...)` EXECUTE from PUBLIC, anon, authenticated. After A2, retire service-role use of v1 too if nothing calls it.
- Keep v2 service-role/postgres only.
- Make v2 session date market-local (`America/New_York`, `Asia/Kolkata`), with a lock key that includes market, broker/account where appropriate, and local session date.
- Validate allowed market/currency pair, positive finite qty/notional, actor enum, live BUY cap inputs, and proposal identity.
- Decide/document exactly which terminal statuses release budget and ensure ambiguous/partial states continue to reserve.

Acceptance: `information_schema.routine_privileges` shows no public/anon/auth v1/v2 execution; concurrent and timezone-boundary integration tests pass.

Stop after Phase A and run all gates. Do not proceed if any P0 acceptance test fails.

### Phase B — governance, auth, and data integrity

#### B1. Immutable, atomic strategy lifecycle

- Owner-gate strategy GET.
- Do not keep two-step demote/promote updates.
- Design an additive lifecycle-event/champion-pointer migration and atomic RPC, locked per market.
- RPC verifies target exists, market matches, validation passed, caller path is owner-gated/service role, appends lifecycle event, and swaps pointer in one transaction.
- A failure leaves the old champion active.
- Maintain compatibility views/readers without deleting historical versions.

#### B2. Rank publish state

- When rank is enabled, do not write an actionable `pending` signal before rank completes.
- Add/use a non-actionable scored state, then atomically publish/reject exact signal IDs for that run and market.
- Rank persistence failure is fail-closed for new entries; holdings exits remain available.
- Reject/disable unscoped mixed-market production runs.

#### B3. Immutable PIT fundamentals

- Remove `is_latest` updates; latest is a derived view/query.
- Use an atomic idempotent capture RPC/lock.
- Store authoritative filing/provider-published time when actually supplied; otherwise `known_at=captured_at` and never pretend the fact existed earlier.
- Add immutable trigger and explicit RPC/view grants/security mode.

#### B4. Route authorization and quota protection

- Inventory every `app/api/**/route.ts`.
- Owner-gate proprietary/dashboard GETs.
- Owner-or-cron gate refresh/write routes, especially `alerts/stale-check` and chart cache refresh.
- Split GET cached read from POST refresh where needed.
- Validate symbol regex, date bounds, max rows/pages; route all providers through shared budget/cache/provenance.
- Add an automated auth matrix test proving an anonymous request causes zero provider and zero service-role writes.

#### B5. Supabase linter remediation

- Fix `v_decision_quality` and `provider_budget_7d` with `security_invoker=true` or revoke browser roles/use internal schema.
- Fixed safe `search_path` and schema-qualified objects for definer functions.
- Explicit default privileges so new public functions/tables are not auto-executable/readable by anon/auth.
- Do not add permissive policies merely to silence “RLS enabled no policy” on service-only tables.

### Phase C — recommendation and learning integrity (no trading impact)

Do not activate these changes in paper/live until prospective validation passes.

#### C1. Learning readiness dashboard/contract

- Surface per-market counts for observations, matured labels by horizon, shadow decisions, replay packets/runs, artifacts, closed paper trades, manual-live outcomes, and blockers.
- Empty evidence must display “insufficient evidence,” not a score or self-improvement claim.

#### C2. Disable Pearson as a production optimizer

- Keep `query_score_correlation` diagnostic-only.
- `update_signal_weight` may at most create a hypothesis/measure-only experiment; it may not create a promotable challenger from Pearson evidence.
- Build/spec a deterministic regularized optimizer over a small typed genome using purged/embargoed nested walk-forward, market/setup/horizon cohorts, costs, stability, and multiple-testing protection.
- LLM proposes features/hypotheses and explains results only.

#### C3. Better universe/discovery, shadow first

- Implement only from an approved architecture update.
- Broad PIT liquid universes per market; explicit price/traded-value/spread/size filters.
- Cheap cross-sectional stage: 6–12m ex-1m relative strength, 1/3m acceleration, 20/50/200 trend, volume/traded-value, volatility, gap/ATR, distance from high, sector relative strength; add earnings revisions/surprises only from licensed PIT data.
- Route candidates to setup-specific models; at most three finalists/day receive expensive deep research.
- Fragility veto for extreme gaps, high-volume bearish reversal, sparse/low-liquidity names, and social/crowding spikes. Validate thresholds by market/liquidity bucket.
- Produce an event-study report for MU, INTC, SNDK and negative controls/meme reversals showing first detection, 5/10/20-day net return, MAE/MFE, turnover, false positives. Do not cherry-pick these three as training proof.

## Required verification gates

Run and record raw output:

```powershell
npx tsc --noEmit
npm test -- --run
npm run build
```

Also run:

- clean-DB migration replay in a disposable/local Supabase environment;
- DB integration tests for RPC grants, concurrency, session dates, promotion atomicity, immutable triggers;
- failure-injection tests for broker-accepted/DB-failed and provider/quote/snapshot failures;
- authenticated localhost smoke test for Dashboard, Paper Portfolio, Live Portfolio, Risk, Strategies, Agents, Settings, India;
- verify no real broker write occurred.

The current known type failures are in `tests/pit-fundamentals.test.ts:39` and `tests/technicals-scoring.test.ts:5`. Fix the fixtures/types without weakening production contracts.

## Required artifacts

Create/update:

1. `07_11_CLAUDE_FULL_APP_FIX_LOG.md`
   - One row per review finding: accepted/rejected/deferred.
   - Exact evidence, files/migrations, tests, remaining risk.
2. `07_11_P0_ACCEPTANCE_EVIDENCE.md`
   - Raw test/build outputs and DB privilege/schema assertions.
3. Relevant architecture docs only where implementation changed.
4. `WORK_LOG.md` status when complete.

Commit in small phases. Do not claim “fixed” because code exists; claim it only after the acceptance test passes. Do not enable live or autonomous trading at the end. Return the commit hashes and the two evidence-file paths for a new Codex adversarial review.
