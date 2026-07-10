# Kairos — Deep Architecture Reference

> **Purpose:** Implementation-level detail for every agent, subsystem, and data flow.
> Read ARCHITECTURE_C4.md first for the structural map. This doc answers *how* each
> piece works internally — exact models, formulas, API calls, DB columns, and logic.
>
> Last updated: 2026-07-10

---

## Table of Contents

1. [Complete Cron Schedule](#1-complete-cron-schedule)
2. [LLM Router — Full Internals](#2-llm-router--full-internals)
3. [All 12 Agents — Deep Detail](#3-all-12-agents--deep-detail)
   - 3.1 MacroSentinel
   - 3.2 ResearchAgent
   - 3.3 DeepSeekAgent
   - 3.4 ThemeScout
   - 3.5 PaperTrader
   - 3.6 PositionMonitor
   - 3.7 TraderAgent
   - 3.8 LearnerAgent
   - 3.9 MentorAgent
   - 3.10 HealthTriage
   - 3.11 BriefingAgent
   - 3.12 Watchdog
4. [5-Dimension Scoring Engine](#4-5-dimension-scoring-engine)
5. [Validation Engine](#5-validation-engine)
6. [Autonomy Ladder](#6-autonomy-ladder)
7. [RAG Trade Memory — Full Pipeline](#7-rag-trade-memory--full-pipeline)
8. [Robinhood MCP Client](#8-robinhood-mcp-client)
9. [Zerodha Kite Connect](#9-zerodha-kite-connect)
10. [India vs US — Side-by-Side Stack](#10-india-vs-us--side-by-side-stack)
11. [Complete API Route Map](#11-complete-api-route-map)
12. [Database Schema — All Tables](#12-database-schema--all-tables)
13. [System Health Funnel — All Reporters](#13-system-health-funnel--all-reporters)
14. [Performance Truth Layer](#14-performance-truth-layer)
15. [Champion/Challenger Governance](#15-championchallenger-governance)
16. [Error Handling Catalogue](#16-error-handling-catalogue)

---

## 1. Complete Cron Schedule

All jobs run via **Supabase pg_cron → Vercel HTTP POST** except `db-backup` (Windows Task
Scheduler — Vercel serverless cannot shell out to `pg_dump`). Times are US-Eastern; pg_cron
itself runs UTC (add 4h EDT / 5h EST). Source of truth: `lib/schedule.ts`.

### Weekday Daily Jobs

| Job name | Time (ET) | Endpoint | What it does | Feeds next |
|---|---|---|---|---|
| `scan-india-refresh` | 6:45 AM | `POST /api/scan/india/refresh` | Rotates ~600 NSE names/run through pre-score cache so India scanner sees full market | → ResearchAgent India |
| `macro-read-us` | 9:30 AM | `POST /api/agents/macro-read?market=us` | Plain-English macro-to-holdings read (US). One cheap LLM call/day. Advisory. | → Markets page card |
| `research` | 9:00 AM | `POST /api/agents/research/cron?market=us` | Pre-market US signal generation. Scores holdings (SELL allowed) + dual-bucket screener (LONG only). Also auto-fires ThemeScout. | → PaperTrader US |
| `trader` | 9:45 AM | `POST /api/agents/trader` | TraderAgent turns qualifying signals into sized proposals. `approval_required=true` always. | → PositionMonitor |
| `paper-trade-us` | 10:05 AM | `POST /api/agents/paper-trade?market=us` | Standalone US paper fill (primary path, decoupled from research). Freshness gate: only same-day (America/New_York) pending long signals. | → PositionMonitor |
| `broker-sync` | Every 30 min 9:30–4:00 PM | `POST /api/agents/watchdog?mode=sync` | Polls broker for order-status updates, reconciles positions. | — |
| `proposal-reminder` | Every 15 min 9:00–5:00 PM | `POST /api/alerts/proposal-reminder` | Checks pending proposals nearing 30-min expiry, nudges before lapse. | — |
| `position-monitor` | 4:15 PM | `POST /api/agents/position-monitor?market=us` | End-of-day exit + stop checks (US). Trailing stop, price target, time stop, score drop. | → LearnerAgent |
| `brief-evening` | 4:30 PM | `POST /api/briefing/generate?market=us` | Evening P&L summary, realized/unrealized, exits, what to watch tomorrow. | — |
| `rescore` | 4:45 PM | `POST /api/agents/rescore-check` | Re-scores recent signals against realized outcomes to detect scoring drift. | — |
| `embed` | 4:50 PM | `POST /api/agents/rag-backfill` | Refreshes RAG embeddings — vectorizes new signals, notes, closed-trade summaries. | — |
| `nav-snapshot` | 5:00 PM | `POST /api/agents/performance` | Daily NAV + alpha snapshot. Records end-of-day NAV, benchmark, computed alpha. | — |
| `label-maturation` | 6:00 PM | `POST /api/agents/label-maturation` | Phase 1 learning-core: matures `decision_observations` into `observation_labels` once forward horizon (2/5/10/20d) has passed. | → Validation Engine |
| `stale-check` | Every 4 hours | `POST /api/alerts/stale-check` | Verifies each agent ran on time. Raises `agent_alerts` if cron gone silent. | — |
| `watchdog` | Every 2 hours | `POST /api/agents/watchdog` | Reaps zombie `agent_runs` (stuck >15min), reverts orphaned `claiming` signals to `pending`, expires stale pending signals per market-local day. Never touches money/ledgers. | — |
| `brief-morning` | 10:00 AM | `POST /api/briefing/generate?market=us` | Morning briefing email — fires AFTER research so it reflects real signals (moved from 8 AM). | — |

### India-Specific Weekday Jobs

| Job name | Time | Endpoint | What it does |
|---|---|---|---|
| `research-india` | 9:30 AM IST (~12:00 AM ET) | `POST /api/agents/research/cron?market=india` | India signal gen, 15min after NSE 9:15 AM open. Scores off yesterday's close then chains ₹ paper-trade fill inline. |
| `paper-trade-india` | 4:35 PM IST (~7:05 AM ET) | `POST /api/agents/paper-trade?market=india` | Standalone India ₹ paper fill backstop. Same freshness gate (Asia/Kolkata calendar day). |
| `position-monitor-india` | 7:15 AM ET | `POST /api/agents/position-monitor?market=india` | Exit/stop checks for open India positions. |
| `brief-morning-india` | 9:50 AM IST (~12:20 AM ET) | `POST /api/briefing/generate?market=india` | India morning briefing (fires 20min after research-india). |
| `brief-evening-india` | 4:30 PM IST (~7:00 AM ET) | `POST /api/briefing/generate?market=india&period=evening` | India evening summary, 45min after position-monitor-india. |
| `macro-read-india` | 10:00 AM IST | `POST /api/agents/macro-read?market=india` | India macro-to-holdings read. Same cheap daily call, scoped to India book. |

### Weekly Jobs (Fridays)

| Job name | Time (ET) | What it does |
|---|---|---|
| `feature-check` | 4:30 PM | Phase 3 learning-core: weekly feature-registry IC check (proposed → quarantined → active/retired). |
| `fit-calibration` | 4:45 PM | Phase 2 learning-core: weekly refit of calibrated P(win) sizing model per market (dormant until 60+ matured labels). |
| `learner-india` | 3:30 PM | LearnerAgent over India closed-trade cohort. Proposes India-specific challengers only. |
| `learner` | 5:00 PM | LearnerAgent over US closed trades. Proposes US champion challengers. Requires ≥10 closed trades. |
| `mentor-coach` | 5:15 PM | MentorAgent (DeepSeek reasoner) reads behavior + learning progress + regime. Writes personalized coaching to `mentor_insights`. |

### Monday-Only Jobs

| Job name | Time (ET) | What it does |
|---|---|---|
| `macro-sentinel` | 8:30 AM | Weekly 8-indicator danger score + regime. Advisory only. |
| `model-check` | 7:30 AM | Diffs `agent_config` model assignments vs provider live model lists. Informational. |

### Always-On (Vercel cloud crons)

| Job name | Schedule | What it does |
|---|---|---|
| P1 gate | Sundays 02:00 UTC | Counts closed evaluable trades. Fires info alert when ≥20. |
| DB cleanup | 1st of month 03:00 UTC | Prunes 15 safe tables (never touches ledgers). |

### Local Only

| Job name | Time | What it does |
|---|---|---|
| `db-backup` | 3:00 AM local | Nightly `pg_dump` via PowerShell. Requires `SUPABASE_DB_URL`. |

---

## 2. LLM Router — Full Internals

File: `lib/llm-router.ts`

### Tier Alias Map

Callers (and `agent_config` rows) may store either a concrete model ID or a tier alias.
`resolveModel()` converts alias → concrete at call time. One-line change here upgrades
every agent that uses the alias.

```
fast          → deepseek-v4-flash
reasoning     → deepseek-v4-pro
claude-fast   → claude-haiku-4-5-20251001
claude-smart  → claude-sonnet-4-6
```

### Task → Default Model Routing

```
research   → claude-sonnet-4-6
trade      → claude-sonnet-4-6
evaluate   → claude-sonnet-4-6
thesis     → claude-sonnet-4-6
optimize   → claude-haiku-4-5-20251001
screen     → deepseek-v4-flash
chat       → deepseek-v4-flash
summarize  → deepseek-v4-flash
```

### Pricing Table (per 1M tokens, [input, output] USD)

| Model | Input | Output |
|---|---|---|
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-haiku-4-5-20251001 | $0.25 | $1.25 |
| claude-opus-4-8 | $5.00 | $25.00 |
| deepseek-v4-flash | $0.07 | $0.28 |
| deepseek-v4-pro | $0.55 | $2.19 |
| Groq (all models) | $0.00 | $0.00 |

**Cache pricing (Claude only):**
- Cache write: 1.25× input rate (first call fills the cache)
- Cache read: 0.10× input rate (all subsequent calls in 5-min TTL)
- System prompts sent with `cache_control: { type: "ephemeral" }` automatically

### Same-Tier Fallback Chain

When a model is deprecated/unavailable, the router falls back to the same-tier sibling
(never a capability downgrade), fires a persistent `agent_alerts` issue, and the run
completes rather than hard-failing.

```
deepseek-chat        → deepseek-v4-flash
deepseek-reasoner    → deepseek-v4-pro
deepseek-v4-flash    → deepseek-v4-pro
deepseek-v4-pro      → deepseek-v4-flash
claude-sonnet-4-6    → claude-haiku-4-5-20251001
claude-haiku-*       → claude-sonnet-4-6
claude-opus-4-8      → claude-sonnet-4-6
```

If `ANTHROPIC_API_KEY` is missing entirely, all Claude calls fall back to `deepseek-v4-flash`
and fire a `critical` system health alert.

### Two Entry Points

**`callLLM(opts)`** — single-shot completion. Dispatches by model prefix:
- `claude*` → Anthropic SDK (with `cache_control` on system prompt)
- `deepseek*` → DeepSeek chat completions REST API (OpenAI-compatible)
- Groq models → Groq OpenAI-compatible REST API
- Falls back to `execClaude` subprocess if SDK key missing (last resort)

**`runAgentLoop(opts)`** — multi-turn tool-use loop. Up to 12 iterations.
- `claude*` → Anthropic tool-use blocks (`tool_use` / `tool_result`)
- everything else → DeepSeek OpenAI function-calling (`tool_choice: "auto"`)
- 120s timeout per iteration (`AbortSignal.timeout(120_000)`)
- Terminates when `finish` tool is called OR model stops requesting tools

Both paths:
1. Wrap in a Langfuse trace/generation (no-op if keys absent)
2. Write to `llm_call_log` table (model, task, tokens_in/out, cost_usd, duration_ms, success, agent_label, run_id)
3. Use vault-first key resolution: `getProviderKey()` → vault → env fallback

---

## 3. All 12 Agents — Deep Detail

### 3.1 MacroSentinel

**Endpoint:** `POST /api/agents/macro-sentinel`
**Schedule:** Mondays 8:30 AM ET (Supabase pg_cron)
**Model:** `deepseek-v4-flash` (fast, simple classification)
**Purpose:** Weekly recession early-warning read. Advisory only — never auto-throttles agents or halts trading.

**8 Alpha Vantage indicators fetched:**

| Indicator | AV Function | What it measures | Danger contribution |
|---|---|---|---|
| Yield Curve | `TREASURY_YIELD` (10Y minus 2Y) | Inversion signals recession | High weight |
| Sahm Rule proxy | `UNEMPLOYMENT` (delta 3-month vs 12-month avg) | Labor market deterioration | High weight |
| Real GDP | `REAL_GDP` (QoQ growth) | Economic contraction | Medium weight |
| Nonfarm Payrolls | `NONFARM_PAYROLL` (MoM change) | Employment momentum | Medium weight |
| CPI | `CPI` (YoY inflation) | Price pressure / Fed response | Medium weight |
| Retail Sales | `RETAIL_SALES` (MoM change) | Consumer spending | Low weight |
| Federal Funds Rate | `FEDERAL_FUNDS_RATE` | Rate environment | Low weight |
| Durable Goods | `DURABLES` (MoM orders) | Business investment | Low weight |

**Danger score → Regime:**

| Score | Regime | Dashboard color |
|---|---|---|
| 0–24 | GREEN | No banner |
| 25–49 | YELLOW | Yellow banner on DashboardHome |
| 50–74 | ORANGE | Orange banner |
| 75–100 | RED | Red banner |

**Outputs:**
- `macro_regime` table row: `{ regime, danger_score, computed_at }`
- `macro_signals` table rows: one per indicator `{ regime_id, indicator, raw_value, contribution, direction }`
- `agent_runs` row (type: `macro_sentinel`)

**Why advisory-only:** Auto-throttle without user seeing first run creates surprising behavior. User reviews regime, then decides to act.

---

### 3.2 ResearchAgent

**Endpoint:** `POST /api/agents/research/cron?market=us|india`
**Schedule:** US: 9:00 AM ET weekdays; India: 9:30 AM IST weekdays
**Model:** `claude-sonnet-4-6` for thesis; all scoring is deterministic TypeScript
**Primary files:** `lib/research-agent.ts`, `lib/data/scores.ts`, `lib/data/technicals.ts`

**Pipeline (in order):**

**Step 1 — Gather symbols**
- Fetch all Robinhood account holdings from `live_account_snapshots` (ALL accounts, not filtered — SELL signals allowed for any held symbol)
- Fetch `watchlist` table (`research_enabled=true` rows)
- Run dual-bucket screener (≤3 new candidates/day):
  - **Momentum bucket:** RSI > 60, price > 50d MA, revenue acceleration, positive earnings revision (via `FinancialDatasets.screen_stocks`)
  - **Value bucket:** P/E < sector median, high FCF yield, insider buying, recent analyst upgrades
- Combine: holdings first (highest priority), then watchlist, then screener candidates

**Step 2 — Score each symbol (deterministic, no LLM)**

```
analyst_score = Σ (dimension_score × effective_weight)
```

Five dimensions, each 0–100:

| Dimension | Data source | What it computes |
|---|---|---|
| `fundamental_score` | Alpha Vantage `OVERVIEW` (US) or Yahoo `quoteSummary` (India) | P/E vs sector, revenue growth QoQ, profit margin, ROE, debt/equity ratio |
| `technical_score` | AV `RSI`(14) + `EMA`(20,50) + candles from Massive/Yahoo | RSI position, price vs 20/50 EMA, momentum from 20-bar candle series |
| `sentiment_score` | AV `NEWS_SENTIMENT` (US only; India = neutral baseline flagged) | Weighted ticker sentiment score from last 50 articles |
| `macro_score` | `macro_regime` table (written by MacroSentinel) | Maps GREEN→80, YELLOW→60, ORANGE→40, RED→20 |
| `insider_score` | AV `INSIDER_TRANSACTIONS` (US); NSE corporates-pit (India) | 90-day buy/sell ratio by insider role (C-suite weighted higher) |

**Weights:** Read from current champion's `weights_snapshot`. Fall back to `signal_weights` table, then static `PROFILE_WEIGHTS` (risk_profile-keyed). The loop is CLOSED: LearnerAgent → promoted challenger → ResearchAgent reads new weights on next run.

**Missing dimension handling:** `computeWeightedAnalystScore()` (`lib/scoring/weighted-score.ts`) renormalizes weights across only available dimensions. India skips sentiment/options/insider — those are neutralized and flagged in score detail. Thin evidence gate: `< 2` included dimensions → score flagged as `data_confidence < 0.5`.

**Step 3 — RAG retrieval (before thesis)**
- Embed live symbol setup with Voyage `voyage-3.5`
- Nearest-neighbor query on `trade_memories` pgvector (cosine ANN, top 10)
- Rerank with Voyage `rerank-2` → top 5
- Inject summary into thesis prompt: `"prior similar setups: 3/5 wins, avg pnl +14%"`
- Write `rag_traces` row for audit

**Step 4 — Score trend injection**
- Read last 5 rows from `signal_score_history` for this symbol
- Compute trend: `[48, 52, 61] → now 67 (rising, +19)`
- Inject into thesis prompt alongside RAG summary

**Step 5 — Thesis generation (Claude Sonnet 4.6, 512 tokens)**
- Receives: all 5 scores + evidence + RAG summary + score trend
- Produces: 1-paragraph thesis + direction (`long` | `short` | `neutral`)
- **Never generates scores** — text only

**Step 6 — Write outputs**
- `agent_signals`: `{ symbol, analyst_score, direction, thesis, signal_breakdown (5-dim), status: "pending", market, claim_run_id: null }`
- `signal_score_history`: append-only row with all 5 dimension scores
- `decision_observations`: every candidate scored, even skipped ones (needed for validation replay)
- `rag_traces`: query text, retrieved IDs, reranked IDs, summary text

**Outputs also consumed by:**
- PaperTrader (reads `agent_signals` where `status="pending"` and `analyst_score ≥ score_threshold`)
- Validation Engine (replays `decision_observations` with different weight sets)
- LearnerAgent (reads outcomes of signals it proposed)
- ScoreTrajectory chart (`signal_score_history`)

---

### 3.3 DeepSeekAgent

**Endpoint:** `POST /api/agents/deepseek-research?market=us|india`
**Schedule:** Same as ResearchAgent (separate pg_cron task)
**Model:** `deepseek-v4-flash`
**Purpose:** Runs identical 5-dim scoring pipeline in parallel with ResearchAgent. Writes signals to `agent_signals` with `agent_label = "deepseek"`. Enables Claude vs DeepSeek P&L comparison on `/dashboard/agents` → Experiments tab.

---

### 3.4 ThemeScout

**Endpoint:** `POST /api/agents/theme-scout`
**Schedule:** Auto-fired by ResearchAgent at end of its run (Sundays 8 PM originally, now chained)
**Model:** `deepseek-v4-flash`
**Purpose:** Reads Alpha Vantage `NEWS_SENTIMENT` by sector. Identifies emerging themes (e.g. "AI infrastructure buildout", "GLP-1 drug demand"). Adds theme-tagged symbols to `watchlist` with `why_added` explaining the theme. These bubble up in the Watchlist page with always-visible reason labels.

**Outputs:**
- `watchlist` rows: `{ symbol, theme_tag, why_added, source: "theme_scout", research_enabled: true }`
- `agent_runs` row

---

### 3.5 PaperTrader

**Endpoint:** `POST /api/agents/paper-trade?market=us|india`
**Schedule:** US: 10:05 AM ET; India: 4:35 PM IST (both standalone) + inline chain from ResearchAgent
**Model:** None — fully deterministic
**Primary files:** `app/api/agents/paper-trade/route.ts`, `lib/paper/lot-math.ts`

**Pipeline:**

**Gate 1 — Freshness gate**
Only fills signals created TODAY in the market's own timezone:
- US: `America/New_York` calendar day
- India: `Asia/Kolkata` calendar day

Older pending signals → set `status = "expired"`. This prevents the cron catching up to multi-day backlog after downtime.

**Gate 2 — Claim-and-fill (atomic CAS)**
Before filling any signal, stamp `claim_run_id = <uuid>` on the `agent_signals` row:
```sql
UPDATE agent_signals SET claim_run_id = $1
WHERE id = $2 AND claim_run_id IS NULL
```
Zero rows updated → another process already claimed it → skip. This prevents double-fills when research's chained fill and the standalone cron run simultaneously.

**Gate 3 — Risk gates**
- **Re-entry cooldown:** Block if same symbol had a position closed in the last 5 days
- **Long-only enforcement:** BUY only for new positions; SELL only if currently held in `paper_positions`
- **Pyramid gate:** For adding to an existing position, fill price must exceed `avg_cost` (no averaging down)

**Gate 4 — Position sizing**
```
size_pct = champion_genome.position_size_pct  (e.g. 10%)
notional = paper_portfolio.cash × (size_pct / 100)
shares    = floor(notional / fill_price)
fill_price = mid_price × 1.0005  (0.05% slippage model)
```
Pool: US uses USD cash; India uses INR cash. Pools never blend.

**Gate 5 — Write fill**
- `paper_positions`: new row `{ symbol, market, shares, avg_cost, opened_at, price_target, stop_loss, highest_price }`
- `paper_trades`: buy leg `{ side: "buy", fill_price, shares, realized_pnl: null, outcome: null }`
- `paper_order_events`: two rows — `{ event_type: "submitted" }` then `{ event_type: "filled" }` (append-only, immutable by DB trigger)
- `paper_portfolio`: debit cash `cash -= (shares × fill_price)`
- `agent_signals`: `status = "filled"`, `claim_run_id` remains

**NAV Circuit Breaker (inside PaperTrader):**
If weekly paper NAV return < −5%: set `strategy_config.app_paused = true` + fire `critical` `agent_alerts` row with `issue_key = "nav-drawdown-circuit-breaker:<market>"`.

---

### 3.6 PositionMonitor

**Endpoint:** `POST /api/agents/position-monitor?market=us|india`
**Schedule:** US: 4:15 PM ET; India: 7:15 AM ET (both post-market-close)
**Model:** None — fully deterministic
**Primary files:** `app/api/agents/position-monitor/route.ts`, `lib/paper/nav-math.ts`

**Per-position exit engine (priority order):**

1. **Time stop:** `age_days > champion_genome.horizon_days` → close at market price
2. **Trailing stop:** `current_price < highest_price × 0.93` → close. Stop level = `max(original_stop_loss, highest_price × 0.93)`
3. **Price target (partial):** `current_price ≥ price_target` → sell half shares, move stop to breakeven (`stop_loss = avg_cost`)
4. **Score drop:** `agent_signals.analyst_score` for this symbol dropped below exit threshold → close (thesis invalidated)
5. **LLM exit flag:** `paper_positions.exit_reason = "llm_exit"` set by LearnerAgent phase A → close

**On each monitored position (no close):**
- Update `paper_positions.highest_price = max(highest_price, current_price)`
- Fetch fresh price from Alpha Vantage (US) or Yahoo Finance (India)

**On close:**
- Update `paper_positions`: set `closed = true`, `closed_at`, `exit_reason`, `exit_price`
- Update matching open `paper_trades` row: set `exit_price`, `realized_pnl`, `pnl_pct`, `outcome ("win"|"loss")`
- Fire RAG indexer: `indexClosedTrade()` → embed setup text → store in `trade_memories`

**Benchmark sync:**
- Upsert `paper_performance.bench_nav` with today's VOO close (US) or ^NSEI (India)
- Used for alpha computation: `alpha = paper_nav_return - bench_nav_return`

**RAG indexer on close:**
```
text = "{symbol} fundamental={f} technical={t} sentiment={s} macro={m} insider={i}
        direction={dir} outcome={win|loss} exit_reason={reason} pnl_pct={pct}"
embed with voyage-3.5 → INSERT trade_memories { text, embedding[1024], metadata }
```

---

### 3.7 TraderAgent

**Endpoint:** `POST /api/agents/trader`
**Schedule:** 9:45 AM ET weekdays
**Model:** `claude-sonnet-4-6`
**`approval_required = true` always — never auto-places live orders**

Turns qualifying research signals (score ≥ threshold) into sized **proposals** stored in `trade_proposals`. Owner reviews proposals on `/dashboard/agents` → Proposals tab within 30 minutes (hard expiry).

**Approve flow:** `POST /api/agents/trade/approve` → calls Money-Safety Gateway (all 9 gates) → if all pass → `place_equity_order` via Robinhood MCP client. Writes `broker_orders` row.

**Reject flow:** `POST /api/agents/trade/reject` → marks `trade_proposals.status = "rejected"`, writes `decision_journal` row.

**Account hardcoded:** Only `605420660` (agentic account) may receive orders. All other accounts are read-only.

---

### 3.8 LearnerAgent

**Endpoint:** `POST /api/agents/learner?market=us|india`
**Schedule:** Fridays 5:00 PM ET (US), 3:30 PM ET (India)
**Model:** `claude-opus-4-8` (89.08% AIMultiple Finance benchmark — best reasoning value)
**Tool-use loop:** `runAgentLoop()` in `lib/llm-router.ts`, up to 12 iterations, 120s timeout per step

**Phase Gate (checked before any mutation):**
```
SELECT count(*) FROM paper_trades WHERE market=$1 AND outcome IS NOT NULL
→ if < 10: return early ("insufficient data")
```

**Auto-Guard:**
```
SELECT win_rate FROM last 3 learner experiment_runs WHERE market=$1
→ if win_rate < 35%: return early ("bad run streak — skip mutation")
```

**9-Tool Loop (Claude Opus 4.8 calls these tools in any order):**

| Tool | What it does |
|---|---|
| `get_closed_trades` | Reads `paper_trades WHERE outcome IS NOT NULL AND market=$1 LIMIT 50` |
| `get_signal_weights` | Returns current champion's `weights_snapshot` |
| `get_strategy_versions` | Lists all strategy versions (champion + challengers) with backtest results |
| `get_decision_observations` | Reads `decision_observations` ledger — every scored symbol including skips |
| `query_trade_decisions` | Queries enriched `trade_decisions` (real decade-spanning history): filter by action/regime/outcome_score |
| `propose_challenger` | Writes new `strategy_versions` row with proposed weights + genome |
| `run_validation` | Calls `validateChallenger()` — deterministic walk-forward backtest (NO LLM) |
| `get_mentor_insights` | Reads recent `mentor_insights` coaching notes |
| `semantic_search_decisions` | Embed query → pgvector ANN → Voyage rerank → top-5 similar past setups |

**Per-trade learning:**
After each closed trade, write 1-sentence outcome note to `learning_log`:
```
"AAPL: BUY @ 182.50 → closed @ 195.20 (+7.0%), exit=target, horizon=8d, RSI was 65 on entry"
```

**Challenger proposal format (written to `strategy_versions`):**
```json
{
  "weights_snapshot": {
    "fundamental": 0.35,
    "technical": 0.28,
    "sentiment": 0.17,
    "macro": 0.12,
    "insider": 0.08
  },
  "genome": {
    "entry_threshold": 65,
    "exit_stop_pct": 7.0,
    "exit_target_pct": 18.0,
    "horizon_days": 14,
    "position_size_pct": 10.0,
    "sizing_mode": "fixed"
  },
  "market": "us",
  "is_champion": false,
  "proposed_at": "2026-07-11T21:00:00Z"
}
```

**Promotion path:**
Owner views Challengers on `/dashboard/agents` → Experiments tab → clicks "Promote". API checks `eligibility_passed = true` (HTTP 412 if not). Sets `is_champion = true`, `promoted_at = now()`. Old champion: `retired_at = now()`. ResearchAgent reads the new champion weights on its next run. Loop is closed.

---

### 3.9 MentorAgent

**Endpoint:** `POST /api/agents/mentor-coach`
**Schedule:** Fridays 5:15 PM ET
**Model:** `deepseek-v4-pro` (reasoning tier)
**Purpose:** Read-only behavioral coaching. Reads trade outcomes + learner runs + market regime. Writes personalized coaching to `mentor_insights`. Never mutates config or money.

**Reads:**
- Last 30 closed `paper_trades` with outcome
- Recent `learning_log` notes
- Current `macro_regime`
- `strategy_versions` champion performance
- `llm_call_log` cost history

**Writes:**
- `mentor_insights` rows: `{ grade (A-F), confidence, strengths[], focus_areas[], market_tailored_lesson, next_milestone, behavior_radar (6 axes) }`

**Surfaces on:**
- `/dashboard/mentor` → AI Coach tab (grade, 6-axis radar, coaching narrative)
- Daily briefing email (Mentor grade teaser)

---

### 3.10 HealthTriage

**Endpoint:** `POST /api/agents/health-triage`
**Schedule:** Manual trigger from `/dashboard/admin` (not cron-scheduled)
**Model:** `claude-haiku-4-5` (claude-fast tier — cheap, fast)
**Purpose:** Read-only diagnostic agent. Reads all open `agent_alerts` + recent `agent_runs` + LLM cost + AV budget. For each alert, writes `structured_issues` JSON:

```json
{
  "root_cause": "AV 25-call/day free tier exhausted at 11:30 AM",
  "blast_radius": "ResearchAgent scores stale; sentiment/technical dims will show cached data",
  "suggested_fix": "Upgrade AV tier or reduce call frequency via av-cache TTL"
}
```

**Never mutates config or money.** Dashboard SystemHealthCard one-click "Triage" button triggers this.

---

### 3.11 BriefingAgent

**Endpoint:** `POST /api/briefing/generate?market=us|india&period=morning|evening`
**Schedule:** Morning (US) 10:00 AM ET, Evening (US) 4:30 PM ET; India equivalent times
**Model:** `claude-sonnet-4-6` for editorial note; data queries are deterministic

**Morning briefing contents:**
1. Today's market regime banner (from `macro_regime`)
2. Paper portfolio snapshot: open positions count, unrealized P&L
3. Today's signals: symbols scored, directions, average score
4. LLM cost banner (if projected daily > $2)
5. Editor's note: weekday = actionable items; weekend = weekly recap synthesis

**Evening briefing contents:**
1. Realized P&L for the day (from closed `paper_trades`)
2. Exits taken and exit reasons
3. Open positions status
4. What to watch tomorrow (watchlist + upcoming earnings)
5. Mentor grade teaser (if available from this week's coaching)

**Writes:**
- `briefings` table row (session-keyed, used as cache — synthesis only cached on success)
- `newsletters` table row on successful send (subject, HTML body, Resend message_id, NAV/signals/positions snapshot)

**Email delivery:**
- Resend API (`RESEND_API_KEY`)
- To: `BRIEFING_TO` env var (currently test-mode → `vaibhavtiwari.vt@gmail.com`)
- From: verified sender domain required for production delivery

---

### 3.12 Watchdog

**Endpoint:** `POST /api/agents/watchdog`
**Schedule:** Every 2 hours (Supabase pg_cron, all days)
**Model:** None — purely deterministic SQL operations
**Added:** Migration 131 (2026-07-08)

**Three bounded cleanups (bounded = never touches money/positions/ledgers/config):**

1. **Reap zombie agent_runs:** Any `agent_runs` row with `status = "running"` for > 15 minutes → set `status = "failed"`, `error = "zombie_reaped"`. (Vercel functions max 60s; any "running" row after 15 minutes is stuck.)

2. **Revert orphaned claims:** Any `agent_signals` row with `status = "claiming"` for > 5 minutes → set `status = "pending"`, clear `claim_run_id`. This unblocks a paper-trade run that crashed after claiming but before filling.

3. **Expire stale pending signals:** Pending long signals older than today's market-local day → set `status = "expired"`. Prevents stale signals from filling in future runs after their score is no longer fresh.

---

## 4. 5-Dimension Scoring Engine

File: `lib/scoring/weighted-score.ts`

### Formula

```
analyst_score = round( Σ score[dim] × eff_weight[dim] )
```

Where `eff_weight` is renormalized if some dimensions are unavailable:

```typescript
if (includedDims.length >= 2 && includedDims.length < 5) {
  totalIncluded = sum(baseWeight[k] for k in includedDims)
  eff_weight[k] = baseWeight[k] / totalIncluded  (for included dims)
  eff_weight[k] = 0                               (for excluded dims)
  renormalized = true
}
```

**Edge cases:**
- `includedDims.length === 1`: NOT renormalized (too thin — use fixed split instead, flag as thin evidence)
- `includedDims.length === 0`: all weights zero, return score=0, flag as abstain-worthy
- `isThinEvidence(includedDims)`: returns true if `< 2` dims included → caller sets `data_confidence < 0.5`

### Dimension Detail

**Fundamental (default weight: 0.30)**

US (Alpha Vantage `OVERVIEW`):
- P/E ratio vs sector median → component 0-100
- Revenue growth (QoQ) → component 0-100
- Profit margin → component 0-100
- ROE → component 0-100
- Debt/equity ratio (inverted — high debt = low score) → component 0-100
- Average → `fundamental_score`

India (Yahoo `quoteSummary` remapped to AV shape):
- Same formula; `trailingPE`, `returnOnEquity`, `revenueGrowth`, `profitMargins`, `debtToEquity` from Yahoo JSON

**Technical (default weight: 0.25)**

`lib/data/technicals.ts`:
- RSI(14): computed from last 14 daily candles using Wilder's smoothing
- EMA(20): 20-bar EMA from `lib/data/candles.ts`
- EMA(50): 50-bar EMA
- Price > EMA(50) → bullish component
- RSI > 60 → momentum component
- EMA(20) > EMA(50) → trend component
- Weighted → `technical_score`

US candles: Massive API (preferred) → Alpha Vantage `TIME_SERIES_DAILY` fallback
India candles: Yahoo Finance chart endpoint (unauthenticated, `.NS` suffix)

**Sentiment (default weight: 0.20)**

US only: Alpha Vantage `NEWS_SENTIMENT?tickers=SYMBOL&limit=50`
- Returns ticker-specific sentiment score per article (-1 to +1)
- Weighted by relevance score (AV-provided)
- Remapped to 0-100 → `sentiment_score`

India: neutral baseline (50), `availability_mask.sentiment = false`, flagged in score detail

**Macro (default weight: 0.15)**

Reads current `macro_regime` row (written by MacroSentinel):
```
GREEN  → 80
YELLOW → 60
ORANGE → 40
RED    → 20
```
If no regime row exists → neutral (50), flagged.

**Insider (default weight: 0.10)**

US: Alpha Vantage `INSIDER_TRANSACTIONS?symbol=SYMBOL`
- Filter last 90 days
- Buy value vs sell value by role
- C-suite (CEO/CFO/COO) weight 2×, directors 1×, other officers 0.5×
- `ratio = buy_value / (buy_value + sell_value)` → remapped 0-100

India: NSE `corporates-pit` (SEBI insider filing JSON via `lib/nse-data.ts`)
- Same logic, different data source

---

## 5. Validation Engine

File: `lib/validation/engine.ts`

**100% deterministic — no LLM anywhere.** Replays champion vs challenger weights against
the same held-out opportunity set.

### Input Requirements

- `decision_observations` ledger (written by ResearchAgent for every scored symbol)
- `observation_labels` (matured by `label-maturation` cron after forward horizon passes)
- Minimum 60 matured observations required; returns `failReason: "insufficient_data(<60)"` if not met

### Algorithm

**Walk-forward folds (5 folds, 30-day test windows):**
```
folds = walkForwardFolds(rows, { folds: 5, testDays: 30, horizonDays: 10 })
```

For each row in each test fold, compute objective term under both weight sets:
```
score = computeWeightedAnalystScore(dim_scores, availability_mask, weights)
objectiveTerm = score >= threshold ? log(1 + benchmark_neutral_return) : 0
```

Paired difference per row: `challenger_term - champion_term`

**Statistical test (moving-block bootstrap):**
- 1000 resamples, `blockLen = horizonDays`, deterministic seed 42 (`mulberry32` PRNG)
- Computes: `pImprovement` (fraction of resampled means > 0), `ciLow`, `ciHigh`

### Pass/Fail Gates

A challenger must pass ALL four:

| Gate | Threshold | Rationale |
|---|---|---|
| `pImprovement` | ≥ 0.80 | 80% bootstrap probability of genuine improvement |
| `ciLow` | > −0.0005 | 95% CI lower bound must not be meaningfully negative |
| `nEffective` | ≥ 12 | At least 12 effective observations (rows / horizonDays) |
| `foldsWon` | ≥ 3 of 5 | Challenger must outperform in majority of time periods |

### Output

Written to `validation_experiments` table:
```json
{
  "market": "us",
  "challenger_id": 42,
  "champion_id": 38,
  "horizon_days": 10,
  "dataset_hash": "sha256...",
  "n_observations": 87,
  "n_effective": 8.7,
  "objective": "benchmark_neutral_log_growth",
  "challenger_score": 0.0182,
  "champion_score": 0.0143,
  "p_improvement": 0.84,
  "passed": true,
  "fail_reason": null,
  "config": { "seed": 42, "resamples": 1000, "blockLen": 10, "folds": [...] }
}
```

`strategy_versions.validation_experiment_id` linked on write.
`strategy_versions.eligibility_passed = true` only if all 4 gates pass.

---

## 6. Autonomy Ladder

File: `lib/autonomy.ts`

### Levels

| Level | ID | What it allows |
|---|---|---|
| L0 | `L0_research` | Research, score, explain only. No paper trades. |
| L1 | `L1_paper_auto` | May place paper trades automatically. |
| L2 | `L2_shadow` | Live recommendations + shadow (hypothetical) fills. |
| L3 | `L3_live_manual` | Owner drafts/approves each live order. **Current default.** |
| L4 | `L4_live_small_auto` | **Future:** auto-place within tiny capped budget. NOT active. |
| L5 | `L5_scaled_auto` | **Future:** larger allocation within hard caps. NOT active. |

### Hard Invariant

```typescript
export const AUTONOMOUS_LIVE_ENABLED = false  // compile-time constant
```

`autonomousLivePlacementAllowed()` always returns `false` regardless of `autonomy_level`
config because `AUTONOMOUS_LIVE_ENABLED` is checked first. Flipping it to `true` is
intentionally not enough on its own — the owner-click gateway remains. Both must change.

`liveOrdersAllowed()` returns `true` only at L3+. Unknown/invalid levels fail closed to L3
(never open things up on an invalid config value).

### Gate check in order path

Every live order API route:
1. `requireOwner()` — Supabase session must be the owner email
2. `liveOrdersAllowed(strategy_config.autonomy_level)` — must be ≥ L3
3. `autonomousLivePlacementAllowed()` — always false → manual confirm required

---

## 7. RAG Trade Memory — Full Pipeline

Files: `lib/rag/embeddings.ts`, `lib/rag/rerank.ts`, `lib/rag/trade-memory.ts`, `lib/rag/ingest.ts`

### Write Path (on position close)

**Trigger:** PositionMonitor calls `indexClosedTrade()` when `exit_reason` is set.

**Taint filter:** Tainted trades (flagged by LearnerAgent as learning-excluded) are skipped.

**Setup text format:**
```
"{symbol} fundamental={f} technical={t} sentiment={s} macro={m} insider={i}
 direction={long|short|neutral} regime={GREEN|YELLOW|ORANGE|RED}
 outcome={win|loss} exit_reason={stop|target|time|score_drop} pnl_pct={pct}
 horizon_days={n} entry_score={score}"
```

**Embedding:**
- Model: Voyage `voyage-3.5`, 1024 dimensions (not 1536 — original architecture doc was approximate)
- `POST https://api.voyageai.com/v1/embeddings` with `{ input: [text], model: "voyage-3.5" }`
- Returns `float[]` of length 1024

**Storage:**
```sql
INSERT INTO trade_memories (
  text, embedding,  -- pgvector(1024)
  metadata,         -- { symbol, outcome, pnl_pct, market, mandate_id, exit_reason }
  created_at
)
```

### Read Path (before scoring)

**Trigger:** ResearchAgent calls `retrieveSimilarTrades(symbol, scores)` before thesis generation.

**Query vector:** Embed the live symbol's current setup text (same format as write path).

```sql
SELECT *, embedding <=> $query_vector AS distance
FROM trade_memories
ORDER BY distance ASC
LIMIT 10
```

pgvector uses IVFFlat index with cosine distance operator `<=>`.

**Reranking:** Voyage `rerank-2` takes original query text + 10 candidate texts → returns relevance scores. Keep top 5.

**Summary injected into thesis prompt:**
```
"RAG context: 5 similar past setups retrieved.
 3/5 were wins (avg pnl +14%). 2/5 were losses (avg pnl -6%).
 Most similar: AAPL bought at RSI=67, macro=GREEN → win +18% in 12 days"
```

**Audit:** `rag_traces` table row written for every retrieval:
```json
{
  "symbol": "NVDA",
  "query_text": "NVDA fundamental=78 technical=72...",
  "retrieved_ids": ["uuid1",...,"uuid10"],
  "reranked_ids": ["uuid3","uuid1","uuid7","uuid4","uuid9"],
  "summary": "3/5 wins, avg pnl +14%",
  "model_embed": "voyage-3.5",
  "model_rerank": "rerank-2"
}
```

**Fallback:** If `VOYAGE_API_KEY` is absent, RAG is skipped entirely (no error, no RAG summary in prompt).

---

## 8. Robinhood MCP Client

Files: `lib/robinhood-mcp.ts`, `lib/brokers/adapters/robinhood-mcp.ts`

### OAuth PKCE S256 Flow

1. `GET /api/robinhood/login`
   - Generate `code_verifier` (64 random bytes, URL-safe base64)
   - `code_challenge = base64url(SHA256(code_verifier))`
   - Store `code_verifier` in httpOnly cookie (5-min TTL)
   - Redirect to Robinhood OAuth: `?code_challenge=&code_challenge_method=S256&state=<nonce>`

2. Robinhood redirects to `GET /api/robinhood/callback?code=AUTH_CODE&state=`
   - Read `code_verifier` from cookie
   - Verify `state` matches nonce
   - POST to Robinhood `/oauth2/token`: `{ code, code_verifier, grant_type: "authorization_code" }`
   - Receives: `{ access_token, refresh_token, expires_in }`
   - `vaultSet("ROBINHOOD_ACCESS_TOKEN", access_token)`
   - `vaultSet("ROBINHOOD_REFRESH_TOKEN", refresh_token)`
   - Redirect to `/dashboard/settings?connected=robinhood`

### Token Refresh (CAS)

Compare-and-set refresh to prevent race conditions:
```typescript
const current = await vaultGet("ROBINHOOD_ACCESS_TOKEN")
// ... attempt refresh ...
await vaultSet("ROBINHOOD_ACCESS_TOKEN", newToken)  // throws on error (no silent fail)
```

### Order Placement Sequence

Always two calls — review then place:
```
review_equity_order → { order_id, estimated_total, fills_preview }
place_equity_order  → { order_id, status, filled_qty, avg_price }
```

If `place_equity_order` returns no `order_id` → set `broker_orders.needs_reconcile = true`, fire `agent_alerts` with `issue_key = "order-needs-reconcile:<orderId>"`.

### Account Allowlist

```typescript
const ALLOWED_ORDER_ACCOUNTS = new Set(["605420660"])
```

Any attempt to place an order on any other account returns HTTP 403. The read-only monitoring account (`965848641`) can only call `get_equity_positions` — never order placement.

---

## 9. Zerodha Kite Connect

Files: `lib/kite.ts`, `lib/brokers/adapters/kite.ts`

### Daily Auth Flow (required every trading day)

Kite access tokens expire at 6:00 AM IST the following day (SEBI rule). Cannot be automated
without storing broker credentials.

```
Owner clicks "Connect Kite" → GET /api/kite/login
  → redirect to Kite login: ?api_key=&v=3
  → Kite redirects: ?request_token=TOKEN&status=success
  → POST /api/kite/callback with request_token
  → SHA256 checksum = sha256(api_key + request_token + api_secret)
  → POST https://api.kite.trade/session/token: { api_key, request_token, checksum }
  → { access_token, public_token, user_name, ... }
  → vaultSet("KITE_ACCESS_TOKEN", access_token)
  → all subsequent Kite API calls use: Authorization: "token {api_key}:{access_token}"
```

Token treated as expired if not generated today (checked at call time). On expiry, all
Kite routes return `{ reconnect: true }` and the India panel shows a "Reconnect" CTA.

### Order Placement

```
POST /api/kite/order (owner-only, requires confirm: true in body)
  → run 9-gate Money-Safety Gateway (Kite variant)
  → POST https://api.kite.trade/orders/regular
    { tradingsymbol, exchange: "NSE", transaction_type: "BUY",
      quantity, price, order_type: "LIMIT", product: "CNC" }
  → { order_id: "KT123" }
  → INSERT broker_orders { order_id, market: "india", product: "CNC" }
  → INSERT decision_journal row
```

### GTT Bracket (auto-placed after BUY)

Every India BUY immediately places a GTT (Good Till Triggered) two-leg bracket:
```
POST https://api.kite.trade/gtt/triggers
  trigger_type: "two-leg"
  orders: [
    { transaction_type: "SELL", order_type: "SL-M", quantity, trigger_value: stop_loss },
    { transaction_type: "SELL", order_type: "LIMIT", quantity, price: price_target }
  ]
→ { trigger_id: "GTT456" }
→ UPDATE broker_orders SET gtt_id = "GTT456"
```

GTT orders execute server-side on Kite's infrastructure — they survive the app being
completely offline. Stop-loss and take-profit are always active regardless of uptime.

---

## 10. India vs US — Side-by-Side Stack

| Layer | US | India |
|---|---|---|
| **Screener** | FinancialDatasets `screen_stocks` (dual bucket) | NSE full equity list (`EQUITY_L.csv`) via `lib/nse-data.ts` + nightly pre-score cache (`india_screen_cache`) |
| **Price / candles** | Massive API → AV `TIME_SERIES_DAILY` fallback | Yahoo Finance chart endpoint (`finance.yahoo.com/v8/finance/chart/SYMBOL.NS`) — unauthenticated |
| **Fundamentals** | AV `OVERVIEW` | Yahoo `quoteSummary` (cookie + crumb handshake → remapped to AV shape) |
| **Sentiment** | AV `NEWS_SENTIMENT` | None — neutral baseline (50), flagged as unavailable |
| **Insider** | AV `INSIDER_TRANSACTIONS` | NSE `corporates-pit` (SEBI filings) |
| **Options** | Massive real-time options | NSE option chain (`option-chain-indices`) |
| **Macro** | `macro_regime` table (MacroSentinel) | Same table (global) |
| **Execution** | Robinhood MCP (`605420660`) | Zerodha Kite Connect v3 (CNC, GTT) |
| **Paper pool** | USD $10,000 starting cash | INR ₹1,000,000 starting cash |
| **Champion** | `strategy_versions WHERE market="us" AND is_champion=true` | `strategy_versions WHERE market="india" AND is_champion=true` |
| **Phase gate** | ≥10 closed US trades | ≥10 closed India trades (starts from US champion clone) |
| **Index benchmark** | VOO | ^NSEI (NIFTY 50) |
| **Timezone** | America/New_York | Asia/Kolkata |
| **Market hours** | 9:30 AM–4:00 PM ET | 9:15 AM–3:30 PM IST |
| **NSE caveat** | — | NSE geo-throttles non-India IPs; fallback to NIFTY-100 live scan |

---

## 11. Complete API Route Map

### Agent Routes (`/api/agents/`)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/agents/research/cron` | POST | cron-secret | Trigger ResearchAgent (US or India via `?market=`) |
| `/api/agents/research` | POST | requireOwner | Manual ResearchAgent trigger |
| `/api/agents/paper-trade` | POST | cron-secret | Paper fill (US or India) |
| `/api/agents/position-monitor` | POST | cron-secret | Exit/stop checks per market |
| `/api/agents/learner` | POST | cron-secret | Weekly LearnerAgent (market param) |
| `/api/agents/learner-brain` | POST | requireOwner | Full LearnerAgent tool-use loop (manual) |
| `/api/agents/learner-controls` | GET/PATCH/POST | requireOwner | Per-dimension learn_from/allow_mutation + rollback |
| `/api/agents/macro-sentinel` | POST | cron-secret | MacroSentinel 8-indicator run |
| `/api/agents/macro-sentinel/history` | GET | requireOwner | Historical regime rows |
| `/api/agents/theme-scout` | POST | cron-secret | ThemeScout sector scan |
| `/api/agents/trader` | POST | cron-secret | TraderAgent proposal generation |
| `/api/agents/trade` | POST | requireOwner | Submit trade for approval |
| `/api/agents/trade/approve` | POST | requireOwner | Approve proposal → 9-gate → live order |
| `/api/agents/trade/reject` | POST | requireOwner | Reject proposal + log |
| `/api/agents/mentor-coach` | POST | cron-secret | MentorAgent coaching run |
| `/api/agents/health-triage` | POST | requireOwner | HealthTriage diagnostic |
| `/api/agents/deep-dive` | POST | requireOwner | Deep-dive research on a symbol |
| `/api/agents/backtest` | POST | requireOwner | Walk-forward backtest for a strategy version |
| `/api/agents/backtest/optimize` | POST | requireOwner | Optimization run on weight grid |
| `/api/agents/performance` | POST | cron-secret | NAV snapshot |
| `/api/agents/performance/metrics` | GET | requireOwner | Full performance metrics |
| `/api/agents/deepseek-research` | POST | cron-secret | DeepSeekAgent parallel research run |
| `/api/agents/comparison` | GET | requireOwner | Claude vs DeepSeek P&L comparison |
| `/api/agents/history` | GET | requireOwner | All `agent_runs` rows with filters |
| `/api/agents/agent-config` | GET/PATCH | requireOwner | Agent model config (model assignments) |
| `/api/agents/provider-keys` | GET/POST | requireOwner | LLM provider key management |
| `/api/agents/rag-backfill` | POST | cron-secret | Backfill RAG embeddings for unindexed trades |
| `/api/agents/watchdog` | POST | cron-secret | Watchdog cleanup run |
| `/api/agents/db-cleanup` | POST/GET | cron-secret OR requireOwner | Monthly DB cleanup (POST=run, GET=dry-run preview) |
| `/api/agents/label-maturation` | POST | cron-secret | Mature decision_observations into labels |
| `/api/agents/rescore-check` | POST | cron-secret | Scoring calibration check |
| `/api/agents/edge-scout` | POST | cron-secret | Edge signal discovery |
| `/api/agents/edge-ic` | POST | cron-secret | IC (information coefficient) computation for edge signals |
| `/api/agents/research-journal` | GET | requireOwner | Research journal entries |
| `/api/agents/research-journal/evolution` | GET | requireOwner | Research evolution history |

### Evaluation Routes (`/api/agents/evaluation/`)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/agents/evaluation/run` | POST | requireOwner | Run evaluation for a mandate |
| `/api/agents/evaluation/results` | GET | requireOwner | Results for a mandate |
| `/api/agents/evaluation/mandates` | GET/POST | requireOwner | Investment mandate CRUD |
| `/api/agents/evaluation/p1-gate/cron` | POST | cron-secret | P1 gate check (Sundays) |

### Strategy Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/strategies/versions` | GET/POST | requireOwner | Champion/challenger list; promote/retire |

### Market Data Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/markets/synthesis` | GET | requireOwner | Market synthesis (risk-on/neutral/risk-off, cached) |
| `/api/markets/breadth` | GET | requireOwner | Market breadth (advance/decline, new highs/lows, % above MA) |
| `/api/markets/insider-trades` | GET | requireOwner | AV insider + congressional trades |
| `/api/markets/smart-money` | GET | requireOwner | Options flow + insider signals aggregated |
| `/api/markets/edgar-insiders` | GET | requireOwner | SEC EDGAR Form 4 insiders |
| `/api/agents/calendar` | GET | requireOwner | Earnings calendar (Massive, no LLM) |

### Portfolio Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/live-portfolio` | GET | requireOwner | Merge positions from all `live_account_snapshots` |
| `/api/live-portfolio/performance` | GET | requireOwner | Historical performance by period |
| `/api/live-portfolio/import-csv` | POST | requireOwner | Import Robinhood CSV (SHA-256 dedup) |
| `/api/live-portfolio/files` | GET/DELETE | requireOwner | List/delete imported CSV files |
| `/api/live-portfolio/decisions` | GET | requireOwner | Paginated trade decisions |
| `/api/live-portfolio/enrich` | POST | requireOwner | Enrich trade decisions with post-trade prices |
| `/api/live-portfolio/embed` | POST | requireOwner | Embed trade decisions into RAG |

### Kite (India) Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/kite/login` | GET | requireOwner | Initiate Kite daily auth |
| `/api/kite/callback` | GET | open (from Kite) | Receive request_token, exchange for access_token |
| `/api/kite/status` | GET | requireOwner | Token freshness check |
| `/api/kite/portfolio` | GET | requireOwner | Live NSE/BSE holdings |
| `/api/kite/order` | POST | requireOwner | Place India live order (CNC + GTT bracket) |

### Robinhood Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/robinhood/login` | GET | requireOwner | Initiate PKCE S256 OAuth |
| `/api/robinhood/callback` | GET | open (from RH) | Token exchange + vault storage |

### Broker / Order Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/broker/orders` | POST | requireOwner | Live order through 9-gate gateway |

### Chart Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/charts/score-history` | GET | requireOwner | Per-symbol score history from `signal_score_history` |
| `/api/charts/sector-history` | GET | requireOwner | Sector ETF historical data |
| `/api/charts/sector-returns` | GET | requireOwner | Sector return comparison |

### Auth / Settings Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/settings/risk-profile` | GET/PATCH | requireOwner | Risk profile + threshold/sizing fields |
| `/api/vault` | GET/POST | requireOwner (PIN-protected) | API key vault read/write |
| `/api/admin/llm-costs` | GET | requireOwner | LLM cost burn rate + per-model breakdown |
| `/api/journal` | GET/POST | requireOwner | Decision journal CRUD |
| `/api/briefing/generate` | POST | cron-secret | Generate + email briefing |
| `/api/watchlist` | GET/POST/DELETE | requireOwner | Watchlist CRUD |
| `/api/automation/schedule` | GET | requireOwner | Read-only schedule view |
| `/api/scan/india/refresh` | POST | cron-secret | Refresh India NSE pre-score cache |
| `/api/alerts/stale-check` | POST | cron-secret | Stale agent run check |
| `/api/scanner` | GET/POST | requireOwner | Stock screener |

### Scan India

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/scan/india/refresh` | POST | cron-secret | Refresh India NSE pre-score cache |

---

## 12. Database Schema — All Tables

### Signal & Research

| Table | Key columns | Notes |
|---|---|---|
| `agent_signals` | `id, symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, thesis, status, market, claim_run_id, agent_label` | `status`: pending → claiming → filled/expired/rejected |
| `signal_score_history` | `id, symbol, analyst_score, fundamental, technical, sentiment, macro, insider, direction, source, market, created_at` | Append-only. Never mutated. Index: `(symbol, created_at desc)` |
| `decision_observations` | `id, symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, score_threshold, direction, market, availability_mask (jsonb), benchmark_neutral_return, created_at` | Replay ledger for Validation Engine. Never mutated. |
| `observation_labels` | `id, observation_id, horizon_days, fwd_return, benchmark_neutral_return, labeled_at` | Matured by `label-maturation` cron. |
| `macro_regime` | `id, regime, danger_score, computed_at` | Single-row (replaced each Monday) or append |
| `macro_signals` | `id, regime_id, indicator, raw_value, contribution, direction, computed_at` | Per-indicator breakdown |
| `watchlist` | `id, symbol, why_added, source, theme_tag, research_enabled, alert_on_signal, alert_on_earnings, created_at` | |

### Paper Trading

| Table | Key columns | Notes |
|---|---|---|
| `paper_portfolio` | `id, market, cash, total_deposited, created_at` | One row per market (US=USD, India=INR). Never cross-blend. |
| `paper_positions` | `id, symbol, market, shares, avg_cost, opened_at, price_target, stop_loss, highest_price, exit_reason` | Row deleted on close (no soft-close flag). |
| `paper_trades` | `id, symbol, market, side, fill_price, shares, exit_price, realized_pnl, pnl_pct, outcome, closed_at, signal_id` | Append-only. `outcome`: "win"\|"loss"\|null (open). |
| `paper_order_events` | `id, trade_id, event_type, price, created_at` | Immutable. DB trigger blocks UPDATE/DELETE. Events: submitted, filled, stop_triggered, target_hit, time_stop, score_drop. |
| `paper_performance` | `id, date, market, paper_nav, bench_nav, alpha` | Unique on `(date, market)`. NAV curve per market. |

### Live Portfolio

| Table | Key columns | Notes |
|---|---|---|
| `live_account_snapshots` | `account_id (UNIQUE), positions_json, equity, buying_power, captured_at` | Upsert on `account_id`. 6 Robinhood accounts. |
| `broker_orders` | `id, order_id, market, symbol, action, quantity, price, status, gtt_id, needs_reconcile, placed_at` | Append-only. Partial unique index prevents duplicate orders on `(order_id, status)`. |
| `uploaded_trade_files` | `id, filename, file_hash (UNIQUE), trade_count, duplicate_count, date_range_start, date_range_end, broker` | CSV import dedup. |
| `trade_decisions` | `id, symbol, action, qty, exec_price, exec_date, price_1d/1w/1m/3m_after, outcome_score, pattern_tags, macro_market_regime, enrichment_status` | Unique on `(symbol, action, exec_date, exec_price, qty)`. |

### Strategy & Learning

| Table | Key columns | Notes |
|---|---|---|
| `strategy_versions` | `id, market, weights_snapshot (jsonb), genome (jsonb), is_champion, eligibility_passed, promoted_at, retired_at, validation_experiment_id` | Champion: `is_champion=true`. Only one per market. |
| `strategy_config` | `id, market, autonomy_level, robinhood_mcp_enabled, score_threshold, position_size_pct, stop_loss_pct, target_pct, risk_profile, app_paused` | One row per market. |
| `experiment_runs` | `id, market, challenger_id, champion_id, horizon_days, dataset_hash, n_observations, n_effective, challenger_score, champion_score, p_improvement, passed, fail_reason, config (jsonb)` | One per validation run. |
| `validation_experiments` | Same as `experiment_runs` (alias/same table) | |
| `learning_log` | `id, market, symbol, note, outcome, created_at` | 1-sentence per-trade notes. |
| `learning_priors` | `id, market, dimension, prior_weight, created_at` | Current weight priors. |
| `learning_priors_history` | `id, market, dimension, prior_weight, reason, created_at` | Append-only weight history. |

### Performance Truth

| Table | Key columns | Notes |
|---|---|---|
| `investment_mandates` | `id, name, market, description, created_at` | Named mandates for evaluation (e.g. "US Momentum Champion"). |
| `strategy_evaluations` | `id, mandate_id, computed_at, sharpe, sortino, max_drawdown, win_rate, expectancy, profit_factor, alpha, exec_slip_mean, health_label, n_trades, tainted_count` | Append-only. Never updated. |

### RAG Memory

| Table | Key columns | Notes |
|---|---|---|
| `trade_memories` | `id, text, embedding (vector(1024)), metadata (jsonb), created_at` | pgvector cosine. IVFFlat index. |
| `rag_traces` | `id, symbol, query_text, retrieved_ids, reranked_ids, summary, model_embed, model_rerank, created_at` | Retrieval audit. |

### System Health

| Table | Key columns | Notes |
|---|---|---|
| `agent_alerts` | `id, issue_key, severity, category, title, detail, resolved, resolved_at, auto_expire_at, structured_issues (jsonb)` | Partial unique index on `issue_key WHERE resolved=false`. At most one open alert per condition. |
| `agent_runs` | `id, agent_type, status, started_at, completed_at, error, result_summary, run_id` | Every agent execution logged. |
| `llm_call_log` | `id, model, task_type, tokens_in, tokens_out, cost_usd, duration_ms, success, error_msg, symbol, agent_label, run_id, created_at` | Every LLM call. Powers `/dashboard/admin` cost monitor. |
| `agent_config` | `id, agent_type, model, enabled, schedule, params (jsonb)` | Per-agent model/enable overrides. |

### Auth & Keys

| Table | Key columns | Notes |
|---|---|---|
| `api_key_vault` | `id, key_name, key_value_encrypted, updated_at` | Runtime-editable keys (not in .env). |
| `broker_accounts` | `id, account_id, broker, label, enabled, notional_cap_usd, source` | Robinhood account registry. Only `605420660` has `enabled=true` for orders. |

### Other

| Table | Key columns | Notes |
|---|---|---|
| `trade_proposals` | `id, symbol, action, quantity, price, analyst_score, expires_at, status, proposed_at` | 30-min expiry. TraderAgent writes; owner approves/rejects. |
| `decision_journal` | `id, symbol, action, reason, signal_id, trade_id, created_at` | Audit trail: signal → fill → outcome. |
| `mentor_insights` | `id, market, grade, confidence, strengths, focus_areas, lesson, next_milestone, behavior_radar (jsonb), created_at` | MentorAgent weekly coaching output. |
| `newsletters` | `id, subject, html_body, resend_message_id, nav_snapshot, signals_count, positions_count, sent_at` | Written alongside `briefings` on successful send. |
| `briefings` | `id, session, content, created_at` | Cache keyed by session string (e.g. "synthesis-2026-07-10"). |
| `india_screen_cache` | `id, symbol, scores (jsonb), scored_at` | Nightly pre-score for full NSE market. `scan-india-refresh` writes; Scanner reads. |
| `edge_signals` | `id, market, signal_name, description, value, metadata (jsonb), created_at` | Alternative/edge signals beyond 5 core dims. |
| `edge_ic_history` | `id, signal_name, market, ic, n_obs, computed_at` | IC history per edge signal. |

---

## 13. System Health Funnel — All Reporters

Every reporter calls `reportIssue()` in `lib/system-health.ts`. Partial unique index on
`issue_key WHERE resolved = false` means calling `reportIssue()` on every run is safe —
at most one open alert per condition. `resolveIssue()` closes it when condition clears.

| Reporter | issue_key pattern | Severity | Auto-resolve when |
|---|---|---|---|
| Model deprecation check | `model-deprecated:<model>` | warn | Model updated in agent_config |
| Model fallback | `model-fallback:<model>` | warn | Owner updates model config |
| Pricing unverified | `pricing-unverified:<model>` | info | Model added to PRICING table |
| Anthropic key missing | `anthropic-key-missing` | critical | Key added to env + redeploy |
| AV budget guard | `av-budget-exhausted` | warn | Midnight UTC auto-expire |
| Kill switch: daily loss | `kill-switch-tripped:daily-loss:<market>` | critical | Owner manual clear |
| Kill switch: drawdown | `kill-switch-tripped:drawdown:<market>` | critical | Owner manual clear |
| Kill switch: accuracy | `kill-switch-tripped:accuracy:<market>` | critical | Owner manual clear |
| Order needs reconcile | `order-needs-reconcile:<orderId>` | error | Owner confirms order status |
| Robinhood token expired | `robinhood-token-expired` | warn | Token refresh succeeds |
| Kite token expired | `kite-token-expired` | warn | Owner re-connects Kite |
| NAV circuit breaker | `nav-drawdown-circuit-breaker:<market>` | critical | Owner resets app_paused |
| Stale agent | `cron-stale:<agent>` | warn | Agent runs successfully |
| Watchdog zombie | `watchdog-zombie-reaped` | info | Auto on next clean run |

**Dashboard surfaces:**
- `SystemHealthCard` on `/dashboard` home (green when clean; severity-ranked open alerts; one-click resolve for info/warn)
- `open_alerts` band in every briefing email (critical/error alerts block the green headline)

---

## 14. Performance Truth Layer

Files: `lib/evaluation/run-evaluation.ts`, `lib/analytics/performance-metrics.ts`

**Purpose:** Produce honest, auditable performance numbers. No LLM involved — all math.

**"Honesty Rules" applied before reporting any metric:**

| Condition | Label | What shows |
|---|---|---|
| `n_trades < 20` | `insufficient_sample` | "Too few trades — numbers not meaningful" |
| `win_rate < 35%` AND `n_trades ≥ 20` | `negative_edge` | Numbers shown with red label |
| `35% ≤ win_rate < 45%` | `promising` | Numbers shown with yellow label |
| `win_rate ≥ 45%` AND passed validation | `validation_required` | Numbers shown, promotion eligible |

**Tainted trades:** Counted in the book (for honesty) but labeled `tainted = true`. Tainted = LearnerAgent flagged as learning-excluded (e.g. filled during a data outage, macro circuit-breaker trip during hold, or system error on exit).

**Metrics computed:**
- Sharpe ratio (annualized, `risk_free_rate = 0.05`)
- Sortino ratio
- Max drawdown
- Win rate
- Expectancy = `(win_rate × avg_win) - (loss_rate × avg_loss)`
- Profit factor = `gross_profit / gross_loss`
- Alpha vs benchmark (VOO / ^NSEI)
- `exec_slip_mean`: average slippage between signal price and fill price

**Storage:** Append-only `strategy_evaluations` table — results are never overwritten. Each evaluation run is a new row. `investment_mandates` table defines which trades belong to which mandate.

---

## 15. Champion/Challenger Governance

### Full Lifecycle

```
ResearchAgent scores live
       ↓
signals written (decision_observations ledger)
       ↓
label-maturation matures labels after forward horizon
       ↓
LearnerAgent (Fridays) proposes Challenger weights
       ↓
Challenger written to strategy_versions (is_champion=false, eligibility_passed=false)
       ↓
run_validation tool called → validateChallenger() runs deterministically
       ↓
if passes all 4 gates → eligibility_passed=true
       ↓
Owner views on /dashboard/agents → Experiments tab
       ↓
Owner clicks Promote → POST /api/strategies/versions { action: "promote", id: X }
  → API checks eligibility_passed=true (HTTP 412 if false)
  → UPDATE strategy_versions SET is_champion=true, promoted_at=now() WHERE id=X
  → UPDATE strategy_versions SET retired_at=now() WHERE market=$m AND is_champion=true AND id!=X
       ↓
ResearchAgent next run reads new champion weights_snapshot
```

### Shadow Mode

A Challenger with `shadow=true` records what it *would* have done on live runs — no fills, no
cash debit — a dress rehearsal. The Strategy Registry shows shadow P&L alongside the
champion's actual P&L.

### Per-Market Isolation

India and US champions are completely independent:
- `strategy_versions WHERE market="india"` is a separate cohort
- A bad India run cannot propose a weight change to the US champion
- India starts on a clone of the US champion as seed (migration 057), then diverges once ≥10 India trades close

---

## 16. Error Handling Catalogue

| Scenario | Where caught | Behavior |
|---|---|---|
| AV 429 / daily budget exhausted | `lib/av-cache.ts` | Return cached value if <24h old; fire `av-budget-exhausted` alert; return null/neutral if no cache |
| Groq timeout | `callLLM` / `callGroq` | `AbortSignal.timeout(120s)` → throw; caller receives error; agent run marked failed |
| DeepSeek 5xx | `callDeepSeek` | Throw; caught by `callLLM` top-level; logged to `llm_call_log` with `success=false` |
| Claude deprecated model | `callLLM` `isModelUnavailable()` | Fall back to same-tier sibling; fire `model-fallback:<model>` alert; run completes |
| Anthropic key missing | `callClaude` 401 | Fall back to `deepseek-v4-flash`; fire `anthropic-key-missing` critical alert |
| Kite token expired | `lib/kite.ts` | Return `{ reconnect: true }`; all India routes show "Reconnect" CTA; fire `kite-token-expired` alert |
| Robinhood token expired | `lib/robinhood-mcp.ts` | Attempt CAS refresh; if fails → fire `robinhood-token-expired` alert; block order |
| Paper-trade double-fill | `claim_run_id` CAS | Second cron finds `claim_run_id IS NOT NULL` → zero rows updated → skip silently |
| Live order no order_id | `place_equity_order` | Set `broker_orders.needs_reconcile=true`; fire `order-needs-reconcile:<id>` alert |
| NAV -5% weekly | `position-monitor` NAV check | Set `strategy_config.app_paused=true`; fire critical alert; stop all paper fills |
| NSE geo-block | `lib/nse-data.ts` | Fall back to NIFTY-100 live scan; log honest note in response |
| Voyage key absent | `lib/rag/embeddings.ts` | RAG skipped entirely; no error; no summary in thesis prompt |
| pgvector query error | `lib/rag/trade-memory.ts` | Return empty retrieval; thesis continues without RAG context |
| LearnerAgent tool error | `runAgentLoop` tool executor | `"Error executing {tool}: {e}"` returned as tool result; loop continues; LLM handles gracefully |
| Validation insufficient data | `validateChallenger()` | Return `passed=false, failReason:"insufficient_data(<60)"` |
| agent_runs zombie (>15min) | `watchdog` | Set `status="failed"`, `error="zombie_reaped"` |
| Claiming signal orphaned | `watchdog` | Clear `claim_run_id`, revert to `status="pending"` so next fill run can pick it up |
| Stale pending signal (old day) | `watchdog` | Set `status="expired"` per market-local calendar day |

---

*Source files: `lib/llm-router.ts`, `lib/autonomy.ts`, `lib/schedule.ts`, `lib/scoring/weighted-score.ts`, `lib/validation/engine.ts`, `lib/research-agent.ts`, `ARCHITECTURE.md`, `AGENTS.md`, `SYSTEM_OVERVIEW.md`*

*Maintained per CLAUDE.md rule — update when agent internals, data flows, or error handling change.*

*Last updated: 2026-07-10*
