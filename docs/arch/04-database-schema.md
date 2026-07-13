# Kairos — Database Schema
> Last updated: 2026-07-13 (migrations 165 watchlist.market, 166 LLM-config id fix + seed rows, 167 strategy_config trading_style + target_hold_days, 169 live_performance per-account live equity curve, 170 strategy_validation_automation + activate_strategy_shadow RPC, 171 market_controls per-market pause/trading, 172 research_queue, 173 oauth_pkce_state, 174 broker-labelled live snapshots, 175 inert asset-allocation sleeves, 20260713112754 live_performance owner-only RLS tightening)
> Update this file when: any migration adds, removes, or modifies a table, column, index, trigger, or RLS policy.
> Latest schema addition: migration `20260713143000_benchmark_alpha_rotation_shadow.sql` adds benchmark-alpha scorecard tables, live-performance provenance columns, rotation shadow config/events, and the benchmark scorecard pg_cron schedule.

Migrations in `supabase/migrations/`. Applied via Supabase MCP `apply_migration` or the Supabase SQL editor. **Always verify with `list_migrations` before shipping schema-coupled code.** A migration file existing in the repo does NOT mean it ran against production.

---

## Append-only ledgers (NEVER DELETE)

These tables must never be hard-deleted by any agent, cron, or cleanup job:

- `paper_trades` — financial ledger
- `paper_order_events` — event sourcing log (trigger blocks UPDATE/DELETE)
- `decision_observations` — learning fuel (trigger blocks UPDATE/DELETE)
- `broker_orders` — live trade audit trail
- `strategy_evaluations` — evaluation history (trigger blocks UPDATE/DELETE)
- `evidence_records` — immutable evidence ledger
- `holding_risk_runs` — daily per-holding risk run header (trigger blocks UPDATE/DELETE)
- `holding_risk_snapshots` — daily per-holding risk snapshot (trigger blocks UPDATE/DELETE)
- `account_risk_snapshots` — daily per-account risk snapshot (trigger blocks UPDATE/DELETE)
- `rotation_events` — capital-rotation shadow/execution audit ledger (trigger blocks UPDATE/DELETE)

---

## 8.1 Core user & auth

### `profiles`
One row per user. Extended from `auth.users`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | References `auth.users.id` |
| `email` | text | |
| `full_name` | text | |
| `role` | text | `user` \| `admin` \| `superadmin` |
| `subscription_tier` | text | `free` \| `pro` \| `elite` |
| `xp` | int | Experience points |
| `analysis_count` | int | Total AI analysis runs |
| `market_focus` | text | Comma-separated: `us`, `india` (others removed 2026-07-05) |
| `created_at` | timestamptz | |

### `api_key_vault`
Runtime-editable API keys (not in code or env files).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `provider` | text | UNIQUE; e.g. `alpha_vantage`, `kite`, `robinhood_oauth` |
| `display_name` | text NOT NULL | Human-readable name for UI |
| `key_value` | text | Encrypted at rest by Supabase |
| `updated_at` | timestamptz | |
| `expires_at` | timestamptz | Optional; shown as "expiring soon" in vault UI |

---

## 8.2 Strategy & configuration

### `strategy_config`
Single-row table: the live risk profile + trading parameters.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | | |
| `risk_profile` | text | `Balanced` | `Conservative` \| `Balanced` \| `Aggressive` (sizing/thresholds) |
| `trading_style` | text | `position` | **Migration 167 (2026-07-12).** `swing` \| `position` \| `long_term` — Settings → Agents preset that sets the four knobs below + `target_hold_days`. Orthogonal to `risk_profile` (style = horizon/tempo, profile = sizing). |
| `target_hold_days` | int | null | **Migration 167.** Holding horizon the PositionMonitor time-stop prefers ONLY before a champion genome is promoted; a promoted champion's learned `horizon_days` always wins. null = let the genome decide. |
| `score_threshold` | numeric | 60 | Minimum `analyst_score` to open a paper position |
| `position_size_pct` | numeric | 10 | % of pool NAV per trade (hard cap for genome) |
| `stop_loss_pct` | numeric | 7 | Default stop-loss % below entry |
| `target_pct` | numeric | 20 | Default price target % above entry |
| `autonomy_level` | text | `L3_live_manual` | Master gate for live order autonomy |
| `robinhood_mcp_enabled` | bool | false | Live US order path via Robinhood MCP |
| `kite_enabled` | bool | false | Live India order path via Kite |
| `app_paused` | bool | false | NAV circuit breaker auto-sets true; manual reset |
| `live_auto_enabled` | bool | false | DB toggle for autonomous shadow path (migration 139) |
| `live_auto_enabled_until` | timestamptz | null | Owner lease expiry; null = no lease active |
| `live_auto_policy_version` | int | 1 | Snapshot version stamped on every proposal |
| `live_auto_daily_cap_usd` | numeric | null | Max USD spend per calendar day (null = uncapped) |
| `live_auto_max_per_order_usd` | numeric | null | Per-order notional cap |
| `live_auto_min_evidence_confidence` | numeric | 0.6 | Floor below which proposals fail gate 6 |
| `live_auto_max_open_positions` | int | null | Max open broker positions |
| `live_auto_max_orders_per_day` | int | null | Max new proposals per calendar day |

### `agent_config`
Per-agent configuration rows.

| Column | Type | Notes |
|---|---|---|
| `agent_name` | text PK | e.g. `research`, `learner`, `macro-sentinel` |
| `enabled` | bool | |
| `schedule` | text | Human-readable schedule note |
| `model` | text | LLM model assignment (tier alias preferred) |
| `params` | jsonb | Agent-specific parameters |
| `updated_at` | timestamptz | |

### `strategy_versions`
Champion/Challenger governance table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `market` | text | `us` \| `india` |
| `is_champion` | bool | True for the one active champion per market |
| `weights_snapshot` | jsonb | 5-dim weights: `{fundamental, technical, sentiment, macro, insider}` |
| `genome` | jsonb | `{entry_threshold, exit_stop_pct, exit_target_pct, horizon_days, position_size_pct, sizing_mode}` |
| `proposed_by` | text | `learner` \| `user` |
| `backtest_result` | jsonb | Sharpe, Sortino, win_rate, max_dd from Validation Engine |
| `promoted_at` | timestamptz | Null until promoted |
| `retired_at` | timestamptz | |
| `created_at` | timestamptz | |

