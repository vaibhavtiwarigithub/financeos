# Codex Review Result — India Multi-Market — 2026-07-05

[SEV: critical] lib/kill-switches.ts:18
Problem: The kill switch reads the US portfolio row but computes daily loss, peak drawdown, and accuracy from unscoped `paper_performance` and `paper_trades`, mixing INR and USD and allowing India outcomes/NAV to disable all trading.
Trigger: Any India performance row or closed India trade exists when `checkKillSwitches()` runs before a US or India paper fill.
Fix: Add `.eq("market", market)` to all three inputs, pass the requested market into `checkKillSwitches`, use that market's starting NAV/currency, and decide explicitly whether a trip disables only that market or the global system.

[SEV: critical] app/api/agents/learner/route.ts:38
Problem: `LEARN_MARKET` is hard-coded to `"us"`, while Phase A loads every open position and looks up the latest signal without a market filter, so India cannot learn independently and an India position can be reassessed from a US signal or have its target labeled as dollars.
Trigger: Run LearnerAgent with any India position/trade present, especially where the same base symbol has signals in both cohorts.
Fix: Parse and validate `?market=us|india`, scope `paper_positions`, `agent_signals`, `learner_runs`, recent-run guards, hypotheses, logs, phase gates, champions, and challengers to that market; schedule separate market runs or iterate cohorts explicitly.

[SEV: critical] app/api/agents/performance/route.ts:12
Problem: The endpoint selects the US pool but aggregates unscoped NAV history, trades, position counts, realized P&L, win rate, and gates, so INR results are combined with USD and evaluated against a `$10,000` baseline and SPY.
Trigger: Any India position, trade, or snapshot exists and `/api/agents/performance` GET or POST runs.
Fix: Add `market` and `currency` to `paper_nav_history` with unique `(date, market)`, accept a validated market scope, filter every query, use the correct start NAV/benchmark, and keep US/India payloads separate.

[SEV: critical] supabase/migrations/057_multi_market.sql:28
Problem: Migration 057 adds only `market` to `paper_order_events`, but PaperTrader inserts both `market` and `currency`; every post-migration event insert therefore fails on `currency`, then the retry removes both fields and records an India event with the default US market.
Trigger: Any India paper fill after migration 057.
Fix: Add `currency text NOT NULL DEFAULT 'USD'` to `paper_order_events`; backfill existing India events from their linked signal/trade; in PaperTrader remove only a genuinely missing column and never discard a valid market tag.

[SEV: critical] app/api/agents/position-monitor/route.ts:116
Problem: Closing one aggregated position marks every open fill for that symbol with the full position-level `realizedPnl` and `pnlPct`, duplicating P&L and assigning the wrong return to fills with different costs.
Trigger: A symbol is accumulated through two or more paper fills, then hits a stop, target, score exit, or `llm_exit`.
Fix: Compute each trade's realized P&L from its own `qty` and `fill_price` (or maintain explicit lots), update each row with its own result, and assert that summed lot proceeds/P&L reconcile to the closed position.

[SEV: high] app/api/agents/paper-trade/route.ts:210
Problem: A paper fill is a sequence of unchecked, non-transactional writes; event/trade/position/cash failures are ignored and the signal is still marked `paper_traded`, producing phantom trades, missing positions, or incorrect cash.
Trigger: Any transient Supabase error, constraint violation, timeout, or process interruption between lines 210 and 262.
Fix: Move claim, event, trade, position upsert, cash debit, and signal transition into one database transaction/RPC with row locking and idempotency keys; fail and release the claim unless every mutation commits.

[SEV: high] app/api/agents/paper-trade/route.ts:227
Problem: Compatibility retries treat every insert error as proof that market columns are absent and retry without `market`/`currency`, silently converting India records to US on unrelated database failures.
Trigger: An India trade/position insert fails for any reason other than undefined columns, such as a constraint, malformed value, or temporary schema-cache error.
Fix: Retry legacy shapes only for PostgreSQL undefined-column/schema-cache error codes and only for the named missing column; otherwise stop the fill and surface the original error. Apply the same rule at `lib/research-agent.ts:832` and `lib/research-agent.ts:856`.

