# Kairos â€” Product Requirements Document
> **For LLMs:** This file is the single source of truth for this codebase. Read it fully before writing any code. It describes what exists, what conventions are in use, what is planned, and why decisions were made. Do not invent conventions â€” follow what is documented here.

Last updated: 2026-06-01

---

## 0. Quick Context

- **What:** Personal Kairos for one user (Vaibhav / `vterminater@gmail.com`). Helps learn markets, navigate economy, and trade autonomously via AI agents.
- **Stack:** Next.js 15 App Router Â· Supabase Â· Anthropic Claude API Â· Tailwind v4 Â· Recharts Â· Stripe
- **New capability (June 2026):** Robinhood Agentic Trading MCP â€” AI agents can place real stock trades via `https://agent.robinhood.com/mcp/trading`
- **Single user.** No multi-tenancy concerns for agent features. Auth still required (Supabase).
- **Superadmin email:** `vterminater@gmail.com` (auto-assigned in `handle_new_user()` trigger)

---

## 1. Codebase Map

```
Kairos/
â”œâ”€â”€ app/
â”‚   â”œâ”€â”€ api/
â”‚   â”‚   â”œâ”€â”€ ai/route.ts              â† Claude API endpoint (POST)
â”‚   â”‚   â”œâ”€â”€ admin/route.ts
â”‚   â”‚   â”œâ”€â”€ stripe/checkout/route.ts
â”‚   â”‚   â””â”€â”€ webhooks/stripe/route.ts
â”‚   â”œâ”€â”€ auth/callback/route.ts       â† Supabase OAuth callback
â”‚   â”œâ”€â”€ dashboard/
â”‚   â”‚   â”œâ”€â”€ layout.tsx               â† wraps all dashboard pages with DashboardShell
â”‚   â”‚   â”œâ”€â”€ page.tsx                 â† home (server component, passes data to DashboardHome)
â”‚   â”‚   â”œâ”€â”€ admin/page.tsx
â”‚   â”‚   â”œâ”€â”€ calendar/page.tsx
â”‚   â”‚   â”œâ”€â”€ intelligence/page.tsx
â”‚   â”‚   â”œâ”€â”€ markets/page.tsx
â”‚   â”‚   â”œâ”€â”€ portfolio/page.tsx
â”‚   â”‚   â”œâ”€â”€ settings/page.tsx
â”‚   â”‚   â””â”€â”€ you/page.tsx
â”‚   â”œâ”€â”€ login/page.tsx
â”‚   â”œâ”€â”€ page.tsx                     â† landing page
â”‚   â””â”€â”€ layout.tsx                   â† root layout
â”œâ”€â”€ components/
â”‚   â””â”€â”€ dashboard/
â”‚       â”œâ”€â”€ DashboardHome.tsx        â† "use client", receives profile/holdings/predictions
â”‚       â””â”€â”€ DashboardShell.tsx       â† "use client", sidebar nav + layout wrapper
â”œâ”€â”€ lib/
â”‚   â””â”€â”€ supabase/
â”‚       â”œâ”€â”€ server.ts                â† createClient() for server components/routes
â”‚       â””â”€â”€ client.ts               â† createClient() for "use client" components
â”œâ”€â”€ middleware.ts                    â† protects /dashboard/* and /admin/*
â”œâ”€â”€ types/index.ts                   â† all TypeScript types + TIER_LIMITS
â”œâ”€â”€ supabase/migrations/
â”‚   â””â”€â”€ 001_initial_schema.sql      â† full DB schema (applied)
â”œâ”€â”€ next.config.ts
â”œâ”€â”€ package.json
â””â”€â”€ PRD.md                          â† this file
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
- Pattern: `page.tsx` (server) â†’ fetches data â†’ renders `<ComponentName data={data} />` (client).

### 2.3 Supabase
- **Server:** `import { createClient } from "@/lib/supabase/server"` â€” async, uses cookies
- **Client:** `import { createClient } from "@/lib/supabase/client"` â€” synchronous
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
- Rate limiting enforced per tier (5/50/âˆž queries/day).
- Usage logged to `usage_logs` table automatically.

### 2.5 Types
- All types in `types/index.ts`. Import with `import type { Profile, Holding } from "@/types"`.
- When adding new DB tables, add corresponding TypeScript interface to `types/index.ts`.

### 2.6 Navigation
- Nav items defined in `DashboardShell.tsx` as `NAV` array.
- To add a new page: add route to `app/dashboard/<name>/page.tsx` AND add entry to `NAV` array.

### 2.7 New API Routes
- Place under `app/api/<feature>/route.ts`.
- Always check auth first: `supabase.auth.getUser()` â†’ 401 if no user.
- Return `NextResponse.json(...)`.

---

## 3. Existing Database Schema (Applied â€” `001_initial_schema.sql`)

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
- `handle_new_user()` â€” trigger: auto-creates profile on auth.users insert, assigns superadmin to `vterminater@gmail.com`
- `get_daily_ai_count(user_id)` â€” returns today's AI query count
- `get_ai_limit(tier)` â€” returns query limit by tier (5/50/9999)
- `daily_usage` â€” view: today's usage counts grouped by user/action

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
ResearchAgent â”€â”€â–º AnalystAgent â”€â”€â–º TraderAgent
                       â”‚                â”‚
                       â””â”€â”€ LearnerAgent â—„â”˜
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
  - Only uses Robinhood AGENTIC account (not primary â€” this is enforced by Robinhood)
  - Respects max_position_pct and max_daily_trades from strategy_config

Modes:
  approval_required (default):
    - Emits trade proposal to `trade_queue` table
    - UI shows toast â†’ modal with reasoning + risk â†’ user approves/rejects
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
  3. Adjust that signal's weight by Â±0.02 (max Â±0.05/cycle)
  4. Store old â†’ new weight with reason in learning_log
  5. New weights become baseline for AnalystAgent

Schedule: weekly (Railway cron, 3-day offset from ResearchAgent)
```

