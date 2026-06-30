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

## ✅ Session 2026-06-29 (latest)

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
| Earnings cron deployment | Builder | planned | — | Route exists at /api/agents/research/cron; migration 022 created; needs prod APP_URL |
| Gemini API key + routing | Vaibhav | planned | — | Key not provided yet; slot reserved in LLM router |
| Signal backtest validation | Builder | planned | — | Must validate signals before live trading |
| DeepSeek learning loop activation | Builder | planned | — | Needs 10+ closed trades first; currently locked in Phase 0 |

---

## 🔵 Blocked

| Task | Blocked By | Notes |
|---|---|---|
| Gemini routing | Gemini API key | Vaibhav to provide key |
| Phase 1 weight mutation | 10+ closed trades | Learning loop cannot run yet; enforce Phase 0 gate |
| Earnings cron prod run | Real APP_URL | pg_cron migration 022 ready; blocked until prod domain set |
| Supabase edge fn secrets | CLI access | Set GROQ_API_KEY, CRON_SECRET, APP_URL via supabase secrets set |

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
