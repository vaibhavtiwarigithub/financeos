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

## 🟣 Review

| Task | Agent/Model | Status | Date | Notes |
|---|---|---|---|---|
| Governed agentic quant platform architecture | Codex (Architect) | review | 2026-06-27 | Canonical spec written; awaiting Vaibhav review before implementation planning |

---

## 🟡 Planned (Approved, Ready to Build)

| Task | Assigned To | Status | Date | Notes |
|---|---|---|---|---|
| Earnings cron deployment | Builder | planned | — | Route exists at /api/agents/research/cron; needs pg_cron or edge function scheduler |
| Gemini API key + routing | Vaibhav | planned | — | Key not provided yet; slot reserved in LLM router |
| Signal backtest validation | Builder | planned | — | Must validate signals before live trading |
| Reddit direct sentiment | Builder | planned | — | StockTwits added; Reddit needs Apify key from Vaibhav |
| pgvector memory (agent_memory table) | Builder | planned | — | pgvector not enabled in Supabase yet |
| DeepSeek learning loop activation | Builder | planned | — | Needs 10+ closed trades first; currently locked in Phase 0 |

---

## 🔵 Blocked

| Task | Blocked By | Notes |
|---|---|---|
| Gemini routing | Gemini API key | Vaibhav to provide key |
| Reddit sentiment | Apify key | Vaibhav to provide key |
| pgvector memory | pgvector extension | Must enable in Supabase dashboard first |
| Phase 1 weight mutation | 10+ closed trades | Learning loop cannot run yet; enforce Phase 0 gate |
| Earnings cron auto-run | Scheduler infra | pg_cron or Vercel cron config not wired yet |

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
