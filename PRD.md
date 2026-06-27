# FinanceOS — Product Requirements Document
> **For LLMs:** This file is the single source of truth for this codebase. Read it fully before writing any code. It describes what exists, what conventions are in use, what is planned, and why decisions were made. Do not invent conventions — follow what is documented here.

Last updated: 2026-06-01

---

## 0. Quick Context

- **What:** Personal finance OS for one user (Vaibhav / `vterminater@gmail.com`). Helps learn markets, navigate economy, and trade autonomously via AI agents.
- **Stack:** Next.js 15 App Router · Supabase · Anthropic Claude API · Tailwind v4 · Recharts · Stripe
- **New capability (June 2026):** Robinhood Agentic Trading MCP — AI agents can place real stock trades via `https://agent.robinhood.com/mcp/trading`
- **Single user.** No multi-tenancy concerns for agent features. Auth still required (Supabase).
- **Superadmin email:** `vterminater@gmail.com` (auto-assigned in `handle_new_user()` trigger)

---

## 1. Codebase Map

```
FinanceOS/
├── app/
│   ├── api/
│   │   ├── ai/route.ts              ← Claude API endpoint (POST)
│   │   ├── admin/route.ts
│   │   ├── stripe/checkout/route.ts
│   │   └── webhooks/stripe/route.ts
│   ├── auth/callback/route.ts       ← Supabase OAuth callback
│   ├── dashboard/
│   │   ├── layout.tsx               ← wraps all dashboard pages with DashboardShell
│   │   ├── page.tsx                 ← home (server component, passes data to DashboardHome)
│   │   ├── admin/page.tsx
│   │   ├── calendar/page.tsx
│   │   ├── intelligence/page.tsx
│   │   ├── markets/page.tsx
│   │   ├── portfolio/page.tsx
│   │   ├── settings/page.tsx
│   │   └── you/page.tsx
│   ├── login/page.tsx
│   ├── page.tsx                     ← landing page
│   └── layout.tsx                   ← root layout
├── components/
│   └── dashboard/
│       ├── DashboardHome.tsx        ← "use client", receives profile/holdings/predictions
│       └── DashboardShell.tsx       ← "use client", sidebar nav + layout wrapper
├── lib/
│   └── supabase/
│       ├── server.ts                ← createClient() for server components/routes
│       └── client.ts               ← createClient() for "use client" components
├── middleware.ts                    ← protects /dashboard/* and /admin/*
├── types/index.ts                   ← all TypeScript types + TIER_LIMITS
├── supabase/migrations/
│   └── 001_initial_schema.sql      ← full DB schema (applied)
├── next.config.ts
├── package.json
└── PRD.md                          ← this file
```

---

## 2. Coding Conventions (MUST FOLLOW)

### 2.1 Styling
- **NO Tailwind utility classes.** Inline styles throughout using `T` color token object.
- Every file that renders UI defines `T` at top:
  ```ts
  const T = {
    bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
    text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
    accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
  };
  ```
- All layout via inline `style={{}}` props. No CSS modules. No `className` strings.

### 2.2 Server vs Client Components
- **Server components** (no `"use client"`): fetch data from Supabase, pass as props to client components.
- **Client components** (`"use client"` at top): all interactivity, event handlers, useState, useRouter.
- Pattern: `page.tsx` (server) → fetches data → renders `<ComponentName data={data} />` (client).

### 2.3 Supabase
- **Server:** `import { createClient } from "@/lib/supabase/server"` — async, uses cookies
- **Client:** `import { createClient } from "@/lib/supabase/client"` — synchronous
- Auth check pattern in server components:
  ```ts
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  ```
- RLS is enabled on all tables. Policies enforce `auth.uid() = user_id`.

### 2.4 AI / Claude API
- All Claude calls go through `/api/ai/route.ts` (POST).
- Request body: `{ prompt: string, systemPrompt?: string, model?: string }`
- Response: `{ text: string, tokensUsed: number, costUsd: number }`
- Default model: `claude-sonnet-4-20250514`
- Rate limiting enforced per tier (5/50/∞ queries/day).
- Usage logged to `usage_logs` table automatically.

### 2.5 Types
- All types in `types/index.ts`. Import with `import type { Profile, Holding } from "@/types"`.
- When adding new DB tables, add corresponding TypeScript interface to `types/index.ts`.

### 2.6 Navigation
- Nav items defined in `DashboardShell.tsx` as `NAV` array.
- To add a new page: add route to `app/dashboard/<name>/page.tsx` AND add entry to `NAV` array.