### 4.3 New Database Tables (to be migrated)

```sql
-- Agent watchlist (extends existing watchlist table â€” add thesis_notes column)
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
- **Scope:** Dedicated Robinhood Agentic Account only â€” agents CANNOT touch primary account (enforced by Robinhood)
- **Supported assets (June 2026):** Equities only (options/crypto planned)
- **Kill switch:** `strategy_config.trading_enabled = false` â†’ TraderAgent no-ops all trade calls

#### MCP Tool Capabilities (confirmed from Robinhood docs)
- Query: portfolio value, buying power, positions, order history, P&L
- Execute: market orders, limit orders, all standard order types
- Rebalance: build portfolios to match criteria
- Backtest: test strategies against historical data
- Monitor: watch for market events (analyst upgrades, etc.)

### 4.5 New API Routes (to build)

```
POST /api/agents/research          â† trigger ResearchAgent for ticker(s)
POST /api/agents/analyze           â† trigger AnalystAgent for ticker(s)
POST /api/agents/trade/propose     â† TraderAgent proposes trade (writes to trade_queue)
POST /api/agents/trade/approve     â† user approves trade_queue item â†’ executes via Robinhood MCP
POST /api/agents/trade/reject      â† user rejects with optional reason
GET  /api/agents/status            â† all agent run statuses
POST /api/agents/learn             â† trigger LearnerAgent cycle
GET  /api/portfolio/robinhood      â† read agentic account positions from Robinhood MCP
```

---

## 5. UI Architecture

### 5.1 Existing Dashboard Nav (DashboardShell.tsx `NAV` array)
```
/dashboard              â†’ Home (4-panel overview)
/dashboard/portfolio    â†’ Holdings + P&L
/dashboard/markets      â†’ Watchlist + prices
/dashboard/intelligence â†’ AI research feed
/dashboard/calendar     â†’ Economic calendar
/dashboard/you          â†’ Profile + DNA + learning
/dashboard/settings     â†’ Preferences
/dashboard/admin        â†’ Admin only (role check)
```

### 5.2 New Pages to Add
```
/dashboard/agents       â†’ Agent control panel (status, kill switch, run manually)
/dashboard/trading      â†’ Trade queue, approval UI, Robinhood agentic account
/dashboard/learning     â†’ Signal weight history, prediction accuracy charts
```

Add these to `NAV` array in `DashboardShell.tsx`:
```ts
{ href: "/dashboard/agents",   label: "Agents",   icon: "â¬¡" },
{ href: "/dashboard/trading",  label: "Trading",  icon: "â—ˆ" },
{ href: "/dashboard/learning", label: "Learning", icon: "â—«" },
```

### 5.3 Design System
Colors defined via `T` token object (see Section 2.1). All styling inline.
Font: Inter. No icon libraries â€” uses Unicode symbols as icons (see NAV array).

### 5.4 Trade Approval Flow (`/dashboard/trading`)
```
TraderAgent writes to trade_queue (status: 'pending')
         â†“