### `strategy_validation_automation` (migration 170)
Per-market, owner-controlled policy for **automatic** deterministic challenger validation + shadow routing. Fail-closed: a missing row / read error is treated as fully disabled. Owner-email SELECT RLS; writes only via the service client (Settings PATCH) — `authenticated` cannot write. Seeded `us`/`india` both enabled.

| Column | Type | Notes |
|---|---|---|
| `market` | text PK | `us` \| `india` |
| `enabled` | bool | Master switch — off = no auto validation for this market (challengers still created + manually validatable) |
| `auto_shadow_enabled` | bool | When on AND validation passes, auto-route the challenger into one `shadow_paper` slot |
| `max_active_shadows` | int | `0`–`1` (checked) — at most one shadow strategy per market |
| `updated_by` | uuid | FK → `auth.users` (owner who last changed it) |
| `created_at` / `updated_at` | timestamptz | |

**RPC `activate_strategy_shadow(p_version_id)` — `SECURITY DEFINER`, `service_role` only.** The single automatic lifecycle transition: atomically flips a challenger to `state='shadow_paper'` under a per-market advisory lock, only if the policy is enabled + `auto_shadow_enabled`, the linked `validation_experiments` row `passed=true`, the version is not a champion / terminal state, and the market is under its `max_active_shadows` cap. Returns a typed reason (`strategy_not_found` / `automation_disabled` / `invalid_strategy_state` / `validation_not_passed` / `shadow_capacity_reached` / `already_shadow`) and **cannot** promote a champion, create a fill, move cash, or place an order. Driver: `runAutomatedValidation()` in `lib/validation/automation.ts`, called in-process by LearnerAgent when it creates a challenger (replaced the old fire-and-forget localhost request) and by the Friday `kairos-validation-sweep` recovery cron. Settings API: `GET`/`PATCH /api/settings/validation-automation` (owner-gated).

### `market_controls` (migration 171)
Per-market pause / trading-enable state. Previously `app_paused` and `trading_enabled` were GLOBAL columns on the single `strategy_config` row, so a market's own circuit breaker (India NAV drawdown, US kill switch) flipped one shared flag and halted BOTH markets — an India phantom drawdown skipped the US research run (2026-07-13). Now one row per market. A market is paused / trading-disabled if **either** the legacy GLOBAL master (`strategy_config.app_paused`/`trading_enabled`) **or** its own row is set — helpers `isPaused(svc, market)` / `isTradingEnabled(svc, market)` in `lib/market-controls.ts` (fail-closed on read error). Writers: kill switch → `setMarketTrading(market,false)`; drawdown breaker → `setMarketPaused(market,true)`. Owner-read RLS; service-role writes. Seeded from the current global flags.

| Column | Type | Notes |
|---|---|---|
| `market` | text PK | `us` \| `india` |
| `paused` | bool | New-entry pause (drawdown breaker / manual) — gates research-scored entries + autonomous-live entries; exits still run |
| `trading_enabled` | bool | Kill switch — `false` blocks this market's orders |
| `paused_reason` | text | Why (breaker reason or manual note) |
| `paused_at` | timestamptz | |

### `investment_mandates`
Named strategy contexts for attribution and evaluation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | e.g. `Swing US 2-20d` |
| `market` | text | `us` \| `india` |
| `benchmark_ticker` | text | `VOO` (US), `^NSEI` (India) |
| `horizon_days_min` | int | |
| `horizon_days_max` | int | |
| `is_default` | bool | Used when no mandate explicitly specified |
| `created_at` | timestamptz | |

### `learner_config`
LearnerAgent dimension-level controls.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `dimension` | text | `fundamental` \| `technical` \| `sentiment` \| `macro` \| `insider` |
| `learn_from` | bool | Whether to include this dimension in learning |
| `allow_mutation` | bool | Whether LearnerAgent can propose weight changes for this dimension |
| `updated_at` | timestamptz | |

### `learning_priors`
Current signal weight priors used by ResearchAgent.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `dimension` | text | |
| `weight` | numeric | 0–1 |
| `updated_at` | timestamptz | |

### `learning_priors_history`
Immutable audit log of every prior weight change.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `dimension` | text | |
| `old_weight` | numeric | |
| `new_weight` | numeric | |
| `reason` | text | |
| `changed_by` | text | `learner` \| `user` \| `factory_reset` |
| `created_at` | timestamptz | Pruned >365d by DB cleanup |

### `experiment_runs`
Backtest / Validation Engine run records.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `strategy_version_id` | uuid | FK → `strategy_versions` |
| `market` | text | |
| `sharpe` | numeric | |
| `sortino` | numeric | |
| `win_rate` | numeric | |
| `max_drawdown` | numeric | |
| `alpha` | numeric | vs benchmark |
| `trade_count` | int | |
| `eligibility_passed` | bool | Sharpe ≥ 0.5 and win_rate ≥ 40% |
| `created_at` | timestamptz | |

### `strategy_evaluations`
Append-only mandate-aware evaluation snapshots (Performance Truth Layer).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `mandate_id` | uuid | FK → `investment_mandates` |
| `market` | text | |
| `trade_count` | int | |
| `tainted_count` | int | Trades with low data_confidence |
| `sharpe` | numeric | |
| `sortino` | numeric | |
| `max_drawdown` | numeric | |
| `win_rate` | numeric | |
| `expectancy` | numeric | |
| `profit_factor` | numeric | |
| `alpha` | numeric | |
| `exec_slip_mean` | numeric | Mean realized slip vs 0.05% modeled |
| `health_label` | text | `insufficient_sample` \| `negative_or_zero_edge` \| `promising_but_unvalidated` \| `validation_required` |
| `dataset_hash` | text | Dedup reruns on same trade set |
| `created_at` | timestamptz | Append-only. Trigger blocks UPDATE/DELETE. |