### 2.7 New API Routes
- Place under `app/api/<feature>/route.ts`.
- Always check auth first: `supabase.auth.getUser()` → 401 if no user.
- Return `NextResponse.json(...)`.

---

## 3. Existing Database Schema (Applied — `001_initial_schema.sql`)

### Tables
| Table | Key Columns | Purpose |
|---|---|---|
| `profiles` | id, email, role, subscription_tier, xp, streak_days, dna_*, ai_model | User profile + gamification + DNA scores |
| `holdings` | user_id, symbol, name, qty, avg_cost, current_price, sector, exchange | Manual portfolio holdings |
| `predictions` | user_id, asset, thesis, direction, target_price, confidence, status, score | User market predictions |
| `journal_entries` | user_id, asset, direction, entry/exit_price, pnl, setup, emotion, lesson | Trade journal |
| `quiz_history` | user_id, domain, question, correct, xp_earned | Learning quiz log |
| `brief_history` | user_id, content, model_used, tokens_used | AI morning brief log |
| `reading_list` | user_id, title, url, domain, notes, completed | Curated reading |
| `watchlist` | user_id, symbol, name, market, entry_price, stop_price, notes | Tickers to watch |
| `usage_logs` | user_id, action, tokens_used, cost_usd | Rate limiting + cost tracking |
| `announcements` | title, content, target_tier, active | Admin broadcasts |

### Key Functions
- `handle_new_user()` — trigger: auto-creates profile on auth.users insert, assigns superadmin to `vterminater@gmail.com`
- `get_daily_ai_count(user_id)` — returns today's AI query count
- `get_ai_limit(tier)` — returns query limit by tier (5/50/9999)
- `daily_usage` — view: today's usage counts grouped by user/action

### Subscription Tiers
| Tier | AI queries/day | Holdings | Markets |
|---|---|---|---|
| free | 5 | 3 | US only |
| pro ($29/mo) | 50 | unlimited | US + India |
| elite ($99/mo) | unlimited | unlimited | US + India + Crypto + Macro + Global |

---

## 4. Planned: Agentic Trading System

### 4.1 Overview

Four AI agents work in a self-improving loop to research stocks, score them, trade via Robinhood, and learn from outcomes.

```
ResearchAgent ──► AnalystAgent ──► TraderAgent
                       │                │
                       └── LearnerAgent ◄┘
                           (weekly feedback loop)
```

**Self-improvement mechanism:** LearnerAgent compares predictions vs actual outcomes, adjusts ONE signal weight per weekly cycle (scientific method: single variable). New weight becomes baseline. Repeats until accuracy targets met.

### 4.2 Agent Specifications

#### ResearchAgent
```
Input:
  - watchlist symbols (from Supabase `watchlist` table)
  - sources: financial news RSS, SEC EDGAR Form 4, Reddit (r/investing, r/wallstreetbets), user-uploaded PDFs/notes

Output (stored in `research_packets` table):
  {
    ticker: string,
    sentiment_score: number,       // -1.0 to 1.0
    key_facts: string[],           // bullet points, max 5
    source_urls: string[],
    created_at: timestamp
  }

Schedule: every 30 minutes for watchlist tickers (Railway cron), on-demand via chat
Tools: Puppeteer MCP (scraping), Supabase pgvector (embed + store)
```

#### AnalystAgent
```
Input:
  - research_packets for ticker
  - price/volume data (Polygon.io or Yahoo Finance)
  - signal_weights from Supabase

Output (stored in `agent_signals` table):
  {
    ticker: string,
    score: number,                 // 0-100 composite
    regime: "bull" | "bear" | "sideways",
    recommendation: "buy" | "hold" | "sell",
    confidence: number,            // 0-100
    signal_breakdown: {
      momentum: number,
      technicals: number,
      news_sentiment: number,
      insider_buying: number,
      earnings_revision: number,
      social_velocity: number,
      user_thesis: number
    }
  }

Schedule: after each ResearchAgent cycle + on-demand
```

#### TraderAgent
```
Input:
  - AnalystAgent output (score, recommendation, confidence)
  - strategy_config from Supabase
  - Robinhood account state (via MCP)

Behavior:
  - Only trades if score >= strategy_config.min_analyst_score (default: 70)
  - Only uses Robinhood AGENTIC account (not primary — this is enforced by Robinhood)
  - Respects max_position_pct and max_daily_trades from strategy_config

Modes:
  approval_required (default):
    - Emits trade proposal to `trade_queue` table
    - UI shows toast → modal with reasoning + risk → user approves/rejects
    - On approve: executes via Robinhood MCP
  auto:
    - Executes immediately within hard position limits
    - User must explicitly unlock per session

Output (stored in `trade_log`):
  every action logged with agent reasoning snapshot
```

