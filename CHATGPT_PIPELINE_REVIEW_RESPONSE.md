# ChatGPT Pipeline Review Response — 2026-07-07

Scope reviewed: `AGENTS.md`, `WORK_LOG.md`, `PRD.md`, `ARCHITECTURE.md`, `PROJECT_DECISIONS.md`, `knowledge/KNOWLEDGE_INDEX.md`, `knowledge/CONNECTIONS.md`, `lib/schedule.ts`, `features/live-trading-hardening/FEATURE_ARCHITECTURE.md`, and the current pipeline/live-trading code paths named in the prompt. This is a static/code-path review; I did not place orders or call Robinhood trading tools.

## Executive verdict

The direction is right: the app has moved away from “LLM as price/order executor” toward deterministic scoring, evidence masks, paper-trade transactions, broker adapters, explicit live order gates, and validation-gated challengers. That is the correct foundation.

The system is not ready for real-money trading at meaningful size yet. The largest remaining risks are not the initial submit gate; that part is comparatively strong. The remaining risks are around post-submit truth, account scoping, stale parallel proposal systems, and advisory/alternate agents writing into the same tables consumed by execution.

## Severity-ranked findings

### 1. CRITICAL — Robinhood live orders cannot be reconciled after submit

- Category: wiring/integration, data-integrity, live-trading safety
- Evidence: `lib/brokers/adapters/robinhood-mcp.ts:46-48` returns `Robinhood MCP order-status not implemented`; `app/api/broker/orders/sync/route.ts:22-32` polls only `submitted` / `partially_filled` rows and delegates to `broker.getOrder`; `features/live-trading-hardening/FEATURE_ARCHITECTURE.md:86-115` correctly calls this out as a draft future phase.
- Failure scenario: a real Robinhood order is placed and `broker_orders.status` becomes `submitted` at `app/api/broker/orders/route.ts:228-230`. The broker fills it, partially fills it, rejects it, or cancels it, but Kairos never learns the final state. `trade_proposals.fill_price`, `filled_at`, `decision_journal`, live position reconciliation, stop placement, and P&L all remain wrong/stale.
- Fix: implement `robinhoodMcpAdapter.getOrder()` using deterministic MCP `get_equity_orders` or the single-order equivalent. Parse with `mcpToolJson`, map Robinhood states to the adapter status union, update `broker_orders`, update the linked `trade_proposals`, insert a fill journal entry, and include `unknown_needs_reconcile` rows in the sync/reconcile path until they are resolved.

### 2. CRITICAL — live notional cap can use the wrong Robinhood account

- Category: live-trading safety, data-integrity
- Evidence: the Gateway computes fallback notional cap from the latest unfiltered snapshot at `app/api/broker/orders/route.ts:152-156`; the MCP snapshot writer hardcodes `account_id: "965848641"` at `app/api/live-account/refresh-snapshot/route.ts:26-33`; the agentic order account is `605420660` per `knowledge/CONNECTIONS.md` and `supabase/migrations/093_robinhood_mcp_scaffolding.sql:27-34`.
- Failure scenario: `strategy_config.max_order_notional` is null. The Gateway falls back to `live_account_snapshots.equity`, but the latest row may represent read-only account `965848641`, not the agentic trading account `605420660`. A large read-only account can accidentally raise the order cap for the smaller agentic account, or a null/misparsed snapshot can block valid orders.
- Fix: for live orders, resolve the exact trading account first, then read `live_account_snapshots` filtered by that account. The snapshot refresh must write the active account id, not a hardcoded read-only account. Prefer setting `max_order_notional` explicitly until this is fixed.

### 3. CRITICAL — Robinhood SELL gate is not actually scoped to the active trading account

- Category: live-trading safety, correctness
- Evidence: `app/api/broker/orders/route.ts:179-184` calls `robinhoodHeldQty(symbol)` without passing the account; `lib/robinhood-mcp.ts:486-505` calls `get_equity_positions` with `{}` and regex-searches the entire response for symbol/quantity.
- Failure scenario: Vaibhav holds `AAPL` in a read-only Robinhood account but not in the agentic account. The regex sees `AAPL` in the global positions payload and returns a quantity, allowing a live SELL from the agentic account even though that account does not hold enough shares. The broker may reject it, or worse, semantics could change later and this becomes a wrong-account execution bug.
- Fix: pass the resolved `active_account_us` into `robinhoodHeldQty(account, symbol)`. Build the `get_equity_positions` args from schema if the MCP supports account scoping, or parse the returned positions into structured JSON and filter by account id/account number before summing quantity. If account scoping is unavailable, fail closed for live sells.