---

## 8.3 Research + signals

### `agent_signals`
One row per symbol per research run. The "today's score" table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | Ticker |
| `agent_label` | text | `claude` \| `deepseek` |
| `market` | text | `us` \| `india` |
| `asset_class` | text | `equity` \| `etf` \| `india` \| `metals_basket` |
| `analyst_score` | numeric | 0–100 composite |
| `fundamental_score` | numeric | |
| `technical_score` | numeric | |
| `sentiment_score` | numeric | |
| `macro_score` | numeric | |
| `insider_score` | numeric | |
| `recommendation` | text | `BUY` \| `SELL` \| `HOLD` \| `WATCH` |
| `direction` | text | `long` \| `short` \| `neutral` |
| `signal_breakdown` | jsonb | Per-dimension evidence detail |
| `thesis` | text | Groq-generated one-paragraph thesis |
| `data_confidence` | numeric | 0–1; below 0.5 → tainted |
| `discovery_source` | text | How symbol entered the batch |
| `mandate_id` | uuid | FK → `investment_mandates` |
| `status` | text | `pending` \| `filled` \| `expired` \| `claimed` \| `rank_rejected` |
| `claim_run_id` | uuid | FK → `agent_runs`; prevents double-fill |
| `rank_pct` | numeric | Within-comparable-group percentile (migration 151); null until Pass-2 rank runs. Check `[0,1]`. |
| `rank_rejected` | bool | True when candidate cleared the absolute floor but failed the cross-sectional rank gate (migration 151); default false. |
| `created_at` | timestamptz | |

### `signal_score_history`
Append-only per-symbol score history. Never mutated after insert.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | |
| `analyst_score` | numeric | |
| `fundamental` | numeric | |
| `technical` | numeric | |
| `sentiment` | numeric | |
| `macro` | numeric | |
| `insider` | numeric | |
| `direction` | text | |
| `source` | text | `claude` \| `deepseek` |
| `created_at` | timestamptz | Index: `(symbol, created_at DESC)`. Pruned >180d by DB cleanup. |

### `decision_observations`
Immutable ledger of EVERY scored candidate (even ones not traded). The learning fuel.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | |
| `mandate_id` | uuid | |
| `analyst_score` | numeric | |
| `data_confidence` | numeric | |
| `discovery_source` | text | |
| `raw_data` | jsonb | Full scoring inputs; `_using_champion_weights: bool` |
| `action_taken` | text | `filled` \| `skipped` \| `expired` |
| `created_at` | timestamptz | Append-only. Never deleted. |

### `research_packets`
Full research context per run (for debug + audit).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `raw_data` | jsonb | Full scoring inputs + scores |
| `created_at` | timestamptz | |

### `watchlist`
Tracked symbols.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | UNIQUE with `user_id` |
| `market` | text | `US` \| `India` \| `Global` \| `Crypto`, NOT NULL default `US`. **Added migration 165 (2026-07-12)** — the route code (GET filter, POST) had read/written this column for months but no migration ever created it, so GET 500'd (panel showed "0 tracked") and every manual add silently failed. |
| `source` | text | `manual` \| `llm_theme` \| `tradingview_import` \| `robinhood*` \| `briefing` |
| `theme` | text | AI-Scout theme label |
| `reason` | text | why added |
| `research_enabled` / `alert_on_signal` / `alert_on_earnings` | bool | per-symbol toggles |
| `created_at` | timestamptz | |

### `edge_signals`
Factor/edge lab signal rows.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `factor_key` | text | e.g. `momentum_12_1`, `quality_roe` |
| `symbol` | text | |
| `market` | text | |
| `value` | numeric | Raw factor value |
| `z_score` | numeric | Cross-sectional z-score |
| `created_at` | timestamptz | Pruned >180d by DB cleanup |

### `edge_ic_history`
Information Coefficient (IC) history per factor.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `factor_key` | text | |
| `market` | text | |
| `ic` | numeric | Rank correlation: predicted score vs 1-month return |
| `n` | int | Number of names in the cohort |
| `period_end` | date | |
| `created_at` | timestamptz | Pruned >365d by DB cleanup |

### `macro_regime`
Current macro risk regime.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `regime` | text | `GREEN` \| `YELLOW` \| `ORANGE` \| `RED` |
| `danger_score` | numeric | 0–100 |
| `computed_at` | timestamptz | Most recent row is the live regime |

### `macro_signals`
Per-indicator breakdown for the current regime.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `regime_id` | uuid | FK → `macro_regime` |
| `indicator` | text | `yield_curve` \| `sahm_rule` \| `real_gdp` \| `nonfarm_payroll` \| `cpi` \| `retail_sales` \| `fed_funds` \| `durables` |
| `raw_value` | numeric | |
| `contribution` | numeric | Weighted contribution to danger_score |
| `direction` | text | `positive` \| `negative` \| `neutral` |
| `computed_at` | timestamptz | Pruned >90d by DB cleanup |

### `india_screen_cache`
Full NSE universe cache (avoids re-scoring 5000 names each run).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | `.NS` ticker |
| `analyst_score` | numeric | |
| `scores_json` | jsonb | 5-dim breakdown |
| `updated_at` | timestamptz | Pruned >7d by DB cleanup |

---

## 8.4 Paper portfolio

### `paper_portfolio`
NAV state per market (cash + positions = NAV).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `market` | text | `us` \| `india` |
| `cash` | numeric | Starting: US $10,000, India ₹1,000,000 |
| `nav` | numeric | cash + sum of open position values |
| `peak_nav` | numeric | All-time high NAV (for drawdown circuit breaker) |
| `updated_at` | timestamptz | |

### `paper_positions`
Open pretend-money positions (deleted on close).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | |
| `qty` | numeric | Shares held |
| `avg_cost` | numeric | Fill price |
| `expected_price` | numeric | Pre-slippage decision price |
| `realized_slip_pct` | numeric | `fill/expected - 1`; execution quality signal |
| `fill_status` | text | `full` \| `partial` \| `failed` |
| `price_target` | numeric | Exit at this price |
| `stop_loss` | numeric | Hard stop (trailing or original) |
| `highest_price` | numeric | For trailing stop computation |
| `exit_reason` | text | `stop` \| `target` \| `llm_exit` \| `time_stop` \| `partial_profit` |
| `mandate_id` | uuid | |
| `opened_at` | timestamptz | Age used for time stop |