UI polls trade_queue every 30s (or websocket)
         â†“
Toast appears: "Buy 10 NVDA @ ~$142 â€” Score: 83/100"
         â†“
User clicks â†’ Modal opens:
  - Why: top 3 signals that triggered
  - Risk: position size, % of account, estimated max loss
  - Chart: 30-day price + agent score history
         â†“
[Approve] â†’ POST /api/agents/trade/approve â†’ Robinhood MCP executes
[Reject]  â†’ POST /api/agents/trade/reject â†’ logged, agent notes rejection
[Modify]  â†’ User edits qty/price â†’ approves modified version
```

### 5.5 Dashboard Home Layout (target)
```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚   WATCHLIST     â”‚   AGENT CHAT     â”‚
â”‚  ticker + score â”‚  natural lang    â”‚
â”‚  signal bars    â”‚  "Why buy NVDA?" â”‚
â”‚  regime badge   â”‚  "Show thesis"   â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚   TRADING       â”‚   LEARNING FEED  â”‚
â”‚  agentic acct   â”‚  weight changes  â”‚
â”‚  live P&L       â”‚  accuracy delta  â”‚
â”‚  trade queue    â”‚  "momentum â†‘0.02 â”‚
â”‚  approve/reject â”‚   +4% accuracy"  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 6. External Integrations

| Integration | Purpose | Status | Notes |
|---|---|---|---|
| Robinhood MCP | Trade execution + read portfolio | âœ… Connected, auth in progress | Agentic account only |
| Anthropic Claude API | All agent intelligence | âœ… Active | Via `/api/ai/route.ts` |
| Supabase | DB + auth + vector store | âœ… Active | pgvector needs enabling |
| Puppeteer MCP | Web scraping (news, filings) | âœ… Connected | For ResearchAgent |
| SEC EDGAR API | Form 4 insider trades, 10-K filings | ðŸ”² To add | Free, no key required |
| Polygon.io | Price + volume + technicals | ðŸ”² To add | $29/mo â€” preferred over Yahoo Finance |
| Reddit API | Sentiment from r/investing, r/wallstreetbets | ðŸ”² To add | Scrape via Puppeteer or official API |
| Stripe | Subscriptions | âœ… Active | Webhooks at `/api/webhooks/stripe` |
| Railway | 24/7 agent cron workers | ðŸ”² To add | ResearchAgent (30min) + LearnerAgent (weekly) |

---

## 7. Success Metrics & Failure Modes

### Target (define success)
- Prediction accuracy > 60% over rolling 30 days
- Sharpe ratio > 1.0
- Max drawdown < 15%
- Signal weights converge toward stable, accurate configuration over 8â€“12 weeks

### Failure (triggers pause + alert)
- Prediction accuracy < 40% over 30 days
- Drawdown > 20%
- Any single day loss > 5% of agentic account
â†’ `trading_enabled` flag set to false, user alerted

### Learning Guardrails
- LearnerAgent adjusts max Â±0.05 weight per cycle
- Weights must always sum to 1.0
- No weight may go below 0.02 (floor) or above 0.40 (ceiling)

---

## 8. Build Order (Phases)

### Phase 1 â€” Foundation (current)
- [x] Robinhood MCP added
- [ ] Complete Robinhood OAuth auth
- [ ] Read live portfolio from Robinhood agentic account
- [ ] Create new DB tables (migration 002)
- [ ] Seed `signal_weights` + `strategy_config`
- [ ] `/dashboard/agents` page â€” status + kill switch
- [ ] `/dashboard/trading` page skeleton

