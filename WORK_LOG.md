# WORK_LOG.md — Active Task Tracker

> **All agents check this before starting work. Claim your task. Update when done.**
> Format: `| Task | Agent/Model | Status | Date | Notes |`

---

## Status Key
- `planned` — approved, not started
- `in_progress` — actively being worked on (DO NOT start if another agent claims this)
- `blocked` — waiting on dependency or Vaibhav decision
- `review` — done, needs Vaibhav or Reviewer check
- `completed` — shipped

---

## 🔴 In Progress

*(nothing currently)*

---

## ✅ Session 2026-07-05 (closed-loop learning, score history, exit de-confliction, Langfuse agent-loop tracing)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Closed-loop learning — ResearchAgent consumes champion weights | Claude | 2026-07-05 | `processSymbol` in `lib/research-agent.ts` now reads the promoted champion's `weights_snapshot` first (normalizing both key formats — seed `{fundamental:0.3}` vs challenger `{fundamental_weight:0.3}`), falling back to static `PROFILE_WEIGHTS` then `signal_weights` only when no champion is promoted. Loop was OPEN (promoted weights were never read); now CLOSED. `research_packets.raw_data` records `_using_champion_weights`. See Decision 24. |
| Score history — `signal_score_history` table + ScoreTrajectory | Claude | 2026-07-05 | Migration 054: append-only per-symbol score history (analyst_score + 5 dimensions, direction, source, created_at; RLS + `(symbol, created_at desc)` index; never mutated after insert). ResearchAgent appends best-effort per score (no-ops until migration applied) and injects a `SCORE TREND` note into the thesis prompt. New `GET /api/charts/score-history?symbol=X` feeds the symbol-detail chart (previously starved of data). PRD-specced, never built. See Decision 25. |
| LearnerAgent Phase B backstop de-confliction | Claude | 2026-07-05 | Phase A (smart `llm_exit` re-score) and Phase B (blunt >7-day time cutoff) raced; crude Phase B usually won. Phase B now skips any position already carrying the `llm_exit` flag and its cutoff moves 7 → 14 days, making it a last-resort backstop. `app/api/agents/learner/route.ts`. See Decision 26. |
| Langfuse tracing extended to `runAgentLoop` | Claude | 2026-07-05 | The multi-step tool-calling loop (LearnerAgent, MentorAgent) was invisible in Langfuse (only `llm_call_log`); now wrapped in a Langfuse trace/generation span (system prompt in, final text out, tokens, cost, tool-call trail as metadata). Extends Decision 15. LangChain/LangGraph still unused — loop stays hand-rolled against Anthropic/DeepSeek SDKs. See Decision 27. |

---