### `paper_trades`
Closed paper trade ledger (append-only in practice; never hard-deleted).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | |
| `action` | text | `buy` \| `sell` |
| `qty` | numeric | |
| `price` | numeric | Fill price |
| `expected_price` | numeric | Decision price |
| `realized_slip_pct` | numeric | |
| `fill_status` | text | |
| `exit_price` | numeric | Closing price (on sell) |
| `realized_pnl` | numeric | |
| `pnl_pct` | numeric | |
| `outcome` | text | `win` \| `loss` \| `break_even` |
| `exit_reason` | text | |
| `data_confidence` | numeric | From the signal that opened the trade |
| `tainted` | bool | Low data_confidence; excluded from learner training |
| `excluded_from_learning` | bool | Manually flagged |
| `mandate_id` | uuid | |
| `market_regime` | text | `GREEN` \| `YELLOW` \| `ORANGE` \| `RED` at time of trade |
| `agent_label` | text | `claude` \| `deepseek` (P&L comparison) |
| `opened_at` | timestamptz | |
| `closed_at` | timestamptz | |

### `paper_order_events`
Immutable append-only event log for every paper order state change.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `paper_trade_id` | uuid | FK → `paper_trades` |
| `event_type` | text | `submitted` \| `filled` \| `partially_filled` \| `cancelled` \| `error` |
| `price` | numeric | |
| `qty` | numeric | |
| `detail` | jsonb | |
| `created_at` | timestamptz | Trigger blocks UPDATE/DELETE. |

### `paper_performance`
Daily NAV snapshots per market.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `date` | date | |
| `market` | text | |
| `nav` | numeric | |
| `bench_nav` | numeric | Benchmark (VOO/^NSEI) NAV on this date |
| `return_pct` | numeric | |
| `alpha` | numeric | `return_pct - bench_return_pct` |
| UNIQUE | `(date, market)` | One row per day per market |

### `live_performance` (migration 169, RLS tightened 20260713112754)
Daily equity curve per LIVE account - the live analogue of `paper_performance`, backing the per-account **Live Portfolio vs VOO** chart. Robinhood's MCP exposes NO account-value history (`get_equity_historicals` is per-symbol OHLC; `get_portfolio` is current-only), so this cannot be backfilled - it is **accrued forward**: each account-snapshot refresh (`/api/live-account/refresh-snapshot`, `robinhood_mcp` source plus connected registry MCP brokers such as Webull) upserts one row/account/day with real broker equity + that day's VOO close. Until >=2 real days exist for the selected accounts, `/api/live-portfolio/performance` falls back to a **labeled constant-holdings estimate** (`estimated:true`) reconstructed from current holdings x Massive symbol history. Service-role writes; owner-email authenticated SELECT only.

| Column | Type | Notes |
|---|---|---|
| `account_id` | text | Broker account ID; PK part |
| `date` | date | Calendar day (UTC); PK part |
| `equity` | numeric | Real broker account value (USD) that day |
| `bench_nav` | numeric | VOO close the same day (null until a refresh records it) |
| PK | `(account_id, date)` | One row per account per day |

---

## 8.5 Live trading

### `broker_accounts`
Known broker account references (no passwords or credentials stored here).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | Internal label, e.g. `rh-trading`, `rh-agentic` |
| `broker` | text | `robinhood` \| `kite` |
| `account_role` | text | `trading-read-only` \| `agentic-orders-only` |
| `market` | text | |
| `enabled` | bool | |
| `live_account_source` | bool | Whether this is the source for `live_account_snapshots` |
| `notional_cap_usd` | numeric | Hard per-order cap |

### `live_account_snapshots`
One row per account (upserted, not history). Live Robinhood positions.

| Column | Type | Notes |
|---|---|---|
| `account_id` | text PK | Robinhood account ID (not human-readable role label) |
| `equity` | numeric | |
| `buying_power` | numeric | |
| `positions_json` | jsonb | Array of `{symbol, qty, avg_cost, current_price}` |
| `captured_at` | timestamptz | |

### `broker_order_events`
Append-only event log for every live broker order state transition (migration 139). Protected by `boe_block_mutation()` trigger — UPDATE and DELETE are blocked at the DB level.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `broker_order_id` | uuid | FK → `broker_orders` |
| `event_type` | text | e.g. `status_change`, `fill`, `cancel`, `reconcile` |
| `from_status` | text | Prior status |
| `to_status` | text | New status |
| `actor` | text | `owner` \| `cron` \| `autonomous_shadow` |
| `detail` | jsonb | Event-specific payload |
| `created_at` | timestamptz | |

### `broker_orders`
Immutable live order ledger. Never deleted.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `broker` | text | |
| `market` | text | |
| `symbol` | text | |
| `action` | text | `buy` \| `sell` |
| `qty` | numeric | |
| `order_id` | text | Broker-assigned order ID |
| `status` | text | `pending` \| `filled` \| `needs_reconcile` \| `failed` |
| `needs_reconcile` | bool | True when broker order ID is missing |
| `submitted_at` | timestamptz | |
| `filled_at` | timestamptz | |

### `trade_proposals`
TraderAgent / AutonomousShadow proposals. Auto-expire 30 minutes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | `us` \| `india` |
| `side` | text | `buy` \| `sell` |
| `order_type` | text | `market` \| `limit` |
| `qty` | numeric | |
| `limit_price` | numeric | |
| `analyst_score` | numeric | Score at proposal time |
| `estimated_value` | numeric | Kelly-sized notional (shadow only) |
| `pct_of_nav` | numeric | Fraction of live NAV (shadow only) |
| `price_at_proposal` | numeric | Quote price used for sizing (shadow only) |
| `thesis` | text | |
| `signal_id` | bigint | FK → `agent_signals` |
| `status` | text | `pending_review` \| `approved` \| `rejected` \| `expired` \| `queued_auto` \| `manual_review_required` |
| `execution_mode` | text | `manual` \| `autonomous_shadow` (migration 139) |
| `policy_snapshot` | jsonb | Full `LiveAutoPolicy` + kernel + sizing result snapshot |
| `auto_run_id` | text | `runAutonomousShadow` run ID |
| `auto_decided_at` | timestamptz | When the execution kernel evaluated this proposal |
| `expires_at` | timestamptz | `created_at + 30m` |
| `created_at` | timestamptz | |

