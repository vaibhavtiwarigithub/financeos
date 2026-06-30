# Architecture — FinanceOS

## Project Purpose

**Comprehensive finance OS — broader scope than FinNudge, production architecture**

**Stack:** Next.js App Router, TypeScript, Supabase, Vercel

Claude: Update this section after inspecting the repo and discussing the project with the user. Add the specific problem this solves, the target user, and the core value proposition.

## Product / System Philosophy

This project should be designed intentionally.

Every feature must have:
- Clear user or system value
- Clear scope
- Clear architecture
- Clear states and edge cases
- Clear acceptance criteria

## Architecture Principles

1. Architecture before implementation
2. Product behavior before UI polish
3. Data contracts before component wiring
4. User journey before screens
5. System boundaries before integrations
6. Approval before coding
7. Documentation before implementation
8. No silent architectural drift

## Global Product Questions

Every feature must answer:
- Who is this for?
- What problem does it solve?
- What does the user/system do first?
- What happens next?
- What can go wrong?
- What data is required?
- What is real vs mocked vs derived vs AI-generated?
- What must not change?
- How do we know it works?

## Global UX Rules

- Keep screens purposeful. Avoid clutter.
- Consistent spacing, hierarchy, typography, interaction patterns.
- Define: empty, loading, error, success, partial-data states.
- Define sheets/modals/drawers/tabs/navigation/transitions before coding.
- No decorative UI that doesn't support comprehension or action.
- No visual direction change without approval.

## Global Engineering Rules

- Define data models before persistence.
- Define API contracts before implementation.
- Define error handling before wiring.
- Define auth/security boundaries before exposing features.
- Define integration ownership before adding dependencies.
- Prefer small, understandable modules.
- Avoid hidden coupling.
- Avoid magic behavior that is not documented.

## Feature Architecture Files

Every meaningful feature must have:
`features/<feature-name>/FEATURE_ARCHITECTURE.md`

## Current Features

*Claude: populate this as features are defined and approved.*

## Approval Rule

Implementation must not begin until the relevant feature architecture file says:

`Architecture approved: Yes`
`Implementation allowed: Yes`

---

## FinRobot vs FinanceOS Comparison

FinRobot (github.com/ai4finance-foundation/finrobot) is a Python/AutoGen research framework. Key differences:

| Dimension | FinRobot | FinanceOS |
|---|---|---|
| Language | Python + AutoGen | TypeScript + Next.js |
| Deployment | Research notebook / local | Production web app |
| LLM coupling | Tightly coupled to OpenAI/AutoGen | LLM-agnostic (Claude/DeepSeek/Groq/Gemini swappable) |
| Data source | Golden dataset for evaluation | Real paper trades for evaluation |
| Agent hierarchy | Director → Analyst multi-agent | ResearchAgent → TraderAgent → LearnerAgent pipeline |
| Social signals | News only | News + StockTwits + Alpha Vantage sentiment |
| Scheduler | Smart scheduler (event-driven) | Cron + on-demand (7PM EST daily refresh) |
| Safety gates | Limited | approval_required mode, agentic account isolation |
| Learning loop | Per-run feedback | Weekly batch (min 10 trades before Phase 1) |
| Real money | No | Robinhood paper → real (Phase 1) |
| Multi-LLM comparison | No | Claude vs DeepSeek vs Groq P&L comparison built-in |

## Database Schema (as of 2026-06-29)

### Tables Added / Modified in 2026-06-29 Session

#### migration 026 — `paper_positions` exit columns
```sql
ALTER TABLE paper_positions
  ADD COLUMN price_target numeric,
  ADD COLUMN stop_loss numeric,
  ADD COLUMN highest_price numeric,
  ADD COLUMN target_updated_at timestamptz,
  ADD COLUMN exit_reason text;   -- 'stop' | 'target' | 'llm_exit'
```

#### migration 027 — `strategy_config` risk profile columns
```sql
ALTER TABLE strategy_config
  ADD COLUMN risk_profile text DEFAULT 'Balanced',   -- 'Conservative' | 'Balanced' | 'Aggressive'
  ADD COLUMN score_threshold numeric DEFAULT 60,
  ADD COLUMN position_size_pct numeric DEFAULT 10,
  ADD COLUMN stop_loss_pct numeric DEFAULT 7,
  ADD COLUMN target_pct numeric DEFAULT 20;
```