[SEV: high] app/api/scan/india/route.ts:151
Problem: Cached rows are always marked `data_sufficient: true`, and missing strategy fields are skipped, so a row with only a price and no RSI/fundamentals can pass with “All conditions met.”
Trigger: The nightly cache stores a symbol whose Yahoo candles or overview were partial, then a strategy scan requires unavailable RSI/MA/fundamental fields.
Fix: Persist/evaluate per-field availability, mark a row insufficient whenever a requested condition cannot be evaluated, make missing required strategy fields fail/abstain, and set `passes_filters` only when every requested condition was evaluated and passed.

[SEV: high] lib/nse-data.ts:80
Problem: The nullish-coalescing/ternary expression for insider transaction type is parsed so any non-null `tdpTransactionType` makes the result `"BUY"`, misclassifying sell disclosures.
Trigger: NSE returns a row with `tdpTransactionType` populated as a sell/disposal value.
Fix: Normalize `tdpTransactionType` explicitly first, then fall back to `buyValue`/`sellValue` using parenthesized independent conditions.

[SEV: high] lib/market-context.tsx:22
Problem: Restoring the market from `localStorage` changes React state but does not synchronize the `mkt` cookie; disabling India also leaves a stale India cookie, so the header/client panels can show India while server components fetch US, or hidden-switch pages can still fetch India.
Trigger: Local storage and cookie disagree, the cookie is missing, or `market_focus` removes India after it was selected.
Fix: In the restore effect compute one allowed market and update state, local storage, and cookie together; preferably initialize from a server-provided cookie value to avoid a mixed hydration frame.

[SEV: high] components/dashboard/PortfolioPage.tsx:684
Problem: Paper Portfolio maintains its own US-default market state instead of using the global market context, and only positions/trades/performance are filtered; `signals`, `pendingSignals`, and `tradeQueue` remain cross-market.
Trigger: Select India globally or switch the local portfolio market while both US and India signals exist.
Fix: Use `useMarket()` as the sole selector and filter every market-tagged collection before counts, tables, opportunity analysis, and queue rendering; hide the US-only untagged trade queue for India.

[SEV: medium] app/api/agents/research/cron/route.ts:51
Problem: The 30-minute idempotency guard is global to `agent_type="research"`, so a recent run for one market suppresses a legitimate run for the other market.
Trigger: Manual/retried US and India research runs occur within 30 minutes, or schedules are adjusted closer together.
Fix: Store market on `agent_runs` or in a dedicated run key and guard on `(agent_type, market, time window)` with a database uniqueness/locking mechanism rather than check-then-insert.

[SEV: medium] scripts/register-tasks.ps1:28
Problem: India tasks are weekday-only with no NSE holiday calendar, and the 5:30 AM ET scanner refresh occurs at 15:00 IST during US daylight time—before the 15:30 NSE close—so it can cache incomplete-session prices while comments claim post-close data.
Trigger: Any EDT weekday, or an India market holiday that is a normal US weekday.
Fix: Gate India jobs with an NSE trading calendar and schedule using an IST-aware mechanism, or choose an ET time safely after close in both EST and EDT such as 7:00 AM ET.

[SEV: medium] lib/india-data.ts:38
Problem: Yahoo and NSE adapter fetches have no abort timeout; “fail soft” catches rejections but not a stalled upstream before the hosting/task timeout, so batch scans and risk beta can hang the whole route.
Trigger: Yahoo/NSE accepts a connection but stalls or throttles without promptly returning an error.
Fix: Add `AbortSignal.timeout(...)` or an `AbortController` to every upstream fetch, use bounded retries with jitter, and return the documented empty/null fallback after the deadline.

[SEV: low] lib/market-support.ts:43
Problem: The longest-prefix test includes bare `pathname.startsWith(prefix)`, so unrelated paths such as `/dashboard/markets-old` inherit the Markets support claim.
Trigger: A route name merely begins with a registered route string but is not that route or a child path.
Fix: Match only `pathname === prefix || pathname.startsWith(prefix + "/")`.

Count: critical 5, high 6, medium 3, low 1.
