# Architecture â€” Kairos

## Project Purpose

**Comprehensive Kairos â€” broader scope than FinNudge, production architecture**

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

## FinRobot vs Kairos Comparison

FinRobot (github.com/ai4finance-foundation/finrobot) is a Python/AutoGen research framework. Key differences:

| Dimension | FinRobot | Kairos |
|---|---|---|
| Language | Python + AutoGen | TypeScript + Next.js |
| Deployment | Research notebook / local | Production web app |
| LLM coupling | Tightly coupled to OpenAI/AutoGen | LLM-agnostic (Claude/DeepSeek/Groq/Gemini swappable) |
| Data source | Golden dataset for evaluation | Real paper trades for evaluation |
| Agent hierarchy | Director â†’ Analyst multi-agent | ResearchAgent â†’ TraderAgent â†’ LearnerAgent pipeline |
| Social signals | News only | News + StockTwits + Alpha Vantage sentiment |
| Scheduler | Smart scheduler (event-driven) | Cron + on-demand (7PM EST daily refresh) |
| Safety gates | Limited | approval_required mode, agentic account isolation |
| Learning loop | Per-run feedback | Weekly batch (min 10 trades before Phase 1) |
| Real money | No | Robinhood paper â†’ real (Phase 1) |
| Multi-LLM comparison | No | Claude vs DeepSeek vs Groq P&L comparison built-in |

## Database Schema (as of 2026-06-29)

### Tables Added / Modified in 2026-06-29 Session

#### migration 026 â€” `paper_positions` exit columns
```sql
ALTER TABLE paper_positions
  ADD COLUMN price_target numeric,
  ADD COLUMN stop_loss numeric,
  ADD COLUMN highest_price numeric,
  ADD COLUMN target_updated_at timestamptz,
  ADD COLUMN exit_reason text;   -- 'stop' | 'target' | 'llm_exit'
```

#### migration 027 â€” `strategy_config` risk profile columns
```sql
ALTER TABLE strategy_config
  ADD COLUMN risk_profile text DEFAULT 'Balanced',   -- 'Conservative' | 'Balanced' | 'Aggressive'
  ADD COLUMN score_threshold numeric DEFAULT 60,
  ADD COLUMN position_size_pct numeric DEFAULT 10,
  ADD COLUMN stop_loss_pct numeric DEFAULT 7,
  ADD COLUMN target_pct numeric DEFAULT 20;
```

#### migration 028 â€” `macro_regime` + `macro_signals` (new tables)
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

`public/agent-diagrams/` â€” 7 JSON files defining node graph per agent:
- `research-agent.json`
- `learner-agent.json`
- `theme-scout.json`
- `deepseek-agent.json`
- `position-monitor.json`
- `paper-trader.json`
- `macro-sentinel.json`

---

## Scheduled Tasks (Windows Task Scheduler — updated 2026-07-01)

All times ET. Script: `scripts/run-agents.ps1 -Agent <name>`

| Task | Schedule | Endpoint | Notes |
|---|---|---|---|
| brief-morning | Weekdays 8:00 AM | `/api/briefing/generate` | Email before market open |
| research | Weekdays 9:00 AM | `/api/agents/research/cron` | Pre-market signal generation; respects market_focus region ETFs |
| trader | Weekdays 9:45 AM | `/api/agents/trader` | Proposals after research settles; approval_required=true |
| position-monitor | Weekdays 4:15 PM | `/api/agents/position-monitor` | Post-close trailing stop + exit checks |
| brief-evening | Weekdays 4:30 PM | `/api/briefing/generate` | Email recap |
| nav-snapshot | Weekdays 5:00 PM | `/api/agents/performance` | Daily NAV + alpha snapshot |
| learner | Fridays only 5:00 PM | `/api/agents/learner` | Weekly weight learning; route skips non-Fridays |
| stale-check | Every 4h | `/api/alerts/stale-check` | Alert if agent runs are stale |
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
- Weekly batch: weight mutation after â‰¥10 closed trades


---

## Session 2026-07-01 — Major Feature Drop

### Platform Rename: FinanceOS → Kairos
- Product renamed to **Kairos** ("Right signal. Right moment.")
- Updated: pp/layout.tsx title/description, package.json name, DashboardShell.tsx sidebar brand
- Tagline displayed below logo in sidebar