### Phase 2 â€” Research + Analysis
- [ ] ResearchAgent: news scraping via Puppeteer MCP
- [ ] SEC EDGAR Form 4 fetcher
- [ ] Polygon.io or Yahoo Finance price data
- [ ] AnalystAgent with static signal weights
- [ ] Render scored watchlist on `/dashboard/markets`
- [ ] `agent_memory` vector store wired up

### Phase 3 â€” Trading
- [ ] TraderAgent in `approval_required` mode
- [ ] Trade approval UI (toast â†’ modal â†’ execute)
- [ ] Full trade logging
- [ ] End-to-end test: research â†’ score â†’ propose â†’ approve â†’ execute

### Phase 4 â€” Learning
- [ ] LearnerAgent: prediction scoring + weight adjustment
- [ ] `/dashboard/learning` with weight history charts
- [ ] Accuracy tracking over rolling 30-day window

### Phase 5 â€” Automation
- [ ] `auto` mode with hard guards
- [ ] Railway cron job deployment (30min research, weekly learn)
- [ ] Push notifications for trade proposals
- [ ] Mobile-optimized trade approval

---

## 9. Features Built (2026-06-29 Session)

### 9.1 Risk Profile System

Three preset risk profiles stored in `strategy_config`:

| Profile | score_threshold | position_size_pct | stop_loss_pct | target_pct |
|---|---|---|---|---|
| Conservative | 72 | 7 | 5 | 12 |
| Balanced | 60 | 10 | 7 | 20 |
| Aggressive | 52 | 15 | 10 | 35 |

- **API:** `GET /api/settings/risk-profile` returns current profile. `PATCH /api/settings/risk-profile` updates `strategy_config` row.
- **UI:** Settings page â†’ Agents tab â†’ Risk Profile card. User selects preset or edits per-field.
- **ResearchAgent integration:** Reads `risk_profile` from `strategy_config`, applies `PROFILE_WEIGHTS` multiplier to signal scoring, uses `score_threshold` as the minimum score for a buy signal.

### 9.2 Position Monitor (Dynamic Exit Price Management)

Runs daily after market close (weekdays 4:15PM). Manages trailing stops and target exits for all open `paper_positions`.

**New columns added to `paper_positions` (migration 026):**
- `price_target` â€” target exit price
- `stop_loss` â€” initial stop loss price
- `highest_price` â€” highest price seen since entry (trail anchor)
- `target_updated_at` â€” last time target was updated
- `exit_reason` â€” `'stop'`, `'target'`, or `'llm_exit'`

**Trailing stop logic:** `new_stop = max(original_stop_loss, highest_price Ã— 0.93)`

On each run:
1. Fetch current prices for all open positions
2. Update `highest_price` if current price > previous highest
3. Recompute trailing stop
4. If `current_price <= stop` â†’ close position, set `exit_reason = 'stop'`
5. If `current_price >= price_target` â†’ close position, set `exit_reason = 'target'`
6. Closed positions return cash to buying power

**UI:** TradingPage has PositionMonitor card with "Run Now" button and last-run timestamp.

### 9.3 MacroSentinel (Recession Risk Agent)

Weekly macro regime scoring agent. Runs Mondays 8AM.

**Indicators fetched from Alpha Vantage (8 total):**
1. Yield Curve (10Y-2Y spread) â€” inverted = danger
2. Sahm Rule proxy (unemployment rate delta)
3. Real GDP (QoQ growth rate)
4. Nonfarm Payrolls (MoM change)
5. CPI (YoY inflation)
6. Retail Sales (MoM change)
7. Federal Funds Rate
8. Durable Goods Orders (MoM)

**Regime classification (weighted danger score 0-100):**
- GREEN: score < 25 â€” expansion
- YELLOW: 25-49 â€” caution
- ORANGE: 50-74 â€” slowdown
- RED: â‰¥75 â€” recession risk

**Advisory-only:** MacroSentinel reports regime; it does not auto-throttle agents or halt trading. User decides how to act.

**Storage (migration 028):**
- `macro_regime` â€” current regime + score + timestamp
- `macro_signals` â€” per-indicator readings and contribution

**UI:** MarketsPage â†’ MacroSentinel card with danger gauge + signal breakdown table. DashboardHome shows colored regime banner (hidden when GREEN).

### 9.4 Smart Money Trades (MarketsPage)