### 4. HIGH — Smart Money still has two proposal systems alive

- Category: wiring/integration, live-trading correctness
- Evidence: `app/api/markets/smart-money/route.ts:41-47` still reads `trade_queue`; `app/dashboard/smart-money/page.tsx:39-51` reads `trade_proposals`; `app/api/agents/trade/route.ts:12-23` admits it is deprecated but still writes `trade_queue`; legacy approve/reject routes still mutate `trade_queue` at `app/api/agents/trade/approve/route.ts:16-31` and `app/api/agents/trade/reject/route.ts:16-31`.
- Failure scenario: any client using `/api/markets/smart-money` sees a different queue from the server-rendered Smart Money page. The legacy route can mark `agent_signals.status='approved'` at `app/api/agents/trade/route.ts:106`, removing a signal from the main `trade_proposals` pipeline without creating a Gateway-usable proposal. This creates silent drops and operator confusion.
- Fix: complete Phase 1 immediately. Retire `/api/agents/trade/*` or make it write `trade_proposals`; update `/api/markets/smart-money` to read `trade_proposals`; add a grep-level test or lint check that no runtime route reads/writes `trade_queue`.

### 5. HIGH — DeepSeek research can inject LLM-scored signals into the execution pipeline

- Category: architecture, correctness, data-integrity
- Evidence: `lib/deepseek-agent.ts:160-184` asks DeepSeek for `analyst_score`; `lib/deepseek-agent.ts:187-198` inserts into `agent_signals` with `status: "pending"` and `agent_label: "deepseek"`; PaperTrader consumes any pending long signal at `app/api/agents/paper-trade/route.ts:111-117`; TraderAgent consumes any pending long signal at `app/api/agents/trader/route.ts:150-158`.
- Failure scenario: a manual/on-demand DeepSeek run returns `BUY`, `analyst_score=90`. Because it writes `status='pending'` into the shared table, the next PaperTrader or TraderAgent run can paper-fill or create a live proposal from a score that bypassed the deterministic 5-dimension scoring, evidence availability mask, champion weights, and abstain-on-thin-evidence rules.
- Fix: make `deepseek-research` advisory-only by default: insert `status='advisory'` or a separate `advisory_signals` table, and have PaperTrader/TraderAgent explicitly require `source='research'` or `agent_type='research'` plus deterministic score fields/evidence mask. Better architecture: retire this as an alternate signal writer and use DeepSeek only as a selectable thesis/prose model inside the main ResearchAgent after deterministic scores are computed.

### 6. HIGH — TraderAgent’s MacroSentinel threshold raise is likely dead due to wrong column name

- Category: correctness, risk management
- Evidence: TraderAgent selects `danger_score, regime_label` from `macro_regime` at `app/api/agents/trader/route.ts:117-122`; the actual migration defines `macro_regime.regime`, not `regime_label`, at `supabase/migrations/028_macro_signals.sql:15-24`; MacroSentinel writes `regime` at `app/api/agents/macro-sentinel/route.ts:313-322`.
- Failure scenario: PostgREST returns a select error for the nonexistent `regime_label` column. The `try/catch` at `app/api/agents/trader/route.ts:116-140` swallows it, so `scoreThreshold` stays at the base threshold even during ORANGE/RED macro regimes. The UI may show macro stress while proposal generation does not apply the intended higher bar.
- Fix: change the select to `danger_score, regime`, order by the real timestamp, and log/alert on macro query failure instead of silently proceeding. Add a unit/integration test with a `macro_regime` row at danger score 80 and assert the threshold raises.

### 7. HIGH — Review echo check is too weak for real-money schema mapping

- Category: live-trading safety, correctness
- Evidence: `submitRobinhoodOrder()` reviews before place at `lib/robinhood-mcp.ts:387-398`; `reviewEchoMismatch()` only checks symbol if the literal word `SYMBOL` appears and quantity if it matches a specific regex at `lib/robinhood-mcp.ts:421-432`. It does not verify side, account, order type, time-in-force, or estimated notional.
- Failure scenario: schema discovery maps fields in a way that the review preview says `SELL` instead of `BUY`, or the preview points to a different account/order type, but the text does not match the narrow regex. The app can proceed to place because the mismatch is not detected.
- Fix: parse the review payload structurally with `mcpToolJson` first. Require exact match for symbol, side, quantity, account, order type, and time-in-force when fields are present. If the review payload is opaque text, display it to the user in a pre-send modal and require explicit confirmation of the broker-reviewed preview before `place_equity_order`.