## ✅ Session 2026-07-04 (late — bug sweep: sector chart, briefing, live account, paper prices, privacy mode)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Sector chart pagination fix + Massive 500-bar cap discovery | Claude | 2026-07-04 | `bc07c7a` — `next_url` wasn't followed on 1Y+ periods; fixed, then found a real provider limit: Massive free tier caps aggs responses at ~500 bars, no pagination beyond that |
| Sector chart replaced with real TradingView widget | Claude | 2026-07-04 | `77f371f` (Symbol Overview embed — didn't hydrate reliably) → `9f81fd5` (final: reused `TradingViewChart` tv.js Advanced Chart component from symbol detail page, tab switcher across 11 sector ETFs). Removed `components/charts/SectorLineChart.tsx` + `app/api/charts/sector-history/route.ts`. See Decision 21. |
| Weekend briefing recap | Claude | 2026-07-04 | `909bcc4` — weekend-specific editor's-note prompt synthesizing last 7 days + week ahead, replacing the bland "nothing to do" daily prompt |
| Newsletter history wiring | Claude | 2026-07-04 | `909bcc4` — `sendBriefingEmail` now also inserts into `newsletters` table on send; Intelligence → Newsletter tab was always empty before this |
| Market Synthesis cache-poisoning fix | Claude | 2026-07-04 | `909bcc4` — only cache synthesis result to `briefings` on success, not on transient Massive failure |
| Live Robinhood account $0/$0 fix | Claude | 2026-07-04 | `359b2c6` — upsert (not insert) on `live_account_snapshots`; added missing `.eq("account_id", "965848641")` filter everywhere reads lacked it; verified against real Robinhood app |
| Stale paper position prices fix (META stuck at entry price) | Claude | 2026-07-04 | `9165958` — `position-monitor` + `learner` routes queried nonexistent `closed_at` column, silently no-op'd every run since written; fixed queries, fixed `opened_at` column name, fixed stray polygon.io endpoint, rewrote close logic to match real schema (delete `paper_positions` row, close matching `paper_trades` row) |
| Alpha Vantage day-cache wired into batch quotes | Claude | 2026-07-04 | Same commit `9165958` — `getBatchQuotes`/`fetchAVQuote` were uncached, burning the 25/day AV quota on every Live Portfolio load |
| Live Portfolio false "-100% total loss" fix | Claude | 2026-07-04 | Same commit `9165958` — `q?.price ?? fallback` never triggered on explicit `price: 0`; now falls back to avg cost honestly |
| Briefing "Learning Log" query fix | Claude | 2026-07-04 | Same commit `9165958` — was querying nonexistent columns on `learning_log` (that table is the learner's own weight-mutation audit log); switched to querying recently-closed `paper_trades` |
| Privacy Mode (new feature) | Claude | 2026-07-04 | Eye-icon toggle masks live-account dollar figures on Dashboard home + Live Portfolio, default-hidden, resets on remount; master switch in Settings → Preferences (localStorage). `components/dashboard/PrivacyMask.tsx`. See Decision 22. **Uncommitted as of this entry.** |
| execClaude/MCP tool-calling architecture audit | Claude | 2026-07-04 | **NOT FIXED — flagged only.** `execClaude` cannot call MCP tools (no API key, no MCP config); every "tool call" it makes is trusted text output. Found in `research-agent.ts` screener, `mentor/evaluate`, and — highest severity — the real-money order paths `agents/trader` + `agents/trade/approve`. Requires explicit user sign-off before fixing. See Decision 23 and ARCHITECTURE.md "Known Architecture Risk" section. |
| ARCHITECTURE.md dashboard nav map | Claude | 2026-07-04 | Added full nav-item-by-nav-item map (path, what it shows, backing API/tables) so an external reviewer can test every page against documented behavior |

---

## ✅ Session 2026-07-01 (latest — Kairos rename + wiring)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Platform rename FinanceOS → Kairos | Claude | 2026-07-01 | layout.tsx title, package.json, DashboardShell sidebar brand + tagline "Right signal. Right moment." |
| BOM + encoding corruption fix | Claude | 2026-07-01 | PS5.1 corruption fixed across 14+ files; curly quotes, em dashes, emoji sequences all cleaned; build restored clean |
| market_focus wired to ResearchAgent | Claude | 2026-07-01 | `gatherSymbols()` queries profiles.market_focus; non-US regions append region ETFs (India/Europe/Asia/Crypto/Global); marketFocus passed to thesis LLM prompt |
| Learner schedule: weekly (Fridays only) | Claude | 2026-07-01 | Cron-triggered learner now skips Mon–Thu; only runs Fri 5 PM; manual triggers unrestricted |
| Cron script updated: trader + schedule | Claude | 2026-07-01 | Added `trader` endpoint; corrected schedule comments (08:00 brief → 09:00 research → 09:45 trader → 16:15 pos-monitor → 16:30 brief → 17:00 nav → Fri learner) |
| market_focus multi-select chip UI | Claude | 2026-07-01 | Settings page: chip buttons US/India/Europe/Asia/Crypto/Global; comma-separated text in DB |
| Weekend + holiday skip in research cron | Claude | 2026-07-01 | research/cron and learner routes skip weekends + 2026 US holidays |
| Newsletter wired: EDGAR, proposals, weights | Claude | 2026-07-01 | 3 new data queries + 3 new email sections; deployed as v4 |
| ARCHITECTURE.md + WORK_LOG updated | Claude | 2026-07-01 | Full session 2026-07-01 documented |

---

## ⚠️ Known Pending

| Item | Priority | Notes |
|---|---|---|
| Server restart required | HIGH | Running `npm start` with old build. `Ctrl+C` then `npm start` to apply Kairos rename + all July 2026 changes |
| TraderAgent → Robinhood place_equity_order wire | HIGH | Approve button in SmartMoney updates DB status but does NOT call `place_equity_order` on account 605420650 |
| InfoTooltip wiring across dashboard pages | MED | `components/dashboard/InfoTooltip.tsx` exists but not wired to individual cards |
| Schedule: Task Scheduler tasks need creating | MED | Windows Task Scheduler tasks documented in `scripts/run-agents.ps1` but not yet created as scheduled tasks |

---

## ✅ Session 2026-07-01 (continued)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Apply migration 035 — evidence_records | Vaibhav + Claude | 2026-07-01 | Applied. evidence_records (immutable), corporate_actions, macro_signals (vintage_at, indicators_json) |
| Apply migration 036 — strategy_registry | Vaibhav + Claude | 2026-07-01 | Applied. strategy_versions, experiment_runs, agent_signals←version_id, paper_performance←spy_nav/alpha; seeds v1.0.0 champion |
| Apply migration 037 — trader_proposals | Vaibhav + Claude | 2026-07-01 | Applied. trade_proposals (HARDCODED 605420660), decision_journal |
| SEC EDGAR Form 4 insider trades | Claude | 2026-07-01 | `/api/markets/edgar-insiders` — SEC.gov CIK lookup + Form 4 XML parse; writes notable buys to evidence_records; SmartMoneyPage "Form 4 (EDGAR)" tab with lazy-load table |
| knowledge/event-patterns/ population | Claude | 2026-07-01 | Created `event-patterns/macro-events.md` (Fed/CPI/NFP/ISM/auctions + agent scoring adjustments), `event-patterns/earnings-patterns.md` (PEAD/SUE/red flags/sector patterns), `signal-library/proven-signals.md` (10 signals + anti-signals + correlation matrix); KNOWLEDGE_INDEX updated |

---

## ✅ Session 2026-07-01 (latest)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Phase 0: `lib/data/quotes.ts` — deterministic quote adapter | Claude | 2026-07-01 | AV GLOBAL_QUOTE → price_cache fallback; freshness/stale detection; `computeFillPrice` (ask + 0.05% slippage) |
| Phase 0: `lib/data/technicals.ts` — RSI/EMA from candles | Claude | 2026-07-01 | Pure-math RSI(14), EMA(20/50) from OHLCV; `scoreTechnicals()` → 0-100 |
| Phase 0: `lib/data/scores.ts` — `computeScores()` | Claude | 2026-07-01 | All 5 scores deterministic: fundamental from AV OVERVIEW, technical from candles, sentiment from social, macro from macro_signals table, insider from AV transactions |
| Phase 0: `lib/data/evidence.ts` — evidence write helpers | Claude | 2026-07-01 | `writeEvidence`, `writeBatchEvidence`; SOURCE_TIERS map; fire-and-forget inserts to evidence_records |
| Phase 0: Migration 034 — paper_order_events | Claude + Vaibhav | 2026-07-01 | **Applied.** Append-only immutable event log; UPDATE/DELETE blocked by trigger; price provenance columns on paper_trades |
| Phase 0: `processSymbol` rewrite in research-agent | Claude | 2026-07-01 | LLM no longer generates scores; fetches AV OVERVIEW + candles → computeScores() → LLM writes thesis+direction only (512 tokens, Groq) |
| Phase 0: paper-trade route price upgrade | Claude | 2026-07-01 | Replaces execClaude/MCP price fetch with `getQuote()` + `computeFillPrice()`; writes immutable fill event to paper_order_events; SPY benchmark alpha tracking; decision journal entries |
| Phase 1: `lib/data/evidence.ts` + Migration 035 — evidence_records | Claude | 2026-07-01 | Migration **NOT YET APPLIED**. evidence_records table (append-only immutable); corporate_actions table; macro_signals altered (vintage_at, indicators_json) |
| Phase 1: `/api/agents/corporate-actions` — splits/dividends sync | Claude | 2026-07-01 | AV SPLITS + DIVIDENDS for held + watchlist symbols; upserts corporate_actions; GET filters by symbol/type/since |
| Phase 2: Migration 036 — strategy_registry | Claude | 2026-07-01 | **NOT YET APPLIED.** strategy_versions table; experiment_runs table; agent_signals ← strategy_version_id; paper_performance ← spy_nav/spy_return_pct/alpha_pct; seeds v1.0.0 Phase0-Baseline as champion |
| Phase 2: `/api/agents/backtest` — JS backtest engine | Claude | 2026-07-01 | Replays agent_signals vs price_cache candles; eligibility gate (Sharpe≥0.5, win_rate≥40%, drawdown<25%, min 20 trades, expectancy>0); persists to experiment_runs; SPY alpha |
| Phase 2: `/api/strategies/versions` — champion/challenger governance | Claude | 2026-07-01 | GET: list versions + nested runs; POST: promote_champion, retire, reject, or create new version |
| Phase 4: `/api/journal` — decision journal CRUD | Claude | 2026-07-01 | GET: filter by symbol/type/resolved; POST: create entry or resolve with outcome; links signal→fill→outcome |
| Phase 5: Migration 037 — trader_proposals | Claude | 2026-07-01 | **NOT YET APPLIED.** trade_proposals table (30-min expiry); decision_journal table; account_number default 605420650 |
| Phase 5: `/api/agents/trader` — TraderAgent proposals + approval | Claude | 2026-07-01 | HARDCODED AGENTIC_ACCOUNT=605420650; builds proposals from qualifying signals; approve/reject; expiry check; account mismatch safety block; kill-switch re-check at approval |
| AgentsPage — Experiments tab (🔬) | Claude | 2026-07-01 | Strategy versions list (champion badge, state, experiment metrics); Run Backtest button → /api/agents/backtest; results grid with gate pass/fail and failure reasons |
| AgentsPage — Proposals tab (⚡) | Claude | 2026-07-01 | Pending proposals list; Approve/Reject buttons; price drift warning (>3%); expiry countdown; risk check badges; "Generate Proposals" trigger |

## ✅ Session 2026-06-30

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 032 — asset_class on agent_signals | Claude + Vaibhav | 2026-06-30 | `asset_class` column; seeds ETF/metal symbols; index |
| Migration 033 — learner controls | Claude + Vaibhav | 2026-06-30 | `learning_priors` (15 Bayesian priors), `learner_config` (per-dimension toggles), `signal_weights_history` (rollback snapshots); `mutations_paused`/`pause_reason` on `learner_runs` |
| LearnerAgent full rewrite — true DeepSeek tool-use agent | Claude | 2026-06-30 | 9 tools: read_priors, query_learner_config, query_signals_with_outcomes, query_score_correlation, query_macro_context, read_past_learnings, write_hypothesis, update_signal_weight, finish; auto-guard blocks mutation if last 3 runs win_rate < 35%; phase gate: requires 10+ closed trades |
| Learner Controls tab + Weight History tab in AgentsPage | Claude | 2026-06-30 | Per-dimension learn_from/allow_mutation toggles + min_confidence; weight history table with rollback + factory reset |
| `/api/agents/learner-controls` route (GET/PATCH/POST) | Claude | 2026-06-30 | GET: config + last 30 snapshots; PATCH: update dimension config; POST: rollback or factory_reset |
| Metals basket cap fix in research-agent | Claude | 2026-06-30 | Metals (GLD/SLV/GDX/IAU) were cut by 10-symbol cap; fixed to append unconditionally after cap |

---

## ✅ Session 2026-06-29

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Dynamic exit price management | Claude | 2026-06-29 | migration 026; `price_target`, `stop_loss`, `highest_price`, `target_updated_at`, `exit_reason` on `paper_positions`; trailing stop = max(original_stop, highest_price × 0.93) |
| Risk profile system | Claude | 2026-06-29 | migration 027; `risk_profile`, `score_threshold`, `position_size_pct`, `stop_loss_pct`, `target_pct` on `strategy_config`; Conservative/Balanced/Aggressive presets; `/api/settings/risk-profile` GET/PATCH; Settings → Agents tab card |
| Visual Agent Mermaid diagrams | Claude | 2026-06-29 | `components/dashboard/AgentDiagram.tsx`; clickable flowcharts per agent; color-coded by node status; click → detail drawer; 7 JSON files in `public/agent-diagrams/` |
| TradingView CSV watchlist import | Claude | 2026-06-29 | Import CSV button + modal in WatchlistPanel; `EXCHANGE:TICKER,Description` format; batch POST with progress |
| Signal backtest tab | Claude | 2026-06-29 | AgentsPage backtest tab; joins agent_signals to paper_trades by symbol+date ±3 days; shows Hit Rate, Misses, Open, Avg Return |
| Position Monitor | Claude | 2026-06-29 | `/api/agents/position-monitor/route.ts`; TradingPage card + Run button; scheduled weekdays 4:15PM |
| Insider transactions in ResearchAgent | Claude | 2026-06-29 | `scoreInsider()` in `lib/research-agent.ts`; Alpha Vantage INSIDER_TRANSACTIONS; 90-day buy/sell ratio; injected as pre-fetched context in LLM prompt |
| Smart Money Trades in MarketsPage | Claude | 2026-06-29 | `/api/markets/insider-trades/route.ts`; Alpha Vantage insiders + House Stock Watcher congressional trades; Insiders/Congress tabs |
| LLM Cost Monitor | Claude | 2026-06-29 | `/api/admin/llm-costs/route.ts`; queries `llm_call_log`; burn rate, projected daily, per-model breakdown, 24-bar hourly chart; Settings → Agents tab; DashboardHome banner if projected daily > $2 |
| Mentor nav + judgment score chart | Claude | 2026-06-29 | Mentor link restored in DashboardShell sidebar (🎓 under Learn); `/api/mentor/scores/route.ts`; MentorPage Recharts LineChart; reference lines at 50/70/90 |
| MacroSentinel recession agent | Claude | 2026-06-29 | `/api/agents/macro-sentinel/route.ts`; 8 Alpha Vantage indicators; weighted danger score 0-100; GREEN/YELLOW/ORANGE/RED regimes; advisory-only; migrations 028; MarketsPage gauge + signal table; DashboardHome colored banner; Mondays 8AM |
| Mermaid build fix | Claude | 2026-06-29 | Downgraded mermaid v11→v10; fixes ESM/webpack incompatibility with es-toolkit; build passes |
| Windows Task Scheduler — 7 tasks | Claude | 2026-06-29 | ResearchAgent weekdays 9AM, PaperTrader 9:30AM, PositionMonitor 4:15PM, LearnerAgent Mondays 6AM, ThemeScout Sundays 8PM, DeepSeekAgent weekdays 9AM, MacroSentinel Mondays 8AM |

---

## 🟣 Review

| Task | Agent/Model | Status | Date | Notes |
|---|---|---|---|---|
| Governed agentic quant platform architecture | Codex (Architect) | review | 2026-06-27 | Canonical spec written; awaiting Vaibhav review before implementation planning |

---

## 🟡 Planned (Approved, Ready to Build)

| Task | Assigned To | Status | Date | Notes |
|---|---|---|---|---|
| Signal backtest validation | Builder | planned | — | Run `/api/agents/backtest` after signals accumulate; verify gate metrics |
| knowledge/event-patterns/ population | Builder | planned | — | Fed decision patterns, earnings behavior feeds LearnerAgent |
| Mobile push notifications for proposals | Builder | planned | — | Phase 5; low priority until proposals flow is exercised |

---

## 🔵 Blocked

| Task | Blocked By | Notes |
|---|---|---|
| LearnerAgent weight mutation (Phase 1 gate) | 10+ closed paper trades | Auto-guard + phase gate built; waiting on paper trading data |
| Experiments tab metrics | Migration 036 not applied | spy_nav/spy_return_pct/alpha_pct columns missing until 036 applied |
| Proposals tab | Migration 037 not applied | trade_proposals + decision_journal tables missing until 037 applied |
| TraderAgent actual Robinhood order | Proposals tab approved proposal | Route is built; Robinhood MCP call must be triggered from UI after user approves |

---

## ✅ Completed

| Task | Agent | Completed | Notes |
|---|---|---|---|
| PRD.md written | Claude | 2026-06-01 | Full spec in PRD.md |
| AGENTS.md written | Claude | 2026-06-01 | Multi-agent coordination layer |
| Knowledge base created | Claude | 2026-06-01 | 6 files, see knowledge/ |
| Robinhood MCP connected | Vaibhav + Claude | 2026-06-01 | 6 accounts found, agentic: ••••0660 |
| Robinhood accounts read | Claude | 2026-06-01 | get_accounts called successfully |
| Design system migration | Claude | 2026-06-27 | fo-* tokens, shadcn components, DashboardShell rewrite |
| Governed agentic quant platform architecture | Codex | 2026-06-27 | Canonical spec; see PROJECT_DECISIONS.md |
| LLM Router (Claude/DeepSeek/Groq routing by task) | Claude | 2026-06-29 | lib/llm-router.ts; routes by task type, cost tier |
| Groq Llama 3.3 70B free tier integration | Claude | 2026-06-29 | Added to router after DeepSeek; free-tier slot |
| DeepSeek R1 integration | Claude | 2026-06-29 | Cheaper chat/summarize tasks; API key in vault |
| Multi-paper-account comparison (agent_label system) | Claude | 2026-06-29 | Tracks which LLM produced each signal; P&L by model |
| LLM call log + admin history page | Claude | 2026-06-29 | Cost + token tracking per model; /dashboard/activity |
| API key vault (PIN protected) | Claude | 2026-06-29 | /dashboard/settings; encrypted key storage |
| Earnings calendar → Massive API (no LLM) | Claude | 2026-06-29 | Direct API, no LLM cost on calendar fetch |
| Markets overview → Massive API (live index quotes) | Claude | 2026-06-29 | Direct API, real-time quotes |
| Features page | Claude | 2026-06-29 | /dashboard/features; timeline of all shipped features |
| Social sentiment (StockTwits + Alpha Vantage) | Claude | 2026-06-29 | Sentiment signals for ResearchAgent screener |
| Strategy classification engine (7 strategies) | Claude | 2026-06-29 | Momentum, GARP, Value, Dividend, Growth, Macro, Contrarian |
| DeepSeek research agent variant | Claude | 2026-06-29 | Parallel agent; produces signals for LLM P&L comparison |
| Symbol detail page (candlestick, agent signals, chat) | Claude | 2026-06-29 | /dashboard/symbol/[ticker]; EMA/SMA/volume overlays |
| Symbol navigation from Portfolio, Markets, Activity | Claude | 2026-06-29 | Clickable tickers link to symbol detail page |
| Sector line chart (multi-sector performance) | Claude | 2026-06-29 | SectorLineChart component; multiple sectors on one chart |
| DB migration 010 (llm_call_log, agent_labels) | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| DB migration 011 | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| price_cache table (on-demand candle caching) | Claude | 2026-06-29 | Caches Massive API candle responses |
| Bell dropdown fix (position: fixed) | Claude | 2026-06-29 | Sticky header stacking context — fixed to viewport |
| Watchlist toggles (migration 020 + PATCH API) | Claude | 2026-06-29 | research_enabled, alert_on_signal, alert_on_earnings per symbol |
| WatchlistPanel rewrite (quotes, source badges, settings) | Claude | 2026-06-29 | Price quotes via /api/markets/quote; per-item expand |
| BriefingPage symbol auto-suggest | Claude | 2026-06-29 | Regex extraction of tickers from brief text; watchlist + Watch chips |
| pgvector enabled + agent_memory table (migration 021) | Claude + Vaibhav | 2026-06-29 | Applied to production; vector(1536) + ivfflat index |
| PageHeader on Strategies + Settings pages | Claude | 2026-06-29 | Consistent what/why/look-for on all dashboard pages |
| Vault Change PIN button + API handler | Claude | 2026-06-29 | change_pin action updates app_settings.vault_pin; persists across restarts |
| Vault Edit key button + preserve existing value | Claude | 2026-06-29 | Edit pre-fills form; blank key_value = keep existing; API skips update if blank |
| PageHeader on Activity, Learning, You, Trading, Agents, Mentor | Claude | 2026-06-29 | All 8 dashboard pages now have consistent what/why/look-for header |
| Options chain tab in SymbolDetailPage | Claude | 2026-06-29 | Chart/Signals/Options/Chat tabs; put-call ratio, avg IV, calls+puts table |
| Options chain API route | Claude | 2026-06-29 | /api/options/chain?symbol=X; Alpha Vantage REALTIME_OPTIONS; revalidate 300s |
| Batch quotes endpoint | Claude | 2026-06-29 | /api/markets/quotes?symbols=A,B,C; parallel fetch, max 20 symbols, 1 round-trip |
| WatchlistPanel → batch quotes | Claude | 2026-06-29 | 15–20 serial calls replaced with 1 batch call; limit raised 15→20 |
| Company name auto-fetch on watchlist add | Claude | 2026-06-29 | POST /api/watchlist calls Alpha Vantage COMPANY_OVERVIEW if name not provided |
| Alpha Vantage API key added | Vaibhav + Claude | 2026-06-29 | In .env.local + vault DB; powers options, sentiment, company name |
| Vault providers expanded | Claude | 2026-06-29 | Added massive, alphavantage, robinhood, supabase providers + market_data/sentiment/options tasks |
| TypeScript error fixes | Claude | 2026-06-29 | theme-scout raw.text fix; tailwind darkMode array→string; supabase/functions excluded from tsconfig |
| Grammarly hydration error suppressed | Claude | 2026-06-29 | suppressHydrationWarning on <body> in app/layout.tsx |

### Design System Migration (2026-06-27) — What was built
- `app/globals.css` — full fo-* token system (trading-purple accent #6366F1, dark-first)
- `tailwind.config.ts` — fo-* color tokens wired to CSS vars
- `postcss.config.mjs` — Tailwind v4 postcss plugin
- `lib/utils.ts` — cn() utility (clsx + tailwind-merge)
- `components/ui/card.tsx` — shadcn Card/CardHeader/CardContent/CardFooter/CardTitle/CardDescription
- `components/ui/button.tsx` — shadcn Button (no Radix Slot dep, simplified)
- `components/ui/badge.tsx` — shadcn Badge with CVA
- `components/ui/sparkline.tsx` — Recharts sparkline, fo-green/fo-red auto-color
- `components/ui/pct-pill.tsx` — % change pill with ArrowUp/ArrowDown, fo-* colors
- `components/dashboard/DashboardShell.tsx` — rewritten, added /agents and /trading nav items
- Added deps: clsx, tailwind-merge, class-variance-authority

---

## 📋 Backlog (Not Yet Approved)

| Task | Type | Priority | Notes |
|---|---|---|---|
| TraderAgent — approval_required mode (real Robinhood orders) | Feature | High | After signal validation; account ••••0660 only |
| LearnerAgent — weekly weight mutation | Feature | Medium | After 10+ closed trades (Phase 0 gate) |
| strategy_config UI editor | Feature | Low | Phase 1 last |
| Mobile trade approval push notifications | Feature | Low | Phase 5 |
| knowledge/event-patterns/ population | Research | High | Fed decisions, earnings patterns, macro |
| SEC EDGAR Form 4 insider trades | Integration | Medium | Free API |
| Railway cron deployment | Infrastructure | Medium | Phase 5 alternative to pg_cron |

---

## Architecture Decisions Log (Quick Ref)

Full details in `PROJECT_DECISIONS.md`. Summary here:

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Styling | fo-* tokens + shadcn | Tailwind only | Design system consistency |
| DB | Supabase | Prisma/PlanetScale | Already active |
| Primary AI | Anthropic Claude | OpenAI | Already integrated, best reasoning |
| LLM routing | Claude → DeepSeek → Groq by task | Single model | Cost optimization + comparison |
| Trading | Robinhood MCP | Alpaca, IBKR | Robinhood native agentic support |
| Price data | Massive API (Polygon.io) | Yahoo Finance | Reliability + options data |
| Screener primary | FinancialDatasets screen_stocks | Robinhood run_scan | Deeper fundamentals |
| Vector store | pgvector (Supabase) | Pinecone | No new infra needed |
| Agent mode default | approval_required | auto | Safety first |
| Screener candidates/day | 3 max | 5 | 10% position sizing → max 10 positions |
| Regime detection | None (scoring adapts naturally) | Explicit bull/bear mode | Fragile; scoring handles it |
| Learning schedule | Weekly batch | Per-trade | Need 10+ trades; per-trade is noise |

---

## How to Add a Task (Any Agent)

1. Add to "Planned" or "Backlog" section
2. Tag with your model name in "Assigned To"
3. Move to "In Progress" when you start
4. Move to "Completed" when done, note what you built

---

*Last updated: 2026-06-29 by Claude (Sonnet 4.6)*