**API:** `/api/markets/insider-trades/route.ts`

**Two data sources:**
1. **Insiders tab:** Alpha Vantage `INSIDER_TRANSACTIONS` â€” corporate insider buy/sell filings
2. **Congress tab:** House Stock Watcher public S3 data â€” congressional stock trade disclosures (free, no auth required)

UI in MarketsPage with tabbed Insiders/Congress view, showing symbol, insider name, transaction type, shares, and date.

### 9.5 LLM Cost Monitor

**API:** `/api/admin/llm-costs/route.ts` â€” queries `llm_call_log` table.

**Metrics computed:**
- Total spend (last 24h, 7d, 30d)
- Burn rate ($/hour)
- Projected daily cost
- Per-model breakdown (Claude / DeepSeek / Groq)
- 24-bar hourly cost chart (Recharts BarChart)

**UI:**
- Settings â†’ Agents tab â†’ LLM Cost Monitor card
- DashboardHome shows ðŸ’¸ banner if `projected_daily > $2`

### 9.6 Mentor System (Judgment Score Chart)

**Mentor nav link** restored in DashboardShell sidebar (ðŸŽ“ icon, under "Learn" section).

**API:** `/api/mentor/scores/route.ts` â€” groups `trade_journal` scores by date, returns time series.

**MentorPage:** Recharts LineChart showing judgment score over time with reference lines:
- 50 = Learning
- 70 = Proficient
- 90 = Expert

### 9.7 Visual Agent Mermaid Diagrams

**Component:** `components/dashboard/AgentDiagram.tsx`
- Renders clickable Mermaid v10 flowcharts per agent (v11 incompatible with webpack/es-toolkit)
- Nodes color-coded: active=green, new=blue, changed=red, removed=gray
- Click any node â†’ detail drawer showing why-added and change history

**Data files in `public/agent-diagrams/` (7 JSON files):**
- `research-agent.json`, `learner-agent.json`, `theme-scout.json`, `deepseek-agent.json`, `position-monitor.json`, `paper-trader.json`, `macro-sentinel.json`

### 9.8 TradingView CSV Watchlist Import

WatchlistPanel now has an "Import CSV" button. Modal accepts paste of TradingView export format (`EXCHANGE:TICKER,Description`). Parses tickers, batch POSTs to `/api/watchlist` with progress indicator.

### 9.9 Signal Backtest Tab (AgentsPage)

New "Backtest" tab in AgentsPage. Joins `agent_signals` to `paper_trades` by symbol + date (Â±3-day window). Displays:
- Hit Rate (signals that became profitable trades)
- Misses (signals with no matching trade or negative outcome)
- Open (signals still in open positions)
- Avg Return (%)

---

## 10. Open Decisions

| Decision | Options | Notes |
|---|---|---|
| Price data | Polygon.io ($29/mo) vs Yahoo Finance (free, rate-limited) | Polygon preferred for reliability |
| Reddit data | Official API vs Puppeteer scrape | Puppeteer simpler, already connected |
| Notifications | Browser push vs SMS (Twilio) vs Slack MCP | Slack MCP already connected in session |
| Embedding model | OpenAI text-embedding-3-small vs Claude | OpenAI cheaper for embeddings |
| Auto mode trigger | Score threshold only vs also time-gated | Requires explicit per-session unlock |

---

## 10. Security & Risk Controls

> **CRITICAL:** TraderAgent ONLY operates on Robinhood agentic account. This is enforced structurally by Robinhood â€” the MCP cannot access the primary account. Do not attempt to add primary account access.

- Kill switch: `strategy_config.trading_enabled = false` â€” check this before every TraderAgent action
- `approval_required` mode is default and must be explicitly changed to `auto`
- All agent actions stored in `trade_log` with full reasoning snapshot (non-deletable by design)
- LearnerAgent weight changes bounded: Â±0.05/cycle, weights floor 0.02, ceiling 0.40
- Robinhood ToS: user (Vaibhav) is fully responsible for all agent-executed trades
- Never log or expose Robinhood OAuth tokens anywhere in the codebase

---

*Next immediate step: Paste Robinhood OAuth redirect URL to complete authentication, then run Phase 1 DB migration.*