### New DB Migrations Applied
| Migration | Tables | Key Changes |
|---|---|---|
| 031 | agent_config | Per-agent config (enabled, schedule, params) |
| 032 | agent_signals | sset_class column + ETF/metal seeds |
| 033 | learner_config, learning_priors, signal_weights_history | LearnerAgent controls + weight rollback |
| 034 | paper_order_events | Immutable append-only event log; UPDATE/DELETE blocked by trigger |
| 035 | evidence_records, corporate_actions | Evidence ledger (immutable, payload_hash dedup); corporate actions |
| 036 | strategy_versions, experiment_runs | Champion/challenger governance; backtest eligibility gates |
| 037 | trade_proposals, decision_journal | TraderAgent proposals (30-min expiry, HARDCODED account 605420650) |

### New API Routes (2026-07-01)
| Route | Method | Purpose |
|---|---|---|
| /api/agents/research/cron | POST | Cron-triggered research (weekends/holidays skipped) |
| /api/agents/trader | POST | TraderAgent proposals + approve/reject; HARDCODED account 605420650 |
| /api/agents/learner-controls | GET/PATCH/POST | Per-dimension learn_from/allow_mutation + rollback/factory_reset |
| /api/agents/backtest | POST | JS backtest engine vs price_cache; eligibility gates (Sharpe≥0.5, win_rate≥40%) |
| /api/agents/corporate-actions | GET/POST | AV SPLITS + DIVIDENDS sync for held + watchlist |
| /api/agents/learner-brain | POST | Full LearnerAgent DeepSeek tool-use loop |
| /api/strategies/versions | GET/POST | Champion/challenger list; promote/retire/reject |
| /api/journal | GET/POST | Decision journal CRUD; signal→fill→outcome linking |
| /api/markets/smart-money | GET | Options flow + insider signals aggregated |
| /api/markets/edgar-insiders | GET | SEC EDGAR Form 4 CIK lookup + XML parse → evidence_records |
| /api/markets/breadth | GET | Market breadth (advance/decline, new highs/lows, % above MA) |

### New Pages (2026-07-01)
| Page | Path | Purpose |
|---|---|---|
| Smart Money | /dashboard/smart-money | Trade queue, insider flow, multi-asset signals, asset class tabs |

### New Components (2026-07-01)
| Component | Purpose |
|---|---|
| SmartMoneyPage.tsx | Smart money hub with 4 tabs |
| MermaidChart.tsx | Mermaid v10 diagram renderer |

### Research Agent Changes (2026-07-01)
- **Phase 0**: All 5 scores now deterministic (no LLM score generation)
  - lib/data/scores.ts — computeScores() using real AV + candle data
  - lib/data/technicals.ts — pure-math RSI(14), EMA(20/50)
  - lib/data/quotes.ts — deterministic quote adapter with price_cache fallback
  - lib/data/evidence.ts — evidence write helpers
- **market_focus wired**: gatherSymbols() reads profiles.market_focus; non-US regions append region ETFs (India→INDA/EPI/INDY, Europe→VGK/EWG, Asia→EWJ/EWT/EWY, Crypto→IBIT/BITO)
- **LLM role**: thesis + direction only (Groq 70B, 512 tokens); never generates scores

### LearnerAgent Changes (2026-07-01)
- Full DeepSeek tool-use agent with 9 tools
- **Schedule**: Fridays only at 5 PM ET (was incorrectly documented as Mondays 6 AM)
- Auto-guard blocks mutation if last 3 runs win_rate < 35%
- Phase gate: requires ≥10 closed trades before weight mutation

### Settings Changes (2026-07-01)
- market_focus multi-select: chip buttons (US/India/Europe/Asia/Crypto/Global), comma-separated text in DB
- Types updated: market_focus: string (was enum US|India|Both)

### Newsletter (2026-07-01)
- Wired: EDGAR insiders (7d), pending trade proposals, learner dimension weights sections
- Deployed to Supabase as v4

---

## Session 2026-07-03 — Live Portfolio, Enrichment Pipeline, All-Accounts Fix

### Live Portfolio Feature

New full-stack feature: ingests ALL Robinhood account holdings + historical CSV trades, enriches with macro context and outcome scores, surfaces in dedicated page.

#### New DB Migration Applied
| Migration | Tables | Key Changes |
|---|---|---|
| 043 | `uploaded_trade_files`, `trade_decisions` | CSV dedup tracking (SHA-256 hash); trade audit log with outcome scoring, macro tagging, enrichment lifecycle |