### `decision_journal`
Audit log of every trade decision (live or paper).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | |
| `action` | text | |
| `rationale` | text | |
| `approved_by` | text | `owner` \| `auto` (auto not used; kept for schema compat) |
| `created_at` | timestamptz | |

---

## 8.6 Learning

### `learning_log`
LearnerAgent mutation audit log (not the same as trade outcomes).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `event_type` | text | `weight_change` \| `champion_promoted` \| `mutation_blocked` |
| `market` | text | |
| `detail` | jsonb | |
| `created_at` | timestamptz | |

### `signal_weights_history`
History of every signal weight change (rollback source).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `dimension` | text | |
| `old_weight` | numeric | |
| `new_weight` | numeric | |
| `changed_by` | text | |
| `created_at` | timestamptz | |

### `trade_memories`
pgvector store for RAG trade memory.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `paper_trade_id` | uuid | FK → `paper_trades` |
| `text` | text | Setup description: symbol, scores, outcome |
| `embedding` | vector(1024) | Jina `jina-embeddings-v3` embedding |
| `metadata` | jsonb | Symbol, market, outcome, exit_reason, mandate_id |
| `created_at` | timestamptz | |

---

## 8.7 Evidence & enrichment

### `evidence_records`
Immutable evidence ledger. `payload_hash` deduplicates re-imports.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `source` | text | `edgar_form4` \| `av_insider` \| `av_earnings` \| etc. |
| `payload` | jsonb | Raw evidence data |
| `payload_hash` | text | UNIQUE; SHA-256 of payload |
| `created_at` | timestamptz | Append-only. |

### `fundamental_facts`
Point-in-time (PIT) fundamentals vintage ledger (migration 150). Append-only: one immutable row per (symbol, market, report_period, restatement vintage). A later restatement of the same `report_period` inserts a NEW row with `restatement_seq = prev+1` and flips the prior row's `is_latest=false` — nothing is mutated in place, so "fundamentals as known on date D" is reconstructable and a restatement can never retroactively change a past as-of read. **OFF by default:** written by the capture-on-fetch hook in `lib/research-agent.ts` (fail-open), read via `lib/data/pit-fundamentals.ts::getFundamentalsAsOf`. Not yet wired into live scoring — `scoreFundamentals` is unchanged. RLS: `ff_service_all` (service_role ALL) + `ff_owner_read` (authenticated, owner email); anon REVOKEd.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | `us` \| `india` (CHECK) |
| `metric_set` | text | Default `ttm_overview` |
| `report_period` | date | Fiscal period end the values describe (null for TTM rollups) |
| `fiscal_period` | text | Q1/Q2/Q3/Q4/FY (nullable) |
| `filing_date` | date | When it became public (nullable → falls back to `captured_at`) |
| `values` | jsonb | OVERVIEW-shaped field map (`PERatio`, `ProfitMargin`, …) |
| `source` | text | `fmp` \| `alpha_vantage` \| `yahoo` \| `financialdatasets` |
| `restatement_seq` | int | 0 = as-first-observed; 1,2,… = later restatements |
| `is_latest` | bool | Default true; flipped false when a newer vintage of the same period lands |
| `payload_hash` | text | UNIQUE; dedup key for identical re-fetches |
| `captured_at` | timestamptz | Kairos vintage clock |

### `corporate_actions`
Stock splits + dividends from Alpha Vantage.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `action_type` | text | `split` \| `dividend` |
| `ex_date` | date | |
| `detail` | jsonb | |
| `created_at` | timestamptz | |

### `trade_decisions`
Historical Robinhood trade CSV imports + enrichment.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `action` | text | `buy` \| `sell` |
| `qty` | numeric | |
| `exec_price` | numeric | |
| `exec_date` | date | |
| `price_1d_after` | numeric | AV DAILY price lookup |
| `price_1w_after` | numeric | |
| `price_1m_after` | numeric | |
| `price_3m_after` | numeric | |
| `outcome_score` | numeric | `(price_1m_after - exec_price) / exec_price * 100` |
| `macro_market_regime` | text | Hardcoded epoch table |
| `enrichment_status` | text | `pending` \| `enriched` \| `no_data` |
| UNIQUE | `(symbol, action, exec_date, exec_price, qty)` | Cross-source dedup |

### `uploaded_trade_files`
Tracks CSV upload dedup (SHA-256 hash of file content).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `filename` | text | |
| `file_hash` | text | UNIQUE |
| `trade_count` | int | |
| `duplicate_count` | int | |
| `date_range_start` | date | |
| `date_range_end` | date | |
| `broker` | text | |
| `created_at` | timestamptz | |

---

## 8.8 Observability & ops

### `agent_runs`
One row per agent invocation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `agent_name` | text | |
| `market` | text | |
| `status` | text | `running` \| `completed` \| `error` |
| `started_at` | timestamptz | |
| `ended_at` | timestamptz | |
| `summary` | text | |
| `error` | text | |
| `created_at` | timestamptz | Pruned >60d by DB cleanup |

### `agent_alerts`
Open-issues funnel (System Health).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `issue_key` | text | Stable dedup key, e.g. `model-deprecated:deepseek-reasoner` |
| `severity` | text | `info` \| `warn` \| `error` \| `critical` |
| `category` | text | `model` \| `broker` \| `budget` \| `data` \| `ops` |
| `title` | text | |
| `detail` | text | |
| `structured_issues` | jsonb | Machine-readable: `{issue_key, root_cause, blast_radius, suggested_fix}` |
| `resolved` | bool | |
| `resolved_at` | timestamptz | |
| `auto_expire_at` | timestamptz | Self-expiring for budget alerts |
| `created_at` | timestamptz | |
| UNIQUE | `(issue_key) WHERE resolved = false` | At most one open row per issue |