### 8. HIGH — live snapshot MCP parser still stores raw/unparsed MCP content

- Category: data-integrity, UI correctness, live-trading safety
- Evidence: `app/api/live-account/refresh-snapshot/route.ts:21-33` converts `accounts.content` to text and regexes `equity`, `buying_power`, and `portfolio_value`; it writes `positions_json: positions ?? null` without parsing the MCP text payload. The hardening spec correctly identifies this at `features/live-trading-hardening/FEATURE_ARCHITECTURE.md:121-139`.
- Failure scenario: Robinhood MCP returns `content: [{type:"text", text:"{\"data\":...}"}]`. The route stores the array/text wrapper instead of a normalized positions array. Live Portfolio shows empty/wrong holdings, notional cap fallback sees null equity, and downstream read paths cannot reliably inspect positions.
- Fix: reuse/export `mcpToolJson` to parse both accounts and positions. Normalize into `{account_id,equity,buying_power,portfolio_value,positions:[...]}`. Write one snapshot row per account or the active agentic account explicitly.

### 9. HIGH — no broker-side protective stops after live entries

- Category: live-trading safety, architecture
- Evidence: PositionMonitor is app-side polling only; `features/live-trading-hardening/FEATURE_ARCHITECTURE.md:174-213` correctly lists broker-side stops as a future Phase 5. No current adapter stop/bracket support appears in `lib/brokers/adapters/robinhood-mcp.ts:17-51`.
- Failure scenario: a live position fills, then Vercel cron is delayed, the app is down, the market gaps, or the position moves outside market hours. The app has no resting broker-side stop. Risk control exists only when Kairos runs and notices.
- Fix: before increasing live order size, confirm Robinhood MCP `tools/list`/input schema for stop or bracket/OCO. If supported, place a protective stop after fill for actual filled quantity. If unsupported, show a prominent “app-side stop only” warning and cap live size accordingly.

### 10. MED — shadow A/B decisions do not replay the production scoring rule

- Category: learning-loop correctness, data-integrity
- Evidence: production scoring uses `computeWeightedAnalystScore()` with availability masks at `lib/research-agent.ts:860-884`; shadow decisions compute `scores.fundamental_score * sfw + ...` directly at `lib/research-agent.ts:1129-1150`.
- Failure scenario: a shadow strategy is evaluated on an ETF or a symbol with missing sentiment/macro/insider data. Production renormalizes over included dimensions; shadow uses fixed raw multiplication. The recorded `shadow_decisions.score` can disagree with what that policy would have scored if actually promoted.
- Fix: use the same `computeWeightedAnalystScore(scoreOf, included, shadowWeights)` path for shadow decisions, including availability mask and renormalized weights. Store applied weights in `shadow_decisions` for audit.

### 11. MED — decision observations do not persist the champion strategy version id

- Category: data-integrity, learning-loop auditability
- Evidence: ResearchAgent loads only `weights_snapshot` from the champion at `lib/research-agent.ts:820-829`; decision observations write `strategy_version_id: null` at `lib/research-agent.ts:1077-1082`.
- Failure scenario: later validation can replay the numeric weights, but cannot prove which champion version generated the original decision. If two champions share similar weights or a strategy is promoted/retired, the observation ledger loses the exact policy lineage.
- Fix: select `id, weights_snapshot` for the champion and write `strategy_version_id: champion.id` into `decision_observations`, `agent_signals`, and `trade_proposals` where applicable.

### 12. MED — active feature registry/genome is not wired into production scoring

- Category: architecture, learning-loop completeness
- Evidence: LearnerAgent can propose features at `app/api/agents/learner/route.ts:646-688`; feature-check can promote them at `app/api/validation/feature-check/route.ts:62-79`; `rg` shows ResearchAgent does not read `feature_registry` or `evaluateFeature`; ResearchAgent reads only champion `weights_snapshot` at `lib/research-agent.ts:820-858`.
- Failure scenario: the app appears “self-evolving” because it has proposed/quarantined/active features and a genome module, but active features never affect `analyst_score`, PaperTrader, or validation replay. Evolution is still mostly five-weight rebalancing plus dormant artifacts.
- Fix: add an explicit Phase 4 integration: active features become additional whitelisted dimensions or feature transforms in `computeWeightedAnalystScore`; validation must replay them point-in-time; ResearchAgent must log which active features contributed. Until then, label feature evolution as experimental/advisory.