#### LearnerAgent
```
Input:
  - trade_log (agent predictions)
  - actual price movements (fetched from price data API)
  - signal_weights (current)

Process:
  1. Score prediction accuracy for completed trades
  2. Identify worst-performing signal
  3. Adjust that signal's weight by ±0.02 (max ±0.05/cycle)
  4. Store old → new weight with reason in learning_log
  5. New weights become baseline for AnalystAgent

Schedule: weekly (Railway cron, 3-day offset from ResearchAgent)
```

### 4.3 New Database Tables (to be migrated)

```sql
-- Agent watchlist (extends existing watchlist table — add thesis_notes column)
-- OR use existing watchlist + new thesis_notes column via ALTER

-- Research output
CREATE TABLE research_packets (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticker text NOT NULL,
  sentiment_score numeric NOT NULL,          -- -1.0 to 1.0
  key_facts text[] NOT NULL DEFAULT '{}',
  source_urls text[] NOT NULL DEFAULT '{}',
  raw_text text,
  created_at timestamptz DEFAULT now()
);

-- Analyst scores per ticker
CREATE TABLE agent_signals (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticker text NOT NULL,
  score numeric NOT NULL,                    -- 0-100
  regime text CHECK (regime IN ('bull','bear','sideways')),
  recommendation text CHECK (recommendation IN ('buy','hold','sell')),
  confidence numeric,
  signal_breakdown jsonb,                    -- { momentum, technicals, ... }
  created_at timestamptz DEFAULT now()
);

-- Current signal weights (single-row config, updated by LearnerAgent)
CREATE TABLE signal_weights (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  momentum numeric DEFAULT 0.20,
  technicals numeric DEFAULT 0.15,
  news_sentiment numeric DEFAULT 0.20,
  insider_buying numeric DEFAULT 0.15,
  earnings_revision numeric DEFAULT 0.15,
  social_velocity numeric DEFAULT 0.10,
  user_thesis numeric DEFAULT 0.05,
  updated_at timestamptz DEFAULT now()
);

-- Pending trade proposals (approval_required mode)
CREATE TABLE trade_queue (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticker text NOT NULL,
  action text NOT NULL CHECK (action IN ('buy','sell')),
  quantity numeric NOT NULL,
  estimated_price numeric,
  analyst_score numeric,
  signal_snapshot jsonb,         -- full AnalystAgent output at time of proposal
  status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','expired')),
  user_decision_at timestamptz,
  rejection_reason text,
  created_at timestamptz DEFAULT now()
);

-- Executed trades + outcomes
CREATE TABLE trade_log (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticker text NOT NULL,
  action text NOT NULL CHECK (action IN ('buy','sell')),
  quantity numeric NOT NULL,
  executed_price numeric,
  agent text DEFAULT 'TraderAgent',
  mode text CHECK (mode IN ('approval_required','auto')),
  approved_by_user boolean DEFAULT false,
  robinhood_order_id text,
  outcome_pnl numeric,           -- filled after position closes
  outcome_correct boolean,       -- did price move in predicted direction?
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- LearnerAgent weight change history
CREATE TABLE learning_log (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  signal_adjusted text NOT NULL,
  old_weight numeric NOT NULL,
  new_weight numeric NOT NULL,
  reason text,
  accuracy_before numeric,       -- prediction % correct before change
  accuracy_after numeric,        -- filled on next cycle
  created_at timestamptz DEFAULT now()
);

-- Vector memory for semantic search (requires pgvector extension)
CREATE TABLE agent_memory (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticker text,
  source_type text CHECK (source_type IN ('news','filing','user_note','pdf','reddit','twitter')),
  raw_content text NOT NULL,
  content_embedding vector(1536),  -- text-embedding-3-small
  created_at timestamptz DEFAULT now()
);
CREATE INDEX ON agent_memory USING ivfflat (content_embedding vector_cosine_ops);

-- Strategy config (single row, edited via settings UI)
CREATE TABLE strategy_config (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  name text DEFAULT 'Vaibhav Alpha v1',
  mode text DEFAULT 'approval_required' CHECK (mode IN ('approval_required','auto')),
  max_position_pct numeric DEFAULT 5,        -- % of agentic account per position
  max_daily_trades integer DEFAULT 3,
  min_analyst_score numeric DEFAULT 70,
  target_30d_accuracy numeric DEFAULT 0.60,
  max_drawdown_pct numeric DEFAULT 15,
  failure_drawdown_pct numeric DEFAULT 20,
  trading_enabled boolean DEFAULT true,      -- kill switch
  updated_at timestamptz DEFAULT now()
);

-- Seed default config
INSERT INTO strategy_config DEFAULT VALUES;
```