### `llm_call_log`
Every LLM call: model, tokens, cost.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `agent_name` | text | |
| `model` | text | |
| `input_tokens` | int | |
| `output_tokens` | int | |
| `cost_usd` | numeric | |
| `created_at` | timestamptz | Pruned >90d by DB cleanup |

### `rag_traces`
Every vector retrieval — what memory influenced a decision.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | Symbol being scored |
| `query_text` | text | |
| `retrieved_ids` | jsonb | Array of `trade_memories.id` |
| `reranked_ids` | jsonb | Post-rerank IDs |
| `summary` | text | "3/5 prior setups were wins" note passed to LLM |
| `created_at` | timestamptz | Pruned >90d by DB cleanup |

### `briefings`
Daily briefing records (in-app + email).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `type` | text | `morning` \| `evening` |
| `content` | text | Full HTML/markdown content |
| `sent_at` | timestamptz | |
| `created_at` | timestamptz | Pruned >90d by DB cleanup |

### `newsletters`
Full email send history (inserted on successful Resend call).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `subject` | text | |
| `html_body` | text | |
| `resend_message_id` | text | |
| `nav_snapshot` | numeric | |
| `signals_count` | int | |
| `positions_count` | int | |
| `sent_at` | timestamptz | Pruned >90d by DB cleanup |

---

## 8.9 Mentor + coaching

### `mentor_insights`
MentorAgent's coaching notes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `insight_type` | text | `pattern` \| `lesson` \| `warning` |
| `content` | text | Plain-English coaching |
| `market` | text | |
| `symbols_mentioned` | text[] | |
| `created_at` | timestamptz | |

---

## 8.10 India-specific

### `kite_portfolio_cache`
NSE/BSE holdings snapshot from Kite API.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `holdings` | jsonb | Raw Kite portfolio response |
| `captured_at` | timestamptz | |

---

## 8.11 Historical replay harness (measure-only, OFF)

Four additive tables (migration 149) backing `features/historical-replay-harness`. Internal, server-side/offline analyst tooling — RLS enabled with **no policy** (service_role bypasses RLS; all other roles denied). The P0–P4 harness code (`lib/replay/*`) runs on in-memory fixtures and does **not** depend on these tables; they persist frozen point-in-time eligibility runs when the harness is wired to persist. `replay_packets`/`replay_packet_items` are write-once by convention (assembler deep-freezes in memory).

### `replay_packets`
One row per (cohort, symbol, as-of date); immutable after write. `manifest_hash` = sha256 over the frozen item set. UNIQUE `(cohort, symbol, as_of)`.

### `replay_packet_items`
The frozen inputs for a packet. `item_type ∈ {ohlcv, fundamental, news, universe}`. Invariant `knowable_at <= packet.as_of` (sealed accessor enforces at read; a backfill test asserts at write). FK → `replay_packets` ON DELETE CASCADE.

### `replay_eligibility_runs`
One row per replay execution. `packet_manifest_hash` + `code_git_sha` make a run reproducible from its frozen inputs and the gate code version. `model_kind` e.g. `pwin_logistic`.

### `replay_eligibility_events`
Per (run, scope, as-of) gate verdict. `gate ∈ {calibration_oos, thin_evidence, ic, validation, breakdown_veto}`; `passed` boolean. The reporter's `first_eligible_asof` is `MIN(as_of) WHERE passed` over this table. FK → `replay_eligibility_runs` ON DELETE CASCADE.

### `universe_snapshot_scores` (columns added — migration 151)
Cross-sectional rank provenance added to the migration-137 table: `rank_quality` (`ok` \| `degraded` \| `excluded_*`), `comparable_group_key` (`market:asset-type:sector`; ETFs never grouped with single names), `group_n` (eligible names in the final group that day), `rank_eligible` (passed §4.1 data-quality gates). All nullable/additive.

---

## 8.12 Benchmark Alpha + Capital Rotation Shadow

Migration `20260713143000_benchmark_alpha_rotation_shadow.sql` adds the Phase-1 benchmark-alpha measurement layer and the P0 capital-rotation shadow ledger. Both are deterministic. Benchmark-alpha writes analytics only; capital rotation records shadow opportunities only.

### `benchmarks`
Config rows for market-local benchmark definitions. One enabled primary benchmark per market is enforced by partial unique index. Seeded primaries: US `VOO` (USD) and India `^NSEI`/NIFTY 50 (INR). Owner can read through RLS; service routes write.

### `benchmark_price_observations`
Durable benchmark component price observations keyed by `(benchmark_id, component_symbol, date)`. The current scorecard route fills primary benchmark observations from existing `paper_performance.bench_nav` / `live_performance.bench_nav` ledgers. Missing/unpriceable data is surfaced in scorecard rows rather than skipped.

### `benchmark_scorecard`
Materialized multi-horizon rollup keyed by `(market,currency,book,book_scope,benchmark_id,horizon,as_of)`. Stores common-window portfolio return, benchmark return, excess return, daily tracking error, annualized daily information ratio, sample counts, coverage, confidence, and status. It never feeds orders or learner mutation in Phase 1.

### `rotation_config`
Per-market/per-book rotation flags and thresholds. `rotation_shadow_enabled=true` by default for measurement. `rotation_paper_execute_enabled=false` and `rotation_live_proposals_enabled=false`; no sell/buy/proposal execution is enabled by this migration.

### `rotation_events`
Append-only capital-rotation audit ledger. P0 inserts `planned` or `rejected` shadow events from PaperTrader's `insufficient_cash` branch. Trigger `rotation_events_block_mutation` blocks UPDATE/DELETE. Rows include candidate/source symbols, scores, edge, notional, gate results, and explicit `no_execution` audit data.

### `live_performance` provenance columns
Adds nullable/backfilled `market`, `currency`, `broker`, and `book_scope` so live scorecard rollups can aggregate only explicitly scoped same-market/same-currency rows.