### 13. MED — `getConfiguredModel()` ignores disabled agents and still runs the fallback model

- Category: governance, cost/rate-limit
- Evidence: `lib/agent-model-config.ts:5-9` returns the fallback model when `agent_config.enabled === false`.
- Failure scenario: the user disables `macro-read`, `mentor-coach`, or another advisory LLM route in Settings expecting it to stop spending tokens. The route calls `getConfiguredModel()`, receives `deepseek-v4-pro`, and still runs.
- Fix: return `{enabled:false}` or throw a typed disabled result. Callers should skip execution and return `skipped: agent disabled`, not silently run a fallback model.

### 14. MED — Strategy promotion allows a validation override from any authenticated user

- Category: security, governance
- Evidence: `app/api/strategies/versions/route.ts:46-49` checks only “some logged-in user”, not `requireOwner()`; `force_unvalidated` bypasses the validation gate at `app/api/strategies/versions/route.ts:78-90`.
- Failure scenario: if any non-owner authenticated user/session ever exists, they can promote or force-promote a strategy version. Even in a single-user app, the override path makes “validation-gated promotion” weaker than advertised unless it is treated as an explicit governance override.
- Fix: use `requireOwner()` for all strategy mutation actions. Keep `force_unvalidated` only behind an explicit typed confirmation/reason, journal it, and show it as a red governance override in the UI. Ideally require a passed validation row for any strategy that can feed live trading.

### 15. MED — TraderAgent is still US-centric and not market-scoped

- Category: market scoping, correctness
- Evidence: TraderAgent queries all pending long `agent_signals` at `app/api/agents/trader/route.ts:150-158` with no `market` filter; it sizes off the US pool at `app/api/agents/trader/route.ts:260-266`; inserted `trade_proposals` at `app/api/agents/trader/route.ts:283-301` do not include `market`.
- Failure scenario: if an India `.NS` signal remains `pending` and passes the score threshold, TraderAgent may attempt to create a US/account-number proposal from it, or skip unpredictably when `getQuote()` cannot price it. Even if today’s data makes this rare, the route does not encode the market boundary.
- Fix: make TraderAgent explicitly US-only for live Robinhood proposals now: `.eq("market","us")`, reject India symbols, write `market:'us'` into `trade_proposals`, and add a separate future India live proposal route only when Kite live execution is intentionally enabled.

### 16. MED — unknown/ambiguous Robinhood orders are not included in sync

- Category: reliability, live-trading safety
- Evidence: ambiguous place returns `needsReconcile` at `lib/robinhood-mcp.ts:403-417`; the Gateway writes `status: "unknown_needs_reconcile"` at `app/api/broker/orders/route.ts:220-222`; sync only selects `submitted` and `partially_filled` at `app/api/broker/orders/sync/route.ts:22-23`.
- Failure scenario: a place call times out after Robinhood accepted it. Kairos marks the order `unknown_needs_reconcile`, which correctly blocks duplicate submit, but the scheduled sync never touches that row. It remains stuck until manual DB intervention.
- Fix: include `unknown_needs_reconcile` in `openOrders`; call Robinhood order list with a time/symbol/account filter when `broker_order_id` is missing; update to submitted/filled/error once matched or conclusively absent.

### 17. LOW — raw Robinhood order state redaction does not remove account numbers

- Category: security/privacy
- Evidence: `redact()` only strips Bearer-token shaped strings at `lib/robinhood-mcp.ts:460-467`; `raw_last_state` persists `result.raw` at `app/api/broker/orders/route.ts:228-230`.
- Failure scenario: if Robinhood’s review/place payload includes account number, buying power, or other private account metadata, it can be stored in `broker_orders.raw_last_state` and displayed/returned by owner APIs.
- Fix: redact account numbers, token-like fields, and personal identifiers before persistence. Prefer storing a normalized subset: `{state, order_id, symbol, side, qty, submitted_at}`.

### 18. LOW — Smart Money live confirmation displays `undefined` side

