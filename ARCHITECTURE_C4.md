# Kairos — C4 Architecture Documentation

> **Audience guide:**
> - Executives / product: §1 System Context only
> - Architects / engineers: §1 + §2 + §3
> - Senior engineers building agents: all sections
> - DevOps / infra: §4 Deployment

Last updated: 2026-07-09

---

## Table of Contents

1. [Level 1 — System Context](#1-level-1--system-context)
2. [Level 2 — Container Diagram](#2-level-2--container-diagram)
3. [Level 3 — Component Diagrams](#3-level-3--component-diagrams)
   - 3.1 Research Pipeline
   - 3.2 Paper Trading Subsystem
   - 3.3 Learning & Evolution Loop
   - 3.4 Money-Safety Gateway
   - 3.5 System Health Funnel
4. [Level 4 — Dynamic / Code-Level Flows](#4-level-4--dynamic--code-level-flows)
   - 4.1 A stock scored end-to-end
   - 4.2 Robinhood OAuth PKCE S256 flow
   - 4.3 Zerodha Kite daily login + GTT placement
   - 4.4 LearnerAgent tool-use loop
   - 4.5 RAG trade memory: write and read
   - 4.6 Live order through 9-gate safety funnel
5. [Deployment Diagram](#5-deployment-diagram)
6. [Architecture Decision Summary](#6-architecture-decision-summary)

---

## 1. Level 1 — System Context

Kairos is a **personal AI-powered trading OS** for one owner. It connects to market data providers,
two brokers, a vector AI service, an LLM platform, and an email service. Every interaction with
real money requires the owner to click "yes."

```mermaid
C4Context
  title Kairos — System Context

  Person(owner, "Owner", "The sole user. Approves live trades, promotes strategies, monitors health.")

  System(kairos, "Kairos", "AI-powered trading OS. Researches stocks, manages paper + live portfolios, learns from outcomes.")

  System_Ext(anthropic, "Anthropic / Claude", "LLM platform. Powers research thesis, coaching notes, learner brain.")
  System_Ext(groq, "Groq", "Fast LLM inference. Generates research thesis in <1s.")
  System_Ext(deepseek, "DeepSeek", "Reasoning LLM. Powers Challenger strategy proposals.")
  System_Ext(supabase, "Supabase (PostgreSQL + pgvector)", "All persistent state: portfolios, signals, strategies, trade memory.")
  System_Ext(vercel, "Vercel", "Hosts the Next.js app. Runs two cloud crons.")
  System_Ext(robinhood, "Robinhood", "US broker. Read-only monitoring account + agentic order account.")
  System_Ext(kite, "Zerodha Kite", "India broker. NSE/BSE real portfolio + order placement.")
  System_Ext(alphavantage, "Alpha Vantage", "US market data: price, technicals, fundamentals, macro, insider, news.")
  System_Ext(massive, "Massive Market Data", "US candles, screener, options flow.")
  System_Ext(fmp, "FinancialDatasets (FMP)", "US stock screener: momentum + value bucket candidates.")
  System_Ext(yahoo, "Yahoo Finance", "India .NS price, candles, fundamentals (free).")
  System_Ext(nse, "NSE Public JSON", "Full India equity universe, SEBI insider trades, option chain.")
  System_Ext(voyage, "Voyage AI", "voyage-3.5 embeddings + rerank-2. Powers trade memory RAG.")
  System_Ext(langfuse, "Langfuse", "LLM trace + generation observability.")
  System_Ext(resend, "Resend", "Transactional email. Morning + evening briefings.")

  Rel(owner, kairos, "Views dashboard, approves live orders, promotes strategies", "HTTPS browser")
  Rel(kairos, anthropic, "Coaching notes, learner brain, health triage", "HTTPS / Anthropic SDK")
  Rel(kairos, groq, "Research thesis generation (fast, 512 tokens)", "HTTPS / Groq SDK")
  Rel(kairos, deepseek, "Challenger proposals, parallel screener", "HTTPS / DeepSeek API")
  Rel(kairos, supabase, "All reads and writes — signals, trades, strategies, memory", "HTTPS / Supabase SDK")
  Rel(kairos, vercel, "Deployed on; receives cron triggers", "Vercel platform")
  Rel(kairos, robinhood, "Read positions (monitoring), place orders (agentic account)", "Robinhood MCP / JSON-RPC")
  Rel(kairos, kite, "Read India holdings, place NSE orders, place GTT brackets", "Kite Connect v3 / HTTPS")
  Rel(kairos, alphavantage, "Price, RSI, EMA, OVERVIEW, NEWS_SENTIMENT, insider, macro", "HTTPS / REST")
  Rel(kairos, massive, "US candles, screener, options flow", "HTTPS / REST")
  Rel(kairos, fmp, "screen_stocks: momentum + value bucket", "HTTPS / REST")
  Rel(kairos, yahoo, "India .NS price + quoteSummary fundamentals", "HTTPS / REST (no auth)")
  Rel(kairos, nse, "EQUITY_L.csv, insider trades, option chain (cookie handshake)", "HTTPS / REST")
  Rel(kairos, voyage, "Embed closed trade setups; rerank retrieved memories", "HTTPS / Voyage SDK")
  Rel(kairos, langfuse, "Trace every LLM call: model, tokens, cost, tool calls", "HTTPS / Langfuse SDK")
  Rel(kairos, resend, "Send morning + evening briefing emails", "HTTPS / Resend API")
```

### Context narrative

| Actor | Role in the system |
|---|---|
| **Owner** | The only human. Views the dashboard, approves every live order, clicks "Promote" to change the live strategy. |
| **Kairos** | Runs on Vercel. 12 AI agents scheduled via Vercel crons (2) and Windows Task Scheduler (14). All agents communicate through Supabase tables — no direct agent-to-agent HTTP calls. |
| **Supabase** | The single source of truth. All state — signals, paper trades, live orders, strategies, RAG memory, system health — lives here. |
| **Anthropic / Groq / DeepSeek** | LLM providers. Scoring is always deterministic (no LLM). LLMs write thesis text, coaching notes, and propose strategy changes. |
| **Robinhood / Kite** | Brokers. Real money never moves without the owner clicking send. |

---

## 2. Level 2 — Container Diagram

```mermaid
C4Container
  title Kairos — Container Diagram

  Person(owner, "Owner", "Sole user")

  Container_Boundary(kairos_app, "Kairos (Next.js 15 on Vercel)") {

    Container(dashboard, "Dashboard UI", "Next.js App Router, React, TypeScript", "All /dashboard/* pages: research, portfolio, learning, agents, admin. Inline styles + T color tokens — no Tailwind.")

    Container(api_routes, "API Routes", "Next.js API Routes, TypeScript", "All /api/* handlers. Auth-gated with requireOwner() or verifyCronSecret(). Force-dynamic.")

    Container(agent_engine, "Agent Engine", "TypeScript, Anthropic SDK, Groq, DeepSeek", "12 agents: MacroSentinel, ResearchAgent, DeepSeekAgent, PaperTrader, PositionMonitor, LearnerAgent, ThemeScout, MentorAgent, HealthTriage, TraderAgent, ValidationEngine, BriefingAgent.")

    Container(llm_router, "LLM Router", "TypeScript — lib/llm-router.ts", "Routes callLLM() to correct provider by tier alias: fast→Groq, reasoning→DeepSeek, claude-fast→Haiku, claude-smart→Sonnet, claude-opus→Opus. Logs every call to llm_call_log.")

    Container(money_gateway, "Money-Safety Gateway", "TypeScript — lib/autonomy.ts + lib/broker-resolver.ts", "9-gate sequential check before every live order: owner auth, autonomy ladder, trading enabled, kill switches, data quality, per-order cap, daily cap, concentration, price drift.")

    Container(robinhood_mcp, "Robinhood MCP Client", "TypeScript — lib/robinhood-mcp-client.ts", "JSON-RPC bridge to Robinhood agentic account. Handles OAuth PKCE S256 token lifecycle + CAS refresh.")

    Container(kite_client, "Kite Connect Client", "TypeScript — lib/kite-client.ts", "REST bridge to Zerodha Kite. Daily token from vault. Places CNC orders + GTT bracket pairs.")

    Container(rag_engine, "RAG Trade Memory", "TypeScript — lib/rag.ts + Voyage AI", "Embeds closed trade setups with voyage-3.5. Retrieves + reranks similar past setups before each score. Writes to trade_memories pgvector table.")

    Container(vault, "API Key Vault", "TypeScript — lib/vault.ts + Supabase table", "Runtime-editable API keys (not in .env). Stores KITE_ACCESS_TOKEN, Robinhood OAuth tokens, AV key, etc.")

    Container(system_health, "System Health", "TypeScript — lib/system-health.ts", "reportIssue / resolveIssue helpers. Dedup by issue_key. All reporters write to agent_alerts table.")

    Container(scheduler_vercel, "Vercel Crons", "vercel.json", "2 cloud crons: P1-gate (Sundays 02:00 UTC) + DB cleanup (1st of month 03:00 UTC).")

    Container(scheduler_local, "Windows Task Scheduler", "PowerShell scripts/run-agents.ps1", "14 local tasks: research, paper-trade, position-monitor, learner, macro-sentinel, theme-scout, briefings, stale-check, India variants. PC must be on.")
  }

  ContainerDb(supabase_db, "Supabase (PostgreSQL + pgvector)", "Supabase hosted", "35+ tables: signals, paper_trades, paper_positions, strategy_versions, trade_memories (vector), agent_alerts, llm_call_log, api_key_vault, etc.")

  System_Ext(anthropic_llm, "Anthropic Claude", "claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-8")
  System_Ext(groq_llm, "Groq", "llama-3.3-70b-versatile")
  System_Ext(deepseek_llm, "DeepSeek", "deepseek-reasoner / deepseek-chat")
  System_Ext(voyage_ai, "Voyage AI", "voyage-3.5 + rerank-2")
  System_Ext(rh_broker, "Robinhood", "Agentic + read-only accounts")
  System_Ext(kite_broker, "Zerodha Kite Connect v3", "India NSE/BSE")
  System_Ext(market_data, "Market Data APIs", "Alpha Vantage, Massive, FMP, Yahoo, NSE")
  System_Ext(resend_email, "Resend", "Transactional email")
  System_Ext(langfuse_obs, "Langfuse", "LLM observability")

  Rel(owner, dashboard, "Views, approves orders, promotes strategies", "HTTPS browser")
  Rel(dashboard, api_routes, "Fetches data, submits actions", "fetch / JSON")
  Rel(api_routes, agent_engine, "Invokes agents on cron or manual trigger", "TypeScript imports")
  Rel(agent_engine, llm_router, "All LLM calls routed through", "callLLM() / runAgentLoop()")
  Rel(llm_router, anthropic_llm, "Coaching, learner, triage", "HTTPS")
  Rel(llm_router, groq_llm, "Research thesis (fast)", "HTTPS")
  Rel(llm_router, deepseek_llm, "Challenger proposals, parallel screener", "HTTPS")
  Rel(llm_router, langfuse_obs, "Traces every generation", "HTTPS")
  Rel(agent_engine, supabase_db, "Read signals, write trades, update strategies", "Supabase SDK")
  Rel(api_routes, supabase_db, "Auth session, CRUD, admin ops", "Supabase SDK")
  Rel(api_routes, money_gateway, "Every live order passes through", "TypeScript call")
  Rel(money_gateway, robinhood_mcp, "US live order placement (after all gates pass)", "JSON-RPC")
  Rel(money_gateway, kite_client, "India live order placement", "REST")
  Rel(robinhood_mcp, rh_broker, "review_equity_order → place_equity_order", "OAuth / JSON-RPC")
  Rel(kite_client, kite_broker, "CNC order + GTT bracket", "REST / HTTPS")
  Rel(agent_engine, rag_engine, "Read: retrieve similar past setups. Write: index closed trade", "TypeScript call")
  Rel(rag_engine, voyage_ai, "Embed + rerank", "HTTPS")
  Rel(rag_engine, supabase_db, "trade_memories pgvector table", "Supabase SDK")
  Rel(agent_engine, market_data, "Price, technicals, fundamentals, screener, macro", "HTTPS")
  Rel(agent_engine, system_health, "reportIssue / resolveIssue on any failure", "TypeScript call")
  Rel(system_health, supabase_db, "agent_alerts table (partial unique index on issue_key)", "Supabase SDK")
  Rel(vault, supabase_db, "api_key_vault table (runtime-editable keys)", "Supabase SDK")
  Rel(scheduler_vercel, api_routes, "POST /api/agents/* with x-cron-secret header", "HTTPS")
  Rel(scheduler_local, api_routes, "POST /api/agents/* via PowerShell script", "HTTPS")
  Rel(api_routes, resend_email, "Briefing emails (morning + evening)", "HTTPS")
```

### Container narrative

| Container | Technology | Key responsibility |
|---|---|---|
| **Dashboard UI** | Next.js 15 App Router, RSC + client | Everything the owner sees and clicks. No trading logic here — all state in Supabase, all actions via API routes. |
| **API Routes** | Next.js API routes, `force-dynamic` | Auth-gated entry points for all agent triggers, order submissions, and admin ops. `requireOwner()` or `verifyCronSecret()` on every route. |
| **Agent Engine** | TypeScript, multi-LLM | 12 agents. All read/write Supabase tables — never call each other directly. Scoring is deterministic; LLMs write text only. |
| **LLM Router** | `lib/llm-router.ts` | Single choke point for all LLM traffic. Tier aliases, cost logging, Langfuse traces, graceful fallback on deprecated models. |
| **Money-Safety Gateway** | `lib/autonomy.ts` | 9 sequential gates before any live order byte leaves the system. `AUTONOMOUS_LIVE_ENABLED = false` is a compile-time constant. |
| **Robinhood MCP Client** | `lib/robinhood-mcp-client.ts` | PKCE S256 OAuth + CAS token refresh. Allowlist enforces only the agentic account can place orders. |
| **Kite Connect Client** | `lib/kite-client.ts` | Daily token refresh (expires 6 AM IST). GTT two-leg bracket placed immediately after every BUY. |
| **RAG Trade Memory** | `lib/rag.ts`, pgvector | Embeds closed trades on close, retrieves similar setups before scoring. Off when `VOYAGE_API_KEY` absent. |
| **Vault** | `lib/vault.ts` | Runtime-editable keys in Supabase — not in .env. Kite token, Robinhood OAuth, AV key, etc. |
| **System Health** | `lib/system-health.ts` | `issue_key` dedup prevents duplicate alerts. All reporters use same helpers. Dashboard card + briefing band. |

---

## 3. Level 3 — Component Diagrams

### 3.1 Research Pipeline

The research pipeline scores every candidate stock across 5 deterministic dimensions, then calls
Groq for a one-paragraph thesis. No LLM touches the scores.

```mermaid
C4Component
  title Component Diagram — Research Pipeline

  Person(cron, "Cron / Manual trigger", "Windows Task Scheduler or owner")

  Container_Boundary(research, "ResearchAgent — app/api/agents/research/") {
    Component(orchestrator, "Research Orchestrator", "TypeScript", "Coordinates batch: holdings first, then watchlist, then screener candidates. Caps at 3 candidates/day.")
    Component(screener, "Dual-Bucket Screener", "TypeScript + FMP API", "Momentum bucket: RSI>60, price>50d MA, revenue accel. Value bucket: P/E<sector, FCF yield, insider buys. Returns top 3 by score.")
    Component(scorer, "5-Dim Scorer", "TypeScript — deterministic, no LLM", "Computes fundamental_score, technical_score, sentiment_score, macro_score, insider_score. Reads champion weights from strategy_versions.")
    Component(thesis_writer, "Thesis Writer", "Groq llama-3.3-70b (fast tier), 512 tokens", "Receives all 5 scores + evidence. Writes 1-paragraph thesis + direction (long/short/neutral). Never generates scores.")
    Component(rag_reader, "RAG Reader", "lib/rag.ts + Voyage AI", "Before each score: embed live setup, retrieve top-5 similar past trades, rerank with rerank-2. Injects 'prior similar setups: 3/5 were wins' into thesis prompt.")
    Component(signal_writer, "Signal Writer", "TypeScript + Supabase", "Writes agent_signals (score+thesis), signal_score_history (trend), decision_observations (all candidates, even skipped), rag_traces (audit).")
  }

  Container(deepseek_agent, "DeepSeekAgent (parallel)", "app/api/agents/deepseek/", "Runs same scoring pipeline simultaneously. Writes to agent_signals with agent_label='deepseek'. Enables Claude vs DeepSeek P&L comparison.")

  ContainerDb(db, "Supabase", "PostgreSQL", "strategy_versions (champion weights), macro_regime, live_account_snapshots (holdings), watchlist, agent_signals, signal_score_history, decision_observations, trade_memories")

  System_Ext(fmp_api, "FinancialDatasets", "screen_stocks REST API")
  System_Ext(av_api, "Alpha Vantage", "RSI, EMA, OVERVIEW, NEWS_SENTIMENT, INSIDER_TRANSACTIONS")
  System_Ext(groq_api, "Groq", "llama-3.3-70b-versatile")
  System_Ext(voyage_api, "Voyage AI", "voyage-3.5 embed + rerank-2")

  Rel(cron, orchestrator, "POST /api/agents/research/cron?market=us|india", "HTTPS + cron-secret")
  Rel(orchestrator, screener, "Fetch 3 candidates for today's batch")
  Rel(screener, fmp_api, "screen_stocks (momentum + value params)", "HTTPS")
  Rel(orchestrator, scorer, "Score each candidate")
  Rel(scorer, av_api, "RSI, EMA, OVERVIEW, NEWS_SENTIMENT, INSIDER_TRANSACTIONS", "HTTPS")
  Rel(scorer, db, "Read champion weights, macro_regime, live positions", "Supabase SDK")
  Rel(orchestrator, rag_reader, "Retrieve similar past trades before scoring")
  Rel(rag_reader, voyage_api, "Embed setup + rerank retrieved chunks", "HTTPS")
  Rel(rag_reader, db, "trade_memories pgvector nearest-neighbor query", "Supabase SDK")
  Rel(orchestrator, thesis_writer, "Pass all scores + evidence + RAG summary")
  Rel(thesis_writer, groq_api, "Generate thesis + direction", "HTTPS")
  Rel(orchestrator, signal_writer, "Write all outputs")
  Rel(signal_writer, db, "agent_signals, signal_score_history, decision_observations, rag_traces", "Supabase SDK")
```

---

### 3.2 Paper Trading Subsystem

```mermaid
C4Component
  title Component Diagram — Paper Trading Subsystem

  Person(cron, "Cron (10:05 AM ET US / 4:35 PM IST India)", "Windows Task Scheduler")

  Container_Boundary(paper, "PaperTrader — app/api/agents/paper-trade/") {
    Component(freshness_gate, "Signal Freshness Gate", "TypeScript", "Only fills signals created TODAY in the market's own timezone (NYC for US, Kolkata for India). Marks older signals expired. Prevents cron catching up to multi-day backlog.")
    Component(claim_lock, "Claim-and-Fill Protocol", "TypeScript + Supabase", "Stamps claim_run_id on agent_signals row before filling. Prevents two simultaneous cron runs from double-filling the same signal.")
    Component(risk_gates_paper, "Paper Risk Gates", "TypeScript", "Re-entry cooldown (5d block after close), pyramid gate (fill price must exceed avg_cost), long-only for new positions (SELL only if held).")
    Component(sizer, "Position Sizer", "TypeScript", "position_size_pct from champion genome, clamped to strategy_config cap. Slippage model: +0.05% above mid. Records expected_price + realized_slip_pct.")
    Component(fill_writer, "Fill Writer", "TypeScript + Supabase", "Opens paper_positions row, writes paper_trades (buy leg), appends paper_order_events (submitted+filled), debits paper_portfolio.cash.")
  }

  Container_Boundary(monitor, "PositionMonitor — app/api/agents/position-monitor/") {
    Component(price_fetcher, "Price Fetcher", "TypeScript + AV/Yahoo", "Fetches current price for every open paper_position in the market.")
    Component(exit_engine, "Exit Engine", "TypeScript — deterministic", "Priority order: (1) time stop: age > horizon_days → close, (2) trailing stop: price < highest×0.93 → close, (3) price target: sell half → move stop to breakeven, (4) score drop: analyst_score below exit threshold → close.")
    Component(nav_circuit, "NAV Circuit Breaker", "TypeScript", "If weekly paper NAV return < -5%: set strategy_config.app_paused=true + fire critical agent_alerts row.")
    Component(bench_sync, "Benchmark Sync", "TypeScript + AV/Yahoo", "Upsert paper_performance.bench_nav with today's VOO (US) or ^NSEI (India) price for alpha computation.")
    Component(rag_writer, "RAG Indexer", "lib/rag.ts + Voyage AI", "On close: build setup text, embed with voyage-3.5, store in trade_memories. Tainted / excluded trades skipped.")
  }

  ContainerDb(db, "Supabase", "PostgreSQL + pgvector", "agent_signals, paper_positions, paper_trades, paper_order_events, paper_portfolio, paper_performance, trade_memories, strategy_versions, strategy_config")

  System_Ext(price_api, "Alpha Vantage / Yahoo Finance", "Live price quotes")
  System_Ext(voyage_api, "Voyage AI", "voyage-3.5 embeddings")

  Rel(cron, freshness_gate, "POST /api/agents/paper-trade?market=us|india", "HTTPS")
  Rel(freshness_gate, claim_lock, "Pass only fresh signals")
  Rel(claim_lock, db, "Stamp claim_run_id on agent_signals", "Supabase SDK")
  Rel(claim_lock, risk_gates_paper, "Pass claimed signal")
  Rel(risk_gates_paper, db, "Check re-entry cooldown, open positions, avg_cost", "Supabase SDK")
  Rel(risk_gates_paper, sizer, "Compute fill size")
  Rel(sizer, db, "Read champion genome, strategy_config, paper_portfolio.cash", "Supabase SDK")
  Rel(sizer, fill_writer, "Execute fill")
  Rel(fill_writer, db, "Write paper_positions, paper_trades, paper_order_events, debit cash", "Supabase SDK")
  Rel(cron, price_fetcher, "POST /api/agents/position-monitor?market=us|india", "HTTPS")
  Rel(price_fetcher, price_api, "GET current price per open position", "HTTPS")
  Rel(price_fetcher, exit_engine, "Pass prices")
  Rel(exit_engine, db, "Update paper_positions.highest_price, close positions, update paper_trades", "Supabase SDK")
  Rel(exit_engine, rag_writer, "On close: index the trade")
  Rel(rag_writer, voyage_api, "voyage-3.5 embed", "HTTPS")
  Rel(rag_writer, db, "trade_memories pgvector insert", "Supabase SDK")
  Rel(exit_engine, nav_circuit, "Check weekly NAV drawdown")
  Rel(nav_circuit, db, "Set strategy_config.app_paused, write agent_alerts", "Supabase SDK")
  Rel(exit_engine, bench_sync, "Upsert benchmark NAV")
  Rel(bench_sync, price_api, "VOO or ^NSEI close price", "HTTPS")
  Rel(bench_sync, db, "paper_performance.bench_nav upsert", "Supabase SDK")
```

---

### 3.3 Learning & Evolution Loop

```mermaid
C4Component
  title Component Diagram — Learning & Evolution Loop

  Person(cron, "Cron (Fridays 5 PM ET)", "Windows Task Scheduler")
  Person(owner, "Owner", "Promotes Challenger → Champion in dashboard")

  Container_Boundary(learner, "LearnerAgent — app/api/agents/learner/") {
    Component(phase_gate, "Phase Gate", "TypeScript", "Blocks mutation if < 10 closed trades per market. Returns early with 'insufficient data' message.")
    Component(auto_guard, "Auto-Guard", "TypeScript", "Blocks mutation if last 3 runs win_rate < 35%. Prevents learning from a bad run streak.")
    Component(tool_loop, "9-Tool Loop", "Claude Opus 4.8 — runAgentLoop()", "Multi-step tool-calling loop. 9 tools: get_closed_trades, get_signal_weights, get_strategy_versions, get_decision_observations, query_trade_decisions, propose_challenger, run_validation, get_mentor_insights, semantic_search_decisions.")
    Component(challenger_proposer, "Challenger Proposer", "TypeScript + Supabase", "Tool: propose_challenger. Writes strategy_versions row with new 5-dim weights + genome (entry_threshold, exit_stop_pct, exit_target_pct, horizon_days, position_size_pct, sizing_mode).")
    Component(validation_engine, "Validation Engine", "TypeScript — deterministic, no LLM", "Tool: run_validation. Walk-forward backtest on held-out decision_observations folds. Gates: Sharpe ≥ 0.5 + win_rate ≥ 40%. Writes experiment_runs row.")
    Component(weight_logger, "Weight Logger", "TypeScript + Supabase", "Per-trade: writes 1-sentence outcome note to learning_log. Tracks every proposed/rejected mutation.")
  }

  Container_Boundary(promotion, "Strategy Registry — /dashboard/learning") {
    Component(version_list, "Champion/Challenger List", "React client component", "Displays all strategy_versions for each market with backtest results and health labels.")
    Component(promote_btn, "Promote Button", "React + /api/strategies/versions", "Owner clicks. API checks eligibility_passed=true (HTTP 412 if not). Sets is_champion=true + promoted_at. Previous champion retired.")
    Component(shadow_runner, "Shadow Runner (optional)", "TypeScript", "A Challenger with shadow=true records what it would have done on live runs — no fills, no cash — a free dress rehearsal.")
  }

  Container_Boundary(performance, "Performance Truth Layer — /api/agents/evaluation/") {
    Component(mandate_eval, "Mandate Evaluator", "TypeScript — deterministic, no LLM", "Computes Sharpe, Sortino, max_drawdown, win_rate, expectancy, profit_factor, alpha, exec_slip_mean for a named investment mandate.")
    Component(honesty_rules, "Honesty Rules", "TypeScript", "< 20 trades → shows 'too small' not a number. Tainted trades counted in book but labeled. health_label: insufficient_sample → negative_edge → promising → validation_required.")
    Component(p1_gate_cron, "P1 Gate Cron", "Vercel cron — Sundays 02:00 UTC", "Counts closed evaluable trades. Fires info agent_alert when ≥ 20. Signal to build opportunity-level IC metrics.")
  }

  ContainerDb(db, "Supabase", "PostgreSQL", "paper_trades, decision_observations, strategy_versions, experiment_runs, learning_log, strategy_evaluations (append-only), investment_mandates, learning_priors, learning_priors_history")

  System_Ext(claude_opus, "Anthropic Claude Opus 4.8", "Best reasoning for weight proposals")

  Rel(cron, phase_gate, "POST /api/agents/learner (Fridays only, skips other days)", "HTTPS + cron-secret")
  Rel(phase_gate, auto_guard, "Pass if ≥ 10 closed trades")
  Rel(auto_guard, tool_loop, "Pass if last 3 runs win_rate ≥ 35%")
  Rel(tool_loop, claude_opus, "Multi-step tool-calling loop", "Anthropic SDK")
  Rel(tool_loop, challenger_proposer, "Tool: propose_challenger")
  Rel(challenger_proposer, db, "Write strategy_versions (Challenger) row", "Supabase SDK")
  Rel(tool_loop, validation_engine, "Tool: run_validation on proposed Challenger")
  Rel(validation_engine, db, "Read decision_observations, write experiment_runs", "Supabase SDK")
  Rel(tool_loop, db, "Read: paper_trades, signal_weights, strategy_versions, decision_observations, trade_memories", "Supabase SDK")
  Rel(tool_loop, weight_logger, "Write 1-sentence outcome note per closed trade")
  Rel(weight_logger, db, "learning_log + learning_priors_history", "Supabase SDK")
  Rel(owner, version_list, "Views Challengers + backtest results")
  Rel(owner, promote_btn, "Clicks Promote to make Challenger the new Champion")
  Rel(promote_btn, db, "Set is_champion=true on Challenger, retired_at on old Champion", "Supabase SDK via /api/strategies/versions")
  Rel(mandate_eval, db, "Read paper_trades filtered by mandate_id, write strategy_evaluations", "Supabase SDK")
  Rel(mandate_eval, honesty_rules, "Apply health_label logic to metrics")
  Rel(p1_gate_cron, db, "Count closed evaluable trades, write agent_alerts", "Supabase SDK")
```

---

### 3.4 Money-Safety Gateway

Every live order in Kairos passes through 9 sequential gates. Failure at any gate returns an error
and no order is sent. This component is the most security-critical in the system.

```mermaid
C4Component
  title Component Diagram — Money-Safety Gateway (9 Gates)

  Person(owner, "Owner", "Must click send — the only human who can authorize a live order")
  Container(api_order_route, "Order API Route", "app/api/broker/orders/route.ts", "Entry point for US live orders. Calls gateway in sequence.")

  Container_Boundary(gateway, "Money-Safety Gateway — lib/autonomy.ts + lib/broker-resolver.ts") {
    Component(gate1_auth, "Gate 1: Owner-Only Auth", "requireOwner() — lib/auth/require-owner.ts", "Supabase session must be authenticated as the owner email. No agent bypasses this — it creates its own client.")
    Component(gate2_ladder, "Gate 2: Autonomy Ladder", "lib/autonomy.ts", "strategy_config.autonomy_level must be ≥ L3_live_manual. L4/L5 exist in config but AUTONOMOUS_LIVE_ENABLED=false is hardcoded. Behaves as L3 always.")
    Component(gate3_enabled, "Gate 3: Trading Enabled", "lib/broker-resolver.ts", "strategy_config.robinhood_mcp_enabled AND broker_accounts.enabled for the agentic account must both be true. Returns 409 if disabled.")
    Component(gate4_kill, "Gate 4: Kill Switches", "lib/autonomy.ts", "Checks: daily loss exceeded, drawdown from peak exceeded, 30-day win_rate too low. Each trip fires an agent_alert. No auto-resume — owner must clear.")
    Component(gate5_quality, "Gate 5: Signal Data Quality (G1)", "lib/autonomy.ts", "Rejects live BUY built on signal with data_confidence < 0.5 unless owner explicitly overrides. Prevents thin-evidence signal from driving real money.")
    Component(gate6_perorder, "Gate 6: Per-Order Cap", "lib/autonomy.ts", "Order notional must be ≤ broker_accounts.notional_cap_usd. Owner sets this in Settings → Live Order Limits.")
    Component(gate7_daily, "Gate 7: Daily Total Cap + Trade Count", "lib/autonomy.ts", "Cumulative daily buying checked atomically (compare-and-set). Both dollar cap and max trades/day enforced. Two fast clicks cannot slip past.")
    Component(gate8_concentration, "Gate 8: Portfolio Concentration (G3)", "lib/autonomy.ts + RH MCP / Kite", "Fetches live account: equity + positions via Robinhood MCP (US) or Kite margins + holdings (India). Blocks if BUY over-concentrates. Fails closed if holdings indeterminate.")
    Component(gate9_drift, "Gate 9: Price Drift Check", "lib/autonomy.ts + market data", "Fetches fresh quote immediately before send. If live price drifted > X% from signal price, holds order and flags for reconciliation.")
  }

  Container(rh_mcp, "Robinhood MCP Client", "lib/robinhood-mcp-client.ts", "review_equity_order → place_equity_order")
  ContainerDb(db, "Supabase", "PostgreSQL", "strategy_config, broker_accounts, broker_orders, agent_alerts, paper_trades (win_rate)")

  Rel(owner, api_order_route, "POST /api/broker/orders (must be logged in)", "HTTPS browser")
  Rel(api_order_route, gate1_auth, "Step 1: verify owner session")
  Rel(gate1_auth, gate2_ladder, "Pass → check autonomy level")
  Rel(gate2_ladder, db, "Read strategy_config.autonomy_level", "Supabase SDK")
  Rel(gate2_ladder, gate3_enabled, "Pass → check trading enabled")
  Rel(gate3_enabled, db, "Read strategy_config.robinhood_mcp_enabled + broker_accounts.enabled", "Supabase SDK")
  Rel(gate3_enabled, gate4_kill, "Pass → check kill switches")
  Rel(gate4_kill, db, "Read daily loss, drawdown flags, 30d win_rate from paper_trades", "Supabase SDK")
  Rel(gate4_kill, gate5_quality, "Pass → check signal data quality")
  Rel(gate5_quality, gate6_perorder, "Pass → check per-order cap")
  Rel(gate6_perorder, db, "Read broker_accounts.notional_cap_usd", "Supabase SDK")
  Rel(gate6_perorder, gate7_daily, "Pass → check daily cap")
  Rel(gate7_daily, db, "Atomic CAS check on daily totals", "Supabase SDK")
  Rel(gate7_daily, gate8_concentration, "Pass → check concentration")
  Rel(gate8_concentration, rh_mcp, "Fetch live account equity + positions", "JSON-RPC")
  Rel(gate8_concentration, gate9_drift, "Pass → check price drift")
  Rel(gate9_drift, rh_mcp, "Fetch fresh quote", "JSON-RPC")
  Rel(gate9_drift, rh_mcp, "All gates pass → place_equity_order", "JSON-RPC")
  Rel(rh_mcp, db, "Write broker_orders row (status, needsReconcile)", "Supabase SDK")
```

---

### 3.5 System Health Funnel

```mermaid
C4Component
  title Component Diagram — System Health Funnel

  Container_Boundary(reporters, "Health Reporters (any subsystem)") {
    Component(model_check, "Model Deprecation Check", "app/api/models/check/route.ts", "Detects deprecated or newer-available models. issue_key: model-deprecated:<model>.")
    Component(av_guard, "AV Budget Guard", "lib/av-cache.ts", "Fires when daily Alpha Vantage call limit reached. issue_key: av-budget-exhausted. auto_expire_at=midnight UTC.")
    Component(kill_reporter, "Kill Switch Reporter", "lib/autonomy.ts", "Fires when daily-loss, drawdown, or accuracy threshold tripped. issue_key: kill-switch-tripped:<market>.")
    Component(reconcile_reporter, "Reconcile Reporter", "lib/robinhood-mcp-client.ts", "Fires when live order gets no broker order ID. issue_key: order-needs-reconcile:<orderId>.")
    Component(token_reporter, "Token Expiry Reporter", "lib/robinhood-mcp-client.ts + lib/kite-client.ts", "Fires on failed token refresh. issue_key: robinhood-token-expired or kite-token-expired.")
    Component(nav_reporter, "NAV Circuit Reporter", "app/api/agents/position-monitor/", "Fires when weekly NAV < -5%. issue_key: nav-drawdown-circuit-breaker:<market>.")
    Component(stale_reporter, "Stale Agent Reporter", "app/api/alerts/stale-check/", "Every 4h: checks agent_runs recency. Fires if last run is stale.")
  }

  Container_Boundary(health_core, "System Health Core — lib/system-health.ts") {
    Component(report_fn, "reportIssue()", "TypeScript", "Upsert by issue_key on open rows (partial unique index). Never creates duplicate open alert for same condition. Refreshes detail, severity, auto_expire_at.")
    Component(resolve_fn, "resolveIssue()", "TypeScript", "Sets resolved=true + resolved_at=now() when condition clears. Called by token refresh success, cron success, owner manual clear.")
    Component(triage_agent, "Health-Triage Agent", "Claude Haiku 4.5 — claude-fast tier", "Read-only diagnostic. Reads all open alerts + recent agent_runs + LLM cost + AV budget. Writes structured_issues JSON per alert: {root_cause, blast_radius, suggested_fix}. Never mutates config or money.")
  }

  Container_Boundary(surfaces, "Surfaces") {
    Component(health_card, "SystemHealthCard", "components/dashboard/SystemHealthCard.tsx", "Dashboard home widget. Green when clean. Severity-ranked open alerts. Deep-link fix hints. Tier-1 safe actions one-click (retry, resolve info/warn).")
    Component(brief_band, "Open Issues Band", "lib/briefing.ts", "Every briefing email includes open_alerts section. Critical/error alerts block the green headline.")
  }

  ContainerDb(db, "Supabase", "PostgreSQL", "agent_alerts (partial unique index on issue_key WHERE resolved=false), agent_runs, llm_call_log")

  Rel(model_check, report_fn, "reportIssue({ issueKey: 'model-deprecated:...', severity: 'warn' })")
  Rel(av_guard, report_fn, "reportIssue({ issueKey: 'av-budget-exhausted', autoExpireAt: midnight })")
  Rel(kill_reporter, report_fn, "reportIssue({ issueKey: 'kill-switch-tripped:<market>', severity: 'critical' })")
  Rel(reconcile_reporter, report_fn, "reportIssue({ issueKey: 'order-needs-reconcile:<id>', severity: 'error' })")
  Rel(token_reporter, report_fn, "reportIssue({ issueKey: 'kite-token-expired', severity: 'warn' })")
  Rel(nav_reporter, report_fn, "reportIssue({ issueKey: 'nav-drawdown-circuit-breaker:<m>', severity: 'critical' })")
  Rel(stale_reporter, report_fn, "reportIssue({ issueKey: 'cron-stale:<agent>', severity: 'warn' })")
  Rel(report_fn, db, "UPSERT agent_alerts WHERE issue_key (open unique)", "Supabase SDK")
  Rel(resolve_fn, db, "UPDATE agent_alerts SET resolved=true WHERE issue_key AND open", "Supabase SDK")
  Rel(triage_agent, db, "Read agent_alerts, agent_runs, llm_call_log. Write structured_issues field.", "Supabase SDK")
  Rel(health_card, db, "Read open agent_alerts ordered by severity", "Supabase SDK")
  Rel(brief_band, db, "Read open agent_alerts for briefing inclusion", "Supabase SDK")
```

---

## 4. Level 4 — Dynamic / Code-Level Flows

### 4.1 A Stock Scored End-to-End

```mermaid
C4Dynamic
  title Flow: ACME scored and filled in paper portfolio (US)

  Person(scheduler, "Windows Task Scheduler", "9:00 AM ET")
  Container(research_route, "Research API Route", "app/api/agents/research/cron")
  Component(orchestrator_c, "Orchestrator", "Selects candidates")
  Component(scorer_c, "5-Dim Scorer", "Deterministic scoring")
  Component(groq_call, "Groq (fast tier)", "Thesis generation")
  Component(signal_write, "Signal Writer", "Supabase writes")
  Container(paper_route, "PaperTrader API Route", "app/api/agents/paper-trade (10:05 AM ET)")
  Component(claim_c, "Claim Lock", "Atomic claim_run_id stamp")
  Component(fill_c, "Fill Writer", "Opens paper position")
  ContainerDb(db_c, "Supabase", "All tables")

  Rel(scheduler, research_route, "1. POST /api/agents/research/cron?market=us", "HTTPS + cron-secret")
  Rel(research_route, orchestrator_c, "2. Start research batch")
  Rel(orchestrator_c, scorer_c, "3. Score ACME across 5 dimensions (no LLM)")
  Rel(scorer_c, db_c, "4. Read champion weights, macro_regime", "Supabase SDK")
  Rel(orchestrator_c, groq_call, "5. Generate thesis (all scores as input)")
  Rel(orchestrator_c, signal_write, "6. Write agent_signals (score=78, thesis, status=pending)")
  Rel(signal_write, db_c, "7. agent_signals + signal_score_history + decision_observations", "Supabase SDK")
  Rel(scheduler, paper_route, "8. POST /api/agents/paper-trade?market=us (10:05 AM ET)")
  Rel(paper_route, db_c, "9. Fetch pending signals created today (freshness gate)")
  Rel(paper_route, claim_c, "10. Stamp claim_run_id on ACME signal (atomic)")
  Rel(claim_c, db_c, "11. UPDATE agent_signals SET claim_run_id=... WHERE id=ACME AND claim_run_id IS NULL", "Supabase SDK")
  Rel(paper_route, fill_c, "12. Sizer: 10% of $10k pool = $1000, fill at $102.55 (+0.05% slip)")
  Rel(fill_c, db_c, "13. INSERT paper_positions, paper_trades (buy), paper_order_events, DEBIT paper_portfolio.cash", "Supabase SDK")

  UpdateRelStyle(scheduler, research_route, $textColor="green", $offsetY="-10")
  UpdateRelStyle(scheduler, paper_route, $textColor="green", $offsetY="-10")
  UpdateRelStyle(claim_c, db_c, $textColor="red", $offsetY="-5")
```

---

### 4.2 Robinhood OAuth PKCE S256 Flow

```mermaid
C4Dynamic
  title Flow: Robinhood OAuth PKCE S256 (loopback)

  Person(owner_b, "Owner Browser", "Clicks Connect Robinhood in Settings")
  Container(login_route, "Login Route", "app/api/robinhood/login")
  Container(callback_route, "Callback Route", "app/api/robinhood/callback")
  Container(vault_c, "API Key Vault", "lib/vault.ts + api_key_vault table")
  System_Ext(rh_oauth, "Robinhood OAuth Server", "Authorization endpoint")

  Rel(owner_b, login_route, "1. GET /api/robinhood/login")
  Rel(login_route, login_route, "2. Generate code_verifier (64 random bytes). code_challenge = base64url(SHA256(verifier))")
  Rel(login_route, owner_b, "3. Set httpOnly cookie (code_verifier, 5-min TTL). Redirect to Robinhood /oauth2/auth?code_challenge=&method=S256")
  Rel(owner_b, rh_oauth, "4. User approves on Robinhood UI")
  Rel(rh_oauth, owner_b, "5. Redirect to localhost callback?code=AUTH_CODE&state=")
  Rel(owner_b, callback_route, "6. GET /api/robinhood/callback?code=AUTH_CODE")
  Rel(callback_route, callback_route, "7. Retrieve verifier from cookie. Verify state. POST /oauth2/token with {code, code_verifier}")
  Rel(callback_route, rh_oauth, "8. Token exchange (server-side)")
  Rel(rh_oauth, callback_route, "9. {access_token, refresh_token, expires_in}")
  Rel(callback_route, vault_c, "10. vaultSet('ROBINHOOD_ACCESS_TOKEN', token). vaultSet('ROBINHOOD_REFRESH_TOKEN', refresh)")
  Rel(callback_route, owner_b, "11. Redirect to /dashboard/settings?connected=robinhood")

  UpdateRelStyle(callback_route, callback_route, $textColor="purple", $offsetX="5")
  UpdateRelStyle(callback_route, rh_oauth, $textColor="blue")
```

---

### 4.3 Zerodha Kite GTT Bracket After India BUY

```mermaid
C4Dynamic
  title Flow: Kite India live BUY + immediate GTT bracket

  Person(owner_kite, "Owner", "Clicks BUY on India panel")
  Container(kite_route, "Kite Order Route", "app/api/kite/order")
  Container(gateway_c, "Money-Safety Gateway", "9 gates")
  Container(kite_cl, "Kite Connect Client", "lib/kite-client.ts")
  System_Ext(kite_api, "Kite Connect v3", "NSE order + GTT API")
  ContainerDb(db_kite, "Supabase", "broker_orders, decision_journal, agent_alerts")

  Rel(owner_kite, kite_route, "1. POST /api/kite/order {symbol, qty, price_target, stop_loss}")
  Rel(kite_route, gateway_c, "2. Run all 9 gates (owner auth + trading enabled + kill switches + caps + concentration)")
  Rel(gateway_c, kite_cl, "3. All gates pass → execute order")
  Rel(kite_cl, kite_api, "4. POST /orders/regular (CNC delivery, LIMIT)", "REST / HTTPS")
  Rel(kite_api, kite_cl, "5. {order_id: 'KT123'}")
  Rel(kite_cl, db_kite, "6. INSERT broker_orders row. INSERT decision_journal entry")
  Rel(kite_cl, kite_api, "7. POST /gtt/triggers — Leg 1: SL-M SELL at stop_loss. Leg 2: LIMIT SELL at price_target", "REST / HTTPS")
  Rel(kite_api, kite_cl, "8. {trigger_id: 'GTT456'}")
  Rel(kite_cl, db_kite, "9. UPDATE broker_orders SET gtt_id='GTT456'")
  Rel(kite_route, owner_kite, "10. {ok: true, orderId: 'KT123', gttId: 'GTT456'}")

  UpdateRelStyle(kite_cl, kite_api, $textColor="blue", $offsetY="-10")
  UpdateRelStyle(gateway_c, kite_cl, $textColor="green", $offsetY="5")
```

---

### 4.4 LearnerAgent Tool-Use Loop (Fridays)

```mermaid
C4Dynamic
  title Flow: LearnerAgent proposes a Challenger strategy (Fridays)

  Person(scheduler_l, "Windows Task Scheduler", "Friday 5:00 PM ET")
  Container(learner_route, "Learner Route", "app/api/agents/learner")
  Component(phase_gate_l, "Phase Gate", "≥ 10 closed trades required")
  Component(auto_guard_l, "Auto-Guard", "Win rate ≥ 35% required")
  Component(tool_loop_l, "9-Tool Loop", "runAgentLoop() — Claude Opus 4.8")
  Component(challenger_prop, "propose_challenger tool", "Writes strategy_versions")
  Component(validation_l, "run_validation tool", "Walk-forward backtest")
  ContainerDb(db_l, "Supabase", "paper_trades, decision_observations, strategy_versions, experiment_runs, learning_log")
  System_Ext(opus, "Claude Opus 4.8", "Best reasoning model")

  Rel(scheduler_l, learner_route, "1. POST /api/agents/learner (cron-secret)")
  Rel(learner_route, phase_gate_l, "2. Count closed trades per market")
  Rel(phase_gate_l, db_l, "3. SELECT count(*) FROM paper_trades WHERE closed_at IS NOT NULL")
  Rel(phase_gate_l, auto_guard_l, "4. Pass (≥ 10 trades)")
  Rel(auto_guard_l, db_l, "5. Check last 3 runs win_rate")
  Rel(auto_guard_l, tool_loop_l, "6. Pass (win_rate ≥ 35%)")
  Rel(tool_loop_l, opus, "7. Send tools + system prompt. Start multi-step loop", "Anthropic SDK")
  Rel(opus, tool_loop_l, "8. Tool call: get_closed_trades")
  Rel(tool_loop_l, db_l, "9. SELECT paper_trades WHERE outcome IS NOT NULL LIMIT 50")
  Rel(opus, tool_loop_l, "10. Tool call: propose_challenger {weights, genome}")
  Rel(tool_loop_l, challenger_prop, "11. Execute propose_challenger")
  Rel(challenger_prop, db_l, "12. INSERT strategy_versions (is_champion=false, market='us')")
  Rel(opus, tool_loop_l, "13. Tool call: run_validation {strategy_version_id}")
  Rel(tool_loop_l, validation_l, "14. Walk-forward backtest on held-out folds")
  Rel(validation_l, db_l, "15. Read decision_observations. Write experiment_runs (Sharpe=0.72, win_rate=58%, eligibility_passed=true)")
  Rel(tool_loop_l, db_l, "16. Write learning_log (1-sentence notes per closed trade)")
  Rel(tool_loop_l, learner_route, "17. Return: proposed Challenger ID + backtest summary")
```

---

### 4.5 RAG Trade Memory: Write and Read

```mermaid
C4Dynamic
  title Flow: RAG — Write on close, Read before scoring

  Container(monitor_rag, "PositionMonitor", "On position close")
  Component(rag_writer_l, "indexClosedTrade()", "lib/rag.ts")
  ContainerDb(db_rag, "trade_memories", "pgvector(1024)")
  System_Ext(voyage_rag, "Voyage AI", "voyage-3.5 + rerank-2")
  Container(research_rag, "ResearchAgent", "Before scoring a new candidate")
  Component(rag_reader_l, "retrieveSimilarTrades()", "lib/rag.ts")
  Component(thesis_rag, "Thesis Writer", "Groq — receives RAG summary")

  Rel(monitor_rag, rag_writer_l, "1. Trade closed: {symbol, scores, outcome, exit_reason}")
  Rel(rag_writer_l, rag_writer_l, "2. Build text: 'AAPL technical=72 fundamental=68 ... outcome=win exit=target'")
  Rel(rag_writer_l, voyage_rag, "3. POST embed(text, model=voyage-3.5) → vector[1024]", "HTTPS")
  Rel(rag_writer_l, db_rag, "4. INSERT trade_memories {text, embedding, metadata: {symbol, outcome, mandate_id}}", "Supabase SDK pgvector")
  Rel(research_rag, rag_reader_l, "5. Before scoring ACME: retrieveSimilarTrades('ACME', scores)")
  Rel(rag_reader_l, voyage_rag, "6. Embed live ACME setup → query vector[1024]", "HTTPS")
  Rel(rag_reader_l, db_rag, "7. SELECT * FROM trade_memories ORDER BY embedding <=> $1 LIMIT 10 (cosine ANN)", "Supabase SDK pgvector")
  Rel(rag_reader_l, voyage_rag, "8. Rerank top-10 with rerank-2 → top-5 most similar", "HTTPS")
  Rel(rag_reader_l, research_rag, "9. Return: 'prior similar setups: 3/5 were wins (avg pnl +14%)'")
  Rel(research_rag, thesis_rag, "10. Inject RAG summary into thesis prompt")
  Rel(rag_reader_l, db_rag, "11. INSERT rag_traces {symbol, query_text, retrieved_ids, reranked_ids, summary}", "Supabase SDK")

  UpdateRelStyle(rag_writer_l, voyage_rag, $textColor="purple")
  UpdateRelStyle(rag_reader_l, voyage_rag, $textColor="purple")
```

---

### 4.6 Live Order Through 9-Gate Safety Funnel

```mermaid
C4Dynamic
  title Flow: Live order through 9-gate safety funnel (US)

  Person(owner_g, "Owner", "Clicks 'Place Live Order' in dashboard")
  Container(order_api, "Order API Route", "POST /api/broker/orders")
  Component(g1, "Gate 1: requireOwner()", "Supabase session check")
  Component(g2, "Gate 2: Autonomy Ladder", "AUTONOMOUS_LIVE_ENABLED=false constant")
  Component(g3, "Gate 3: Trading Enabled", "robinhood_mcp_enabled + broker enabled")
  Component(g4, "Gate 4: Kill Switches", "loss / drawdown / accuracy checks")
  Component(g5, "Gate 5: Data Quality", "data_confidence ≥ 0.5")
  Component(g6, "Gate 6: Per-Order Cap", "notional ≤ notional_cap_usd")
  Component(g7, "Gate 7: Daily Cap (CAS)", "atomic compare-and-set")
  Component(g8, "Gate 8: Concentration (G3)", "live account equity + positions")
  Component(g9, "Gate 9: Price Drift", "fresh quote ± X%")
  Container(rh_mcp_g, "Robinhood MCP Client", "review → place")
  ContainerDb(db_g, "Supabase", "strategy_config, broker_accounts, broker_orders, agent_alerts")

  Rel(owner_g, order_api, "1. POST /api/broker/orders {symbol, action, qty}")
  Rel(order_api, g1, "2. requireOwner() — must be authenticated as owner")
  Rel(g1, db_g, "3. Supabase getUser() → verify email matches OWNER_EMAIL")
  Rel(g1, g2, "4. PASS")
  Rel(g2, g2, "5. Check AUTONOMOUS_LIVE_ENABLED constant (hardcoded false) + autonomy_level")
  Rel(g2, g3, "6. PASS (L3: manual always)")
  Rel(g3, db_g, "7. Read strategy_config.robinhood_mcp_enabled + broker_accounts.enabled")
  Rel(g3, g4, "8. PASS")
  Rel(g4, db_g, "9. Read daily_loss_flag, drawdown_flag, 30d win_rate from paper_trades")
  Rel(g4, g5, "10. PASS (no kill switch tripped)")
  Rel(g5, g6, "11. Check signal data_confidence ≥ 0.5")
  Rel(g6, db_g, "12. Read broker_accounts.notional_cap_usd")
  Rel(g6, g7, "13. PASS")
  Rel(g7, db_g, "14. CAS: read daily_total, check ≤ daily_cap + trades_today ≤ max_daily_trades")
  Rel(g7, g8, "15. PASS (atomic update succeeded)")
  Rel(g8, rh_mcp_g, "16. Fetch live account equity + positions")
  Rel(g8, g9, "17. PASS (concentration OK)")
  Rel(g9, rh_mcp_g, "18. Fetch fresh quote")
  Rel(g9, rh_mcp_g, "19. PASS — all 9 gates cleared → review_equity_order → place_equity_order")
  Rel(rh_mcp_g, db_g, "20. INSERT broker_orders {status: filled|needs_reconcile}")

  UpdateRelStyle(g2, g2, $textColor="red", $offsetX="80", $offsetY="-10")
  UpdateRelStyle(owner_g, order_api, $textColor="green")
  UpdateRelStyle(rh_mcp_g, db_g, $textColor="blue")
```

---

## 5. Deployment Diagram

```mermaid
C4Deployment
  title Kairos — Deployment Diagram

  Deployment_Node(owner_browser, "Owner's Browser", "Chrome / Safari") {
    Container(nextjs_client, "Next.js Client Bundle", "React, TypeScript", "Dashboard UI. RSC hydration on first load. Client components for charts, forms, interactive panels.")
  }

  Deployment_Node(vercel_cloud, "Vercel (Edge + Serverless)", "us-east-1 region") {
    Deployment_Node(vercel_app, "Next.js Serverless Functions", "Node.js 20 runtime") {
      Container(nextjs_server, "Next.js App Router", "Next.js 15, TypeScript", "RSC rendering, API route handlers, middleware (auth redirect). force-dynamic on all agent routes.")
    }
    Deployment_Node(vercel_crons, "Vercel Cron Jobs", "vercel.json — 2 crons") {
      Container(cron_p1, "P1 Gate Cron", "Sundays 02:00 UTC", "POST /api/agents/evaluation/p1-gate/cron — count closed trades")
      Container(cron_cleanup, "DB Cleanup Cron", "1st of month 03:00 UTC", "POST /api/agents/db-cleanup — prune 15 safe tables")
    }
  }

  Deployment_Node(owner_pc, "Owner's Windows PC", "Must be on for market hours") {
    Deployment_Node(task_scheduler, "Windows Task Scheduler", "14 scheduled tasks") {
      Container(ps_script, "run-agents.ps1", "PowerShell", "Calls each agent endpoint via HTTPS with CRON_SECRET header. Runs on market-hour schedule (see §7 SYSTEM_OVERVIEW).")
    }
  }

  Deployment_Node(supabase_cloud, "Supabase (AWS us-east-1)", "Managed PostgreSQL") {
    ContainerDb(postgres, "PostgreSQL 15", "Supabase hosted", "35+ tables. RLS policies. Migrations in supabase/migrations/.")
    ContainerDb(pgvector, "pgvector extension", "IVFFlat index", "trade_memories table. 1024-dim cosine similarity.")
    Container(supabase_auth, "Supabase Auth", "GoTrue", "Email/password auth. JWT sessions. Owner email gate on all API routes.")
  }

  Deployment_Node(llm_providers, "LLM Providers (cloud)") {
    Deployment_Node(anthropic_cloud, "Anthropic Cloud") {
      System_Ext(claude_deploy, "Claude API", "Haiku 4.5 / Sonnet 4.6 / Opus 4.8")
    }
    Deployment_Node(groq_cloud, "Groq Cloud") {
      System_Ext(groq_deploy, "Groq API", "llama-3.3-70b-versatile")
    }
    Deployment_Node(deepseek_cloud, "DeepSeek Cloud") {
      System_Ext(deepseek_deploy, "DeepSeek API", "deepseek-reasoner / deepseek-chat")
    }
  }

  Deployment_Node(data_providers, "External Data APIs (cloud)") {
    System_Ext(av_deploy, "Alpha Vantage", "25 calls/day free tier")
    System_Ext(massive_deploy, "Massive Market Data", "Candles, screener, options")
    System_Ext(yahoo_deploy, "Yahoo Finance", "Free, no auth — India .NS")
    System_Ext(nse_deploy, "NSE Public JSON", "Cookie handshake required")
    System_Ext(voyage_deploy, "Voyage AI", "voyage-3.5 + rerank-2")
  }

  Deployment_Node(brokers, "Broker APIs (cloud)") {
    System_Ext(rh_deploy, "Robinhood API", "OAuth PKCE S256 token in api_key_vault")
    System_Ext(kite_deploy, "Zerodha Kite Connect v3", "Daily token — expires 6 AM IST")
  }

  Rel(owner_browser, vercel_cloud, "HTTPS — dashboard pages + API calls", "TLS 1.3")
  Rel(owner_pc, vercel_cloud, "HTTPS — agent cron triggers via PowerShell", "TLS 1.3 + x-cron-secret header")
  Rel(vercel_app, supabase_cloud, "Supabase SDK — all DB reads/writes", "HTTPS + service role key (server) or anon key (client)")
  Rel(vercel_app, anthropic_cloud, "Anthropic SDK", "HTTPS + ANTHROPIC_API_KEY")
  Rel(vercel_app, groq_cloud, "Groq SDK", "HTTPS + GROQ_API_KEY (in vault)")
  Rel(vercel_app, deepseek_cloud, "OpenAI-compatible SDK", "HTTPS + DEEPSEEK_API_KEY")
  Rel(vercel_app, data_providers, "REST calls — price, technicals, screener, macro", "HTTPS")
  Rel(vercel_app, brokers, "Order placement + position read", "HTTPS — tokens in api_key_vault")
  Rel(vercel_crons, vercel_app, "HTTP POST (internal Vercel routing)", "x-cron-secret header")
```

---

## 6. Architecture Decision Summary

Key locked decisions (any proposed change must go through `PROJECT_DECISIONS.md`):

| Decision | What was decided | Why |
|---|---|---|
| **Zero agent-to-agent HTTP** | All agents communicate through Supabase tables only | Prevents hidden coupling, race conditions, and cascading failures. Tables are debuggable; direct calls are not. |
| **Deterministic scoring** | LLMs never generate scores; scoring is pure TypeScript math | Reproducibility. Two runs on the same data must produce the same score. LLM variance destroys this. |
| **Paper first** | Every strategy runs on pretend money before real money | Empirical evidence required before risking real capital. |
| **Human gate on live orders** | `AUTONOMOUS_LIVE_ENABLED = false` is a hardcoded constant | No autonomous live trading no matter what config says. This is a compile-time safety property, not a runtime flag. |
| **Claim-and-fill protocol** | `claim_run_id` atomic stamp before filling any signal | Prevents double-fills when two cron instances run simultaneously (e.g., Vercel cold-start + local overlap). |
| **Champion/Challenger governance** | Promotion requires `eligibility_passed=true` from Validation Engine | Evidence before belief. Prevents promoting a strategy that has not beaten the gates on held-out data. |
| **Dual-market, never-mixed pools** | US pool in USD, India pool in INR, no cross-market operations | Prevents currency mixing from creating meaningless P&L numbers. Introduced in migration 057. |
| **Robinhood account allowlist** | Only the agentic account can place orders; the read-only account is blocked | One compromised token cannot drain the wrong account. |
| **Partial unique index on issue_key** | `agent_alerts (issue_key) WHERE resolved = false` | At most one open alert per condition. `reportIssue()` is safe to call on every run without creating alert spam. |
| **Append-only ledgers** | `paper_trades`, `paper_order_events`, `broker_orders`, `decision_observations`, `strategy_evaluations` have DB triggers blocking UPDATE/DELETE | Financial audit trail is immutable. DB cleanup cron explicitly skips all of these. |
| **No Tailwind** | Inline styles + `T` color token objects only | Prevents utility class drift, forces a single consistent palette, makes dark/light theming explicit. |
| **Tier alias LLM routing** | `fast`, `reasoning`, `claude-fast`, `claude-smart`, `claude-opus` in `lib/llm-router.ts` | Model IDs change; tier aliases let us upgrade all agents at once by changing one file. |
| **GTT-first India exits** | GTT bracket placed immediately after every Kite BUY | Stops and targets are active even when Kairos is fully offline (Kite executes server-side). |

---

*C4 documentation written using the C4 model (Simon Brown). Diagrams use Mermaid C4 syntax (mermaid v10+).*
*Maintained per CLAUDE.md rule — update this file whenever an agent flow, container, or deployment changes.*
*Last updated: 2026-07-09*