---

## 8.13 Daily Per-Holding Risk Analytics (advisory, append-only)

Three additive tables (migration 154) backing `features/holding-risk-daily`. Owner-only SELECT (email RLS `(auth.jwt() ->> 'email') = 'vterminater@gmail.com'`), service_role writes, anon REVOKEd. Advisory-only: the risk score, posture, and LLM strategy note reach **no order path** for any account, including read-only `965848641`. **No cross-currency roll-up** — every row carries its own `market` + `currency`; USD and INR are never summed. Populated daily post-close by `/api/agents/holding-risk` (cron migration 156). Publish/claim via the migration-155 RPCs.

### `holding_risk_runs`
Claim/lifecycle header — one row per (`market` × `account_id` × `captured_on` × `formula_version` × `input_hash`) computation, identified by `run_key` (UNIQUE `holding_risk_runs_run_key_uniq`). Concurrent/retried crons race on that unique insert; the loser reads back the existing run. `status ∈ {running,complete,failed,partial}`; a failed run stays as evidence. Trigger `holding_risk_runs_lifecycle_guard()` blocks DELETE always, freezes identity/evidence columns, and lets `status` move **forward once** out of `running` only (never terminal→terminal). Partial index `holding_risk_runs_latest_idx (market, account_id, currency, formula_version, captured_on DESC) WHERE status='complete'` serves latest-complete lookups. Key cols: `broker`, `account_label`, `source_captured_at`, `completed_at`, `data_confidence` (0–1), `missing_inputs text[]`, `error`.

### `holding_risk_snapshots`
Append-only risk-data ledger — one row per run × holding (UNIQUE `(run_id, symbol)`; FK → `holding_risk_runs`). Trigger `holding_risk_append_only()` blocks **both** UPDATE and DELETE; a rerun is a new `run_id`, never a rewrite. Deterministic columns: `holding_risk_score int CHECK 0–100`, `risk_posture ∈ {hold,review,trim,exit_review,insufficient_data}`, `risk_drivers jsonb` (per-component detail), `action_reason`, `add_capacity boolean` (risk room exists — **NEVER an order signal**), `weight_pct ∈ [0,1]`, `beta`, `realized_vol_pct`, `unrealized_pnl_pct`, `data_confidence`, `missing_inputs`, `formula_version`. `strategy_note text` is the **LLM prose** — nullable, best-effort, never blocks, and cannot change the deterministic score/posture/action. Indexes: `holding_risk_snapshots_run_idx (run_id)`, `holding_risk_snapshots_symbol_idx (account_id, symbol, captured_on DESC)`.

### `account_risk_snapshots`
Append-only per-account roll-up — one row per run (UNIQUE `(run_id)`; FK → `holding_risk_runs`). Same `holding_risk_append_only()` UPDATE/DELETE block. `metrics jsonb` persists the RiskMetrics roll-up for Δ-vs-prior trend; `total_value` (own-currency, never cross-summed), `data_confidence`, `missing_inputs`, `formula_version`. Index `account_risk_snapshots_latest_idx (market, account_id, currency, formula_version, captured_on DESC)`.

---

## Migration history summary