**`uploaded_trade_files`:** filename, file_hash (UNIQUE), trade_count, duplicate_count, date_range_start/end, broker. Prevents re-importing same CSV.

**`trade_decisions`:** symbol, action (buy/sell), qty, exec_price, exec_date, price_1d/1w/1m/3m_after, outcome_score, pattern_tags, macro_market_regime, macro_event_tag, enrichment_status (pending → enriched | no_data). UNIQUE on (symbol, action, exec_date, exec_price, qty) for cross-source dedup.

#### New API Routes (2026-07-03)
| Route | Method | Purpose |
|---|---|---|
| `/api/live-portfolio` | GET | Merge positions from all `live_account_snapshots` rows; accepts `?accounts=id1,id2` filter; calls `getBatchQuotes` for current prices |
| `/api/live-portfolio/performance` | GET | AV daily series per held symbol (300ms stagger); returns dates[], portfolio[], holdings[]; accepts `?period=1M&accounts=...` |
| `/api/live-portfolio/import-csv` | POST | Accept Robinhood CSV (multipart); SHA-256 dedup; parse transactions; write to `trade_decisions`; return { imported, duplicates, file_id } |
| `/api/live-portfolio/files` | GET/DELETE | List uploaded CSV files; DELETE removes file record + its trade_decisions rows |
| `/api/live-portfolio/decisions` | GET | Paginated `trade_decisions` with filter support (symbol, action, enrichment_status, regime) |
| `/api/live-portfolio/enrich` | POST | Body: `{ limit: 200 }`. Groups pending trade_decisions by symbol; fetches AV `TIME_SERIES_DAILY_ADJUSTED` once/symbol (350ms stagger); computes price_1d/1w/1m/3m_after via ±7-day nearest-close lookup; assigns outcome_score and macro_market_regime from 10-epoch hardcoded table; marks enriched/no_data |

#### Enrichment Pipeline Detail

**Macro regime table (hardcoded, 10 epochs):**
- 2000-03 to 2002-10: dot-com bust
- 2007-12 to 2009-06: financial crisis
- 2020-02 to 2020-03: covid crash
- 2020-03 to 2021-12: recovery/stimulus
- 2022-01 to 2023-01: fed hike cycle
- Otherwise: neutral

**Outcome score formula:**
- BUY: `(price_1m_after - exec_price) / exec_price * 100`
- SELL: `-(price_1m_after - exec_price) / exec_price * 100`

#### New Page (2026-07-03)
| Page | Path | Purpose |
|---|---|---|
| Live Portfolio | `/dashboard/live-portfolio` | View all 6 Robinhood account positions (live); performance chart; import CSV trades; enrichment trigger; trade decisions table with macro context |

#### New Components (2026-07-03)
| Component | Purpose |
|---|---|
| `LivePortfolioPage.tsx` | Unified live portfolio hub: account positions view, CSV import/manage panel, "Analyze Now" enrichment button (amber), trade decisions table with stats bar |

**LivePortfolioPage key behaviors:**
- Tabs: Live Positions / Trade History / Performance
- CSV panel: multi-file add, shows file list with trade counts + date ranges, remove button per file
- Source badge on each decision row: "robinhood_mcp" vs CSV filename
- "Analyze Now" button fires POST `/api/live-portfolio/enrich`; updates pending/enriched counts live without page reload

---

### ResearchAgent All-Accounts Fix (2026-07-03)

**Problem:** `fetchHoldings()` in `lib/research-agent.ts` had `.eq("account_id", TRADING_ACCOUNT)` — only pulled holdings from account `965848641`. Ignored 4 other accounts holding positions.

**Fix:** Removed account filter. Now reads ALL `live_account_snapshots` rows, deduplicates symbols with `Set<string>`.

```typescript
// lib/research-agent.ts — fetchHoldings() after fix
export async function fetchHoldings(supabase: any): Promise<string[]> {
  const { data } = await supabase
    .from("live_account_snapshots")
    .select("positions_json")
    .order("captured_at", { ascending: false });
  const symbols = new Set<string>();
  for (const row of data ?? []) {
    const positions = row?.positions_json;
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (p?.symbol) symbols.add(p.symbol.toUpperCase());
    }
  }
  return Array.from(symbols);
}
```

**Impact:** ResearchAgent now considers SELL signals for all 6 Robinhood accounts, not just the trading account.