#### migration 028 — `macro_regime` + `macro_signals` (new tables)
```sql
CREATE TABLE macro_regime (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  regime text NOT NULL,          -- 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'
  danger_score numeric NOT NULL, -- 0-100
  computed_at timestamptz DEFAULT now()
);

CREATE TABLE macro_signals (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  regime_id uuid REFERENCES macro_regime(id),
  indicator text NOT NULL,       -- 'yield_curve' | 'sahm_rule' | 'real_gdp' | etc.
  raw_value numeric,
  contribution numeric,          -- weighted contribution to danger_score
  direction text,                -- 'positive' | 'negative' | 'neutral'
  computed_at timestamptz DEFAULT now()
);
```

---

## New API Routes (2026-06-29)

| Route | Method | Purpose |
|---|---|---|
| `/api/agents/position-monitor` | POST | Run trailing stop + target exit check on all open paper_positions |
| `/api/agents/macro-sentinel` | POST | Fetch 8 macro indicators, compute danger score + regime, save to macro_regime |
| `/api/settings/risk-profile` | GET | Return current risk profile from strategy_config |
| `/api/settings/risk-profile` | PATCH | Update risk_profile + threshold/sizing fields in strategy_config |
| `/api/markets/insider-trades` | GET | Alpha Vantage insider buys + House Stock Watcher congressional trades |
| `/api/admin/llm-costs` | GET | Burn rate, projected daily, per-model breakdown from llm_call_log |
| `/api/mentor/scores` | GET | Trade journal judgment scores grouped by date |

---

## New Components (2026-06-29)

| Component | Path | Purpose |
|---|---|---|
| AgentDiagram | `components/dashboard/AgentDiagram.tsx` | Clickable Mermaid v10 flowchart per agent with node status coloring and detail drawer |

---

## Static Assets (2026-06-29)

`public/agent-diagrams/` — 7 JSON files defining node graph per agent:
- `research-agent.json`
- `learner-agent.json`
- `theme-scout.json`
- `deepseek-agent.json`
- `position-monitor.json`
- `paper-trader.json`
- `macro-sentinel.json`

---

## Scheduled Tasks (Windows Task Scheduler — 7 tasks as of 2026-06-29)

| Task | Schedule | Endpoint |
|---|---|---|
| ResearchAgent | Weekdays 9:00AM | `/api/agents/research` |
| DeepSeekAgent | Weekdays 9:00AM | `/api/agents/deepseek` |
| PaperTrader | Weekdays 9:30AM | `/api/agents/paper-trader` |
| PositionMonitor | Weekdays 4:15PM | `/api/agents/position-monitor` |
| LearnerAgent | Mondays 6:00AM | `/api/agents/learner` |
| ThemeScout | Sundays 8:00PM | `/api/agents/theme-scout` |
| MacroSentinel | Mondays 8:00AM | `/api/agents/macro-sentinel` |

---

## External Data Sources (2026-06-29)

| Source | Used For | Auth |
|---|---|---|
| Alpha Vantage INSIDER_TRANSACTIONS | Corporate insider buy/sell data for ResearchAgent scoring + MarketsPage | API key in vault |
| House Stock Watcher (public S3) | Congressional stock trade disclosures | None (public) |
| Alpha Vantage macro endpoints (TREASURY_YIELD, UNEMPLOYMENT, REAL_GDP, NONFARM_PAYROLL, CPI, RETAIL_SALES, FEDERAL_FUNDS_RATE, DURABLES) | MacroSentinel 8-indicator danger score | API key in vault |

---

### Our scheduler vs FinRobot's Smart Scheduler
FinRobot's scheduler is event-driven (earnings, news). Ours is simpler but production-hardened:
- 7PM EST daily: earnings calendar refresh (Massive API, no LLM)
- Market open: ResearchAgent screener run (3 candidates/day max)
- Per-signal: LearnerAgent records outcome after trade closes
- Weekly batch: weight mutation after ≥10 closed trades