### 4.4 Robinhood MCP Integration

- **MCP endpoint:** `https://agent.robinhood.com/mcp/trading`
- **Transport:** HTTP + OAuth
- **Connected via:** `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`
- **Auth:** OAuth flow via `mcp__robinhood-trading__authenticate` tool
- **Scope:** Dedicated Robinhood Agentic Account only — agents CANNOT touch primary account (enforced by Robinhood)
- **Supported assets (June 2026):** Equities only (options/crypto planned)
- **Kill switch:** `strategy_config.trading_enabled = false` → TraderAgent no-ops all trade calls

#### MCP Tool Capabilities (confirmed from Robinhood docs)
- Query: portfolio value, buying power, positions, order history, P&L
- Execute: market orders, limit orders, all standard order types
- Rebalance: build portfolios to match criteria
- Backtest: test strategies against historical data
- Monitor: watch for market events (analyst upgrades, etc.)

### 4.5 New API Routes (to build)

```
POST /api/agents/research          ← trigger ResearchAgent for ticker(s)
POST /api/agents/analyze           ← trigger AnalystAgent for ticker(s)
POST /api/agents/trade/propose     ← TraderAgent proposes trade (writes to trade_queue)
POST /api/agents/trade/approve     ← user approves trade_queue item → executes via Robinhood MCP
POST /api/agents/trade/reject      ← user rejects with optional reason
GET  /api/agents/status            ← all agent run statuses
POST /api/agents/learn             ← trigger LearnerAgent cycle
GET  /api/portfolio/robinhood      ← read agentic account positions from Robinhood MCP
```

---

## 5. UI Architecture

### 5.1 Existing Dashboard Nav (DashboardShell.tsx `NAV` array)
```
/dashboard              → Home (4-panel overview)
/dashboard/portfolio    → Holdings + P&L
/dashboard/markets      → Watchlist + prices
/dashboard/intelligence → AI research feed
/dashboard/calendar     → Economic calendar
/dashboard/you          → Profile + DNA + learning
/dashboard/settings     → Preferences
/dashboard/admin        → Admin only (role check)
```

### 5.2 New Pages to Add
```
/dashboard/agents       → Agent control panel (status, kill switch, run manually)
/dashboard/trading      → Trade queue, approval UI, Robinhood agentic account
/dashboard/learning     → Signal weight history, prediction accuracy charts
```

Add these to `NAV` array in `DashboardShell.tsx`:
```ts
{ href: "/dashboard/agents",   label: "Agents",   icon: "⬡" },
{ href: "/dashboard/trading",  label: "Trading",  icon: "◈" },
{ href: "/dashboard/learning", label: "Learning", icon: "◫" },
```

### 5.3 Design System
Colors defined via `T` token object (see Section 2.1). All styling inline.
Font: Inter. No icon libraries — uses Unicode symbols as icons (see NAV array).

### 5.4 Trade Approval Flow (`/dashboard/trading`)
```
TraderAgent writes to trade_queue (status: 'pending')
         ↓
UI polls trade_queue every 30s (or websocket)
         ↓
Toast appears: "Buy 10 NVDA @ ~$142 — Score: 83/100"
         ↓
User clicks → Modal opens:
  - Why: top 3 signals that triggered
  - Risk: position size, % of account, estimated max loss
  - Chart: 30-day price + agent score history
         ↓
[Approve] → POST /api/agents/trade/approve → Robinhood MCP executes
[Reject]  → POST /api/agents/trade/reject → logged, agent notes rejection
[Modify]  → User edits qty/price → approves modified version
```

### 5.5 Dashboard Home Layout (target)
```
┌─────────────────┬──────────────────┐
│   WATCHLIST     │   AGENT CHAT     │
│  ticker + score │  natural lang    │
│  signal bars    │  "Why buy NVDA?" │
│  regime badge   │  "Show thesis"   │
├─────────────────┼──────────────────┤
│   TRADING       │   LEARNING FEED  │
│  agentic acct   │  weight changes  │
│  live P&L       │  accuracy delta  │
│  trade queue    │  "momentum ↑0.02 │
│  approve/reject │   +4% accuracy"  │
└─────────────────┴──────────────────┘
```

---

## 6. External Integrations