---

### LearnerAgent Changes (2026-07-03)

#### New Tool: `query_trade_decisions`
Added as tool #7 in `app/api/agents/learner/route.ts`. Allows LearnerAgent to query real historical trade outcomes from `trade_decisions` where `enrichment_status = 'enriched'`.

Parameters: `action` (buy/sell), `regime` (ilike match on macro_market_regime), `min_outcome_score`, `max_outcome_score`.

Returns: `total_enriched`, `wins`, `losses`, `avg_outcome_score`, `regime_breakdown`, top 30 decisions.

**Purpose:** LearnerAgent can now learn from real decade-spanning trade history, not just paper trades.

#### Model Upgrade
- **Before:** `deepseek-chat` (finance benchmark accuracy: unknown/untested)
- **After:** `claude-opus-4-8` (AIMultiple benchmark: 89.08%, best value tier)
- Updated via Supabase MCP `execute_sql` on `agent_config` table — no code change required

---

## Planned Architecture — [REVIEW PENDING — ChatGPT]

Items below are approved for architecture review. Not yet implemented. Each section marked with status.

---

### 1. RAG Pipeline — Semantic Trade Memory [REVIEW PENDING — ChatGPT]

**Status:** Architecture proposed. Not implemented.

**Problem:** LearnerAgent reads raw trade rows. Cannot ask "what patterns worked in rate-hike regimes with high RSI?" — needs semantic search across 10+ years of decisions.

**Proposed Stack:**
- **Embeddings:** Voyage AI `voyage-3.5` (finance-tuned, 1536-dim). npm package: `voyageai`. Best-in-class on financial text retrieval benchmarks.
- **Vector store:** Supabase pgvector (extension already available). New table: `trade_decision_embeddings(decision_id, embedding vector(1536), metadata jsonb)`.
- **Reranker:** `gte-reranker-modernbert-base` (free, HuggingFace, +8% recall on financial text). Runs post-retrieval to rerank top-K candidates before feeding to LLM.
- **Query path:** LearnerAgent calls new `semantic_search_decisions` tool → pgvector cosine similarity ANN query → reranker → top-5 decisions returned as context.

**Migration needed:** `044_trade_decision_embeddings.sql`
- Enable `vector` extension
- Create `trade_decision_embeddings` table
- Create IVFFlat index for ANN queries

**New API route:** `POST /api/live-portfolio/embed` — batch-embed all enriched trade_decisions not yet in embeddings table; call Voyage API; upsert to Supabase.