- Category: UI correctness, live-trading UX
- Evidence: Smart Money maps `side` to `order_side` at `app/dashboard/smart-money/page.tsx:47-49`; `handleSendLive()` reads `t.side` at `components/dashboard/SmartMoneyPage.tsx:174-183`.
- Failure scenario: the real Gateway still uses the DB `side`, so the order payload is not wrong, but the live-money browser confirmation can show `UNDEFINED 10 AAPL`, reducing trust at exactly the moment the user is approving real money.
- Fix: use `const side = t.side ?? t.order_side` in all Smart Money action handlers and display paths.

## Part C — live-trading-hardening spec assessment

The draft is directionally correct and should be approved in phases, but the priority should be adjusted:

1. Make Phase 2 “Robinhood status sync + unknown reconciliation” Phase 1A, before more live orders. Without post-submit truth, the system cannot know whether capital is actually exposed.
2. Keep current Phase 1 `trade_queue → trade_proposals` as Phase 1B. It is a real correctness hazard, especially because `/api/markets/smart-money` still reads `trade_queue`.
3. Make the live snapshot/account parser fix part of Phase 1, not Phase 3, because notional cap and live SELL safety depend on account-scoped holdings/equity.
4. Phase 4 pre-send review modal is mandatory before a real “Send LIVE” UI is considered mature. The current two `confirm()` dialogs are not enough because they do not show Robinhood’s own reviewed preview.
5. Phase 5 broker-side stops is the right risk fix, but it must be schema-discovered. Do not assume Robinhood MCP supports `stop_price`, bracket, or OCO. Add adapter capability flags like `supportsStopOrders`, `supportsBracketOrders`, `supportsCancelReplace`.
6. Deferring autonomous live mode is correct. Deferring limit entries is also reasonable for a daily swing system, but broker-side stop orders are not the same complexity class as limit entries; stops are risk control and should be prioritized.

## Part D — DeepSeek research recommendation

Current answer:

1. `deepseek-research` is a legitimate manual/advisory research experiment, but it is unsafe as a shared-table signal writer because it inserts into `agent_signals.status='pending'`.
2. Yes, it can inject signals that bypass the main deterministic ResearchAgent. That is the core consistency hole.
3. Recommended architecture: do not let DeepSeek produce tradable numeric scores. Use DeepSeek as a selectable model for thesis/explanation/debate only inside the main ResearchAgent, after deterministic scores and evidence masks are computed. If keeping `/api/agents/deepseek-research`, write to an advisory table or `agent_signals.status='advisory'` and explicitly exclude it from PaperTrader/TraderAgent.

DeepSeek model routing itself is plausible: official DeepSeek docs list `deepseek-v4-flash` and `deepseek-v4-pro`, both with tool-call support, and note that `deepseek-chat` / `deepseek-reasoner` are compatibility/deprecation paths. Sources: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing), [DeepSeek model list API docs](https://api-docs.deepseek.com/api/list-models), [DeepSeek updates](https://api-docs.deepseek.com/updates).

The model-routing principle should be:

- Flash/cheap model: summaries, briefings, macro-read, UI explanations.
- Pro/reasoning model: mentor, deep-dive debate, learner hypothesis generation.
- Deterministic code: prices, scores, P&L, order sizing, validation, order payloads.
- No LLM: final numeric score generation, broker order construction, approval gates.

## Biggest risks before trading real money at size

1. No reliable Robinhood fill/reconcile loop yet.
2. Account scoping is not strong enough for live notional caps and live SELL checks.
3. `trade_queue` and `trade_proposals` still coexist in runtime routes.
4. DeepSeek/advisory signal writers can feed the same `agent_signals` queue consumed by PaperTrader/TraderAgent.
5. Broker-side protective stops are not implemented, so live risk control is app-side only.
6. The system has self-improvement scaffolding, but feature/genome evolution is not fully wired into production scoring yet.

## Recommended fix order for Claude

1. R0 live-safety patch: Robinhood `getOrder`/sync/reconcile, include `unknown_needs_reconcile`, account-scoped snapshot parsing, account-scoped `robinhoodHeldQty`.
2. R1 proposal consolidation: retire/repoint all `trade_queue` runtime routes and update `/api/markets/smart-money`.
3. R2 signal-source isolation: make DeepSeek/advisory outputs non-tradable unless explicitly converted through the deterministic ResearchAgent contract.
4. R3 governance hardening: owner-gate strategy mutations, remove or strongly gate `force_unvalidated`, fix MacroSentinel threshold query.
5. R4 learning-core consistency: persist champion ids, use production scoring for shadow decisions, then wire active feature/genome artifacts into ResearchAgent only after validation replay supports them point-in-time.