| Integration | Purpose | Status | Notes |
|---|---|---|---|
| Robinhood MCP | Trade execution + read portfolio | ✅ Connected, auth in progress | Agentic account only |
| Anthropic Claude API | All agent intelligence | ✅ Active | Via `/api/ai/route.ts` |
| Supabase | DB + auth + vector store | ✅ Active | pgvector needs enabling |
| Puppeteer MCP | Web scraping (news, filings) | ✅ Connected | For ResearchAgent |
| SEC EDGAR API | Form 4 insider trades, 10-K filings | 🔲 To add | Free, no key required |
| Polygon.io | Price + volume + technicals | 🔲 To add | $29/mo — preferred over Yahoo Finance |
| Reddit API | Sentiment from r/investing, r/wallstreetbets | 🔲 To add | Scrape via Puppeteer or official API |
| Stripe | Subscriptions | ✅ Active | Webhooks at `/api/webhooks/stripe` |
| Railway | 24/7 agent cron workers | 🔲 To add | ResearchAgent (30min) + LearnerAgent (weekly) |

---

## 7. Success Metrics & Failure Modes

### Target (define success)
- Prediction accuracy > 60% over rolling 30 days
- Sharpe ratio > 1.0
- Max drawdown < 15%
- Signal weights converge toward stable, accurate configuration over 8–12 weeks

### Failure (triggers pause + alert)
- Prediction accuracy < 40% over 30 days
- Drawdown > 20%
- Any single day loss > 5% of agentic account
→ `trading_enabled` flag set to false, user alerted

### Learning Guardrails
- LearnerAgent adjusts max ±0.05 weight per cycle
- Weights must always sum to 1.0
- No weight may go below 0.02 (floor) or above 0.40 (ceiling)

---

## 8. Build Order (Phases)

### Phase 1 — Foundation (current)
- [x] Robinhood MCP added
- [ ] Complete Robinhood OAuth auth
- [ ] Read live portfolio from Robinhood agentic account
- [ ] Create new DB tables (migration 002)
- [ ] Seed `signal_weights` + `strategy_config`
- [ ] `/dashboard/agents` page — status + kill switch
- [ ] `/dashboard/trading` page skeleton

### Phase 2 — Research + Analysis
- [ ] ResearchAgent: news scraping via Puppeteer MCP
- [ ] SEC EDGAR Form 4 fetcher
- [ ] Polygon.io or Yahoo Finance price data
- [ ] AnalystAgent with static signal weights
- [ ] Render scored watchlist on `/dashboard/markets`
- [ ] `agent_memory` vector store wired up

### Phase 3 — Trading
- [ ] TraderAgent in `approval_required` mode
- [ ] Trade approval UI (toast → modal → execute)
- [ ] Full trade logging
- [ ] End-to-end test: research → score → propose → approve → execute

### Phase 4 — Learning
- [ ] LearnerAgent: prediction scoring + weight adjustment
- [ ] `/dashboard/learning` with weight history charts
- [ ] Accuracy tracking over rolling 30-day window

### Phase 5 — Automation
- [ ] `auto` mode with hard guards
- [ ] Railway cron job deployment (30min research, weekly learn)
- [ ] Push notifications for trade proposals
- [ ] Mobile-optimized trade approval

---

## 9. Open Decisions

| Decision | Options | Notes |
|---|---|---|
| Price data | Polygon.io ($29/mo) vs Yahoo Finance (free, rate-limited) | Polygon preferred for reliability |
| Reddit data | Official API vs Puppeteer scrape | Puppeteer simpler, already connected |
| Notifications | Browser push vs SMS (Twilio) vs Slack MCP | Slack MCP already connected in session |
| Embedding model | OpenAI text-embedding-3-small vs Claude | OpenAI cheaper for embeddings |
| Auto mode trigger | Score threshold only vs also time-gated | Requires explicit per-session unlock |

---

## 10. Security & Risk Controls

> **CRITICAL:** TraderAgent ONLY operates on Robinhood agentic account. This is enforced structurally by Robinhood — the MCP cannot access the primary account. Do not attempt to add primary account access.

- Kill switch: `strategy_config.trading_enabled = false` — check this before every TraderAgent action
- `approval_required` mode is default and must be explicitly changed to `auto`
- All agent actions stored in `trade_log` with full reasoning snapshot (non-deletable by design)
- LearnerAgent weight changes bounded: ±0.05/cycle, weights floor 0.02, ceiling 0.40
- Robinhood ToS: user (Vaibhav) is fully responsible for all agent-executed trades
- Never log or expose Robinhood OAuth tokens anywhere in the codebase

---

*Next immediate step: Paste Robinhood OAuth redirect URL to complete authentication, then run Phase 1 DB migration.*