**LearnerAgent change:** Add `semantic_search_decisions` tool (tool #8). Embed the query text via Voyage, cosine-search pgvector, rerank, return.

---

### 2. Langfuse Observability [REVIEW PENDING — ChatGPT]

**Status:** Chip spawned (task_63b52714). Not implemented.

**Problem:** No visibility into token usage per agent, latency per tool call, or LLM cost per run. `llm_call_log` table captures costs but no trace correlation or UI.

**Proposed integration:**
- Add Langfuse SDK (`langfuse` npm package) as thin wrapper around all LLM calls in `lib/llm-router.ts`.
- Each agent run = one Langfuse trace. Each tool call = one span. Each LLM call = one generation.
- Langfuse cloud (free tier) or self-hosted via Docker.
- New env var: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`.
- No changes to agent logic — observability is a cross-cutting concern added at `llm-router.ts` level.

**What it enables:**
- Per-agent latency breakdown
- Token cost per tool call
- LLM output quality scoring (human or automated)
- Session replay for debugging agent loops

---

### 3. Firecrawl ResearchAgent Integration [REVIEW PENDING — ChatGPT]

**Status:** Firecrawl MCP added (`claude mcp add firecrawl`). Requires new Claude session to activate. API key stored.

**Problem:** ResearchAgent uses Alpha Vantage NEWS_SENTIMENT for news. Cannot crawl full article bodies, SEC filings pages, or curated financial intelligence sites.

**Proposed integration:**
- Expose Firecrawl as a tool in ResearchAgent's tool list: `crawl_url(url, options)`.
- Use for: SEC EDGAR filing body extraction, earnings transcript pages, curated sources (e.g. industry-specific blogs with known bias scores).
- Source quality hierarchy (from Decision 3) still enforced: Firecrawl output = unverified hypothesis until corroborated by primary source.
- Rate limiting: max 3 Firecrawl calls per ResearchAgent run to stay within API credits.

**Constraint:** Firecrawl MCP requires a new Claude session to be active. Until activated, ResearchAgent falls back to AV NEWS_SENTIMENT.

---

### 4. LangGraph Migration (Future — Phase 2+) [REVIEW PENDING — ChatGPT]

**Status:** Research complete. No implementation until Phase 1 complete.

**Current state:** Agent pipeline = sequential HTTP calls (ResearchAgent → PaperTrader → LearnerAgent). No retry, no state persistence across steps, no parallel branches.

**LangGraph 1.0 GA value:**
- Persistent agent state (survives server restarts)
- Built-in retry + error recovery per node
- Parallel branches (e.g. momentum bucket + value bucket research simultaneously)
- Human-in-the-loop checkpoints (exactly what approval_required mode needs)
- Used in production at Uber, LinkedIn, Klarna

**Migration path:**
- Phase 2 (after ≥10 closed paper trades, Python Validation Engine exists): migrate ResearchAgent → PaperTrader loop to LangGraph graph.
- Each agent node in LangGraph replaces current HTTP route chain.
- State schema = TypedDict with positions, signals, proposals, approvals.
- Keep Next.js API routes as thin HTTP triggers → LangGraph graph entry points.

**Do not migrate early.** Current sequential loop is debuggable and sufficient for Phase 0/1. LangGraph complexity only justified when parallel execution or state persistence becomes a real bottleneck.

---

### 5. LLM Model Strategy [REVIEW PENDING — ChatGPT]

**Status:** Partially implemented (LearnerAgent upgraded to Opus 4.8). Full strategy proposed.

**AIMultiple Finance LLM Benchmark (2026 Q2):**
| Model | Finance Accuracy | Role in Kairos |
|---|---|---|
| Claude Fable 5 | 90.34% (#1) | Future upgrade for ResearchAgent thesis + LearnerAgent |
| Claude Opus 4.8 | 89.08% (best value) | **Current LearnerAgent model** ✅ |
| Claude Sonnet 4.6 | 83.61% | Current session model |
| DeepSeek-chat | Untested on finance benchmark | **Removed from LearnerAgent** |

**Proposed model routing:**
- **ResearchAgent thesis:** Upgrade from Groq 70B → Claude Fable 5 (highest accuracy for signal generation)
- **LearnerAgent:** Claude Opus 4.8 ✅ (already done)
- **PaperTrader:** Keep Sonnet 4.6 (low-stakes fill decisions, cost-efficient)
- **Briefing:** Keep Sonnet 4.6 (narrative generation, accuracy less critical)
- **MacroSentinel:** Keep Groq 70B (fast, simple classification)

**Cost guard:** All model upgrades must pass `llm_call_log` cost check (under $2/day budget at current run frequency).

---

### 6. Additional Roadmap Items [REVIEW PENDING — ChatGPT]

These items identified from AIMultiple synthesis and current gaps. Not yet architectured.

| Item | Priority | Rationale |
|---|---|---|
| Kelly / Half-Kelly position sizing in TraderAgent | High | Current 10% flat sizing ignores conviction strength. Half-Kelly reduces ruin risk. |
| Journal UI (`/dashboard/journal`) | Medium | `app/api/journal/` route exists but no UI page. Decision journal data is stranded. |
| History collapse in AgentsPage | Low | Each agent run expands inline; long runs make page unwieldy. |
| Python Validation Engine | High (Phase 1 gate) | Required before strategy promotion. Deterministic backtesting with historical replay. FEATURE_ARCHITECTURE.md documents spec. |
| Strategy Registry UI | Medium | `strategy_versions` table exists; no UI to promote/retire/view challengers. |
| Learner Brain/Controls UI | Medium | Routes exist (`/api/agents/learner-brain`, `/api/agents/learner-controls`) but no UI panel. |

---

## Accounts Reference

| Account | ID | Permission |
|---|---|---|
| Default | 5QZ42862 | Read-only snapshot |
| Joint | 116781169200 | Read-only snapshot |
| Managed | 181262410481 | Read-only snapshot |
| Trading | 965848641 | Read-only snapshot |
| Autopilot | 991989781 | Read-only snapshot |
| Agentic | 605420660 | **ONLY account for order placement** |

ResearchAgent reads holdings from ALL accounts. TraderAgent proposals hardcoded to `605420660`. No exceptions.
