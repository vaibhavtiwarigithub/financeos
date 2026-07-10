# Kairos — Database Schema
> Last updated: 2026-07-10 (migrations 136-140 documented; live_auto_* schema, broker_order_events, trade_proposals autonomous cols)
> Update this file when: any migration adds, removes, or modifies a table, column, index, trigger, or RLS policy.

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
| `risk_profile` | text | `Balanced` | `Conservative` \| `Balanced` \| `Aggressive` |
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
| `status` | text | `pending` \| `filled` \| `expired` \| `claimed` |
| `claim_run_id` | uuid | FK → `agent_runs`; prevents double-fill |
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
| `symbol` | text | UNIQUE |
| `market` | text | |
| `asset_class` | text | |
| `added_by` | text | `user` \| `theme-scout` \| `system` |
| `theme_tag` | text | e.g. `ai_infrastructure` |
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