| Migration range | Key tables / changes |
|---|---|
| 001–020 | Core: profiles, auth, strategy_config, agent_signals, paper_portfolio, paper_positions, paper_trades, watchlist |
| 021–030 | paper_positions exit columns, strategy_config risk profile, macro_regime + macro_signals |
| 031–040 | agent_config, learner_config + learning_priors, paper_order_events (trigger), evidence_records, strategy_versions + experiment_runs, trade_proposals + decision_journal |
| 041–050 | uploaded_trade_files + trade_decisions, live_account_snapshots, agent_runs |
| 051–060 | signal_score_history (054), india_screen_cache (058), multi-market market column on paper_portfolio/positions/trades/performance |
| 061–099 | broker_accounts, api_key_vault, llm_call_log, rag_traces, mentor_insights, edge_signals, edge_ic_history, learning_priors_history |
| 099 | agent_alerts.issue_key + partial unique index |
| 126–128 | PaperTrader standalone cron: signal freshness gate, claim_run_id, expected_price + realized_slip_pct + fill_status on positions + trades |
| 133–135 | investment_mandates + strategy_evaluations (append-only trigger), mandate_id column on agent_signals + paper_trades + decision_observations |
| 136 | agent_signals: `score_source` + `scoring_version`; decision_observations: 10 summary cols + NOT VALID range guards; strategy_versions: 3 new lifecycle states (`measure_only`, `live_review_eligible`, `live_approved`) |
| 137 | universe_snapshots + universe_snapshot_scores tables (cross-sectional rank, measure-only) |
| 138 | shadow_decisions: `policy_version_id` drops NOT NULL; `setup_type text` col + index (archetype shadow rows) |
| 139 | strategy_config: +8 `live_auto_*` cols; trade_proposals: +4 autonomous cols + status constraint expanded (`queued_auto`, `manual_review_required`); broker_order_events: new append-only table + `boe_block_mutation()` trigger blocking UPDATE/DELETE |
| 140 | `reserve_live_order_budget_v2` RPC — adds `p_execution_actor` param; `approved_by_user=(actor='owner')`; counts `unknown_needs_reconcile`+`partially_filled` in daily budget; REVOKE public/anon/authenticated, GRANT service_role only |
| 141 | strategy_config: `live_auto_mode_us`/`live_auto_mode_india` (off/manual/autonomous); trade_proposals: `market` col + index |
| 142 | RLS: owner-scope the `USING(true)` authenticated SELECT policies on trade_proposals/strategy_config/paper_trades/decision_journal/deep_analyses/mentor_insights/trade_decisions/uploaded_trade_files |
| 143 | **Restore** (idempotent) the out-of-band 139/140 objects so a clean DB rebuilds: trade_proposals autonomous cols, broker_orders reservation cols, broker_order_events table+trigger+RLS, `reserve_live_order_budget_v2` RPC — exact prod DDL |
| 144 | RLS: owner-scope corporate_actions/evidence_records/experiment_runs/paper_order_events/strategy_versions/trade_decision_embeddings; enable service-only RLS on universe_snapshots/_scores |
| 145 | Unique partial index `trade_proposals(signal_id,market) WHERE execution_mode='autonomous_live'` — atomic autonomous signal claim (no double-propose/buy) |
| 146 | `symbol_blocklist` table (owner-curated tradable-universe blocklist; leveraged/inverse ETFs auto-blocked in code) + RLS (service + owner-read) |
| 147 | Phase-1 repair (idempotent): `strategy_config` live_auto_* cols restore + REVOKE PUBLIC from `reserve_live_order_budget_v2` (no-op on prod; clean-rebuild reproducibility) |
| 148 | Live kill-switches + sell atomicity: partial unique index `trade_proposals_active_sell_uniq (symbol,market) WHERE sell + active` |
| 149 | Historical replay harness: 4 additive tables `replay_packets`, `replay_packet_items`, `replay_eligibility_runs`, `replay_eligibility_events`; RLS enabled, no policy (service-only). Measure-only, OFF |
| 150 | PIT fundamentals: `fundamental_facts` append-only vintage ledger; UNIQUE `payload_hash`; RLS `ff_service_all` + `ff_owner_read`, anon REVOKEd. Index note: `captured_at::date` cannot go in an index expr (not IMMUTABLE) — indexed as plain `(symbol,market,filing_date DESC,captured_at DESC)`, COALESCE applied in-query. OFF (capture-on-fetch, fail-open) |
| 151 | Cross-sectional rank: `universe_snapshot_scores` +`rank_quality`/`comparable_group_key`/`group_n`/`rank_eligible`; `agent_signals` +`rank_pct`/`rank_rejected` (+ `rank_pct ∈ [0,1]` NOT VALID→validated check); status `rank_rejected`. Additive, OFF by default (genome `entry.rank_pct_min` default 0.0) |
| 154 | **Daily Per-Holding Risk**: 3 additive append-only tables `holding_risk_runs` (lifecycle guard: DELETE blocked, identity frozen, status forward-once out of `running`), `holding_risk_snapshots` + `account_risk_snapshots` (UPDATE+DELETE blocked). Owner-email SELECT RLS + service-role writes, anon REVOKEd. Advisory-only, no order path; no cross-currency roll-up |
| 155 | Daily Per-Holding Risk RPCs: claim-run (unique `run_key` insert, loser reads back) + publish-run (running→terminal transition with snapshots) — SECURITY DEFINER, service_role only |
| 165 | `watchlist.market` (text NOT NULL default `US`) — route code read/wrote it for months but the column never existed; GET 500'd (panel "0 tracked") + every manual add failed. Backfills India from `.NS/.BO` |
| 166 | LLM config data fix: rewrite invalid `deepseek-v4-flash/pro` → `deepseek-chat`/`deepseek-reasoner` in `agent_config`; seed `research`/`trader`/`mentor-evaluate`/`mentor-thesis`/`mentor-ask` rows (per-flow model from Settings) |
| 167 | `strategy_config` +`trading_style` (default `position`) +`target_hold_days` — Trading Style presets (Swing/Position/Long-term); horizon governs the time-stop only before a champion is promoted |
| 169 | `live_performance` (`account_id`,`date`,`equity`,`bench_nav`, PK`(account_id,date)`) - real daily equity curve per live broker account for the Live-vs-VOO chart; accrued forward on each snapshot refresh (RH exposes no account-value history). Initial migration used broad authenticated SELECT; `20260713112754_tighten_live_performance_rls` tightens it to owner-email SELECT, service-role writes |
| 170 | **Automated strategy validation**: `strategy_validation_automation` (per-market `enabled`/`auto_shadow_enabled`/`max_active_shadows 0-1`, owner-read RLS, seeded us+india enabled) + `activate_strategy_shadow(bigint)` SECURITY DEFINER RPC (service_role only) that atomically routes a PASSED challenger to `shadow_paper` under a per-market advisory lock + capacity cap. Also schedules pg_cron `kairos-validation-sweep` (Fri 21:45 UTC). Cannot promote/execute — shadow only |
| 171 | `market_controls` (`market` pk us/india, `paused`, `trading_enabled`, `paused_reason`, `paused_at`) — per-market pause/kill so one market's breaker no longer halts the other. Global `strategy_config.app_paused`/`trading_enabled` retained as a master-kill. Helpers in `lib/market-controls.ts`; owner-read RLS, service-role writes; seeded from current global flags |
| 172 | `research_queue` (pk `(market,symbol)`, `priority`, `attempts`, `discovery_source`, `deferred_at`) — research candidate carry-forward: candidates beyond a run's cap are deferred here with raised priority (starvation-free) instead of the old silent `.slice()` drop, so a growing watchlist/screener pool rotates fairly under provider budgets. Helper `lib/research-queue.ts`; owner-read RLS, service-role writes |
| 173 | `oauth_pkce_state` - server-side one-time PKCE verifier store keyed by `state` + `provider` for generic MCP broker OAuth callbacks. Callback consumes by provider-scoped delete-and-return, so replay/race callbacks cannot reuse a verifier |
| 174 | Live snapshot broker framework - `live_account_snapshots.broker` labels rows by source broker and the registry MCP refresh path auto-adds connected accounts. Pruning is broker-scoped and only runs after a successful non-empty capture, never after an outage or empty result |
| 175 | `strategy_sleeves` + `strategy_config.allocation_enabled` - deterministic asset-allocation proposal core. Shipped OFF by default; callers return null unless `allocation_enabled=true`. Sanitizes malformed bands/targets and never routes to orders |
| 20260713112754 | RLS tightening for `live_performance`: drops broad authenticated read policy and replaces it with owner-email SELECT (`(select auth.jwt()) ->> 'email' = 'vterminater@gmail.com'`) |
| 20260713143000 | Benchmark-alpha scorecard tables (`benchmarks`, `benchmark_price_observations`, `benchmark_scorecard`), `live_performance` provenance columns, capital-rotation shadow config/events (`rotation_config`, append-only `rotation_events`), and pg_cron `kairos-benchmark-scorecard` |
