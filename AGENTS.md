# AGENTS.md — Universal Agent Entrypoint

> **EVERY AI agent (Claude, Codex, ChatGPT, Gemini, etc.) reads this file FIRST before doing anything.**
> This is the coordination layer for a multi-model development team.
> Do not start work until you have read this file and the files it points to.

---

## What This Project Is (30-Second Context)

FinanceOS is a personal AI-powered trading OS for one user (Vaibhav, `vterminater@gmail.com`).
It is a Next.js 15 app + Supabase backend + Anthropic Claude API, extended with a Robinhood MCP
agentic trading integration. Four AI agents (ResearchAgent, AnalystAgent, TraderAgent, LearnerAgent)
research stocks, score them, trade via Robinhood, and self-improve from outcomes.

Full spec: `PRD.md`
Full architecture: `ARCHITECTURE.md`
Coding conventions: `PRD.md` Section 2
DB schema: `PRD.md` Section 3
Market knowledge: `knowledge/KNOWLEDGE_INDEX.md`

---

## Read Order (Do Not Skip)

1. `AGENTS.md` ← you are here
2. `WORK_LOG.md` ← what's in progress, what's next, what's blocked
3. `PRD.md` ← full product spec and coding conventions
4. `knowledge/KNOWLEDGE_INDEX.md` ← market knowledge base
5. Only then: read files relevant to your assigned task

---

## Current Role Assignments

> Vaibhav updates this section when switching models.

| Role | Assigned To | Scope |
|---|---|---|
| Architect | Claude (Anthropic) | System design, PRD updates, feature architecture files |
| Builder | TBD (Claude / Codex) | Implementation of approved architecture |
| Reviewer | TBD | Code review, security, correctness checks |
| Researcher | Claude (Anthropic) | Knowledge base population, signal validation |

**If your role is not listed or unclear → stop and ask Vaibhav before writing any code.**

---

## Role Definitions

### Architect
- **Can:** Design systems, write `FEATURE_ARCHITECTURE.md` files, update `PRD.md`, propose decisions in `PROJECT_DECISIONS.md`
- **Cannot:** Write implementation code without Vaibhav's approval of the architecture
- **Gate:** All architecture must be approved ("Approved", "Proceed", "Code it") before Builder starts

### Builder
- **Can:** Implement **approved architecture only**. Write code in `app/`, `components/`, `lib/`, API routes.
- **Cannot:** Invent new layouts, add unapproved features, change DB schema without a migration plan, modify `PRD.md` or `AGENTS.md`
- **Must do:** Read the relevant `FEATURE_ARCHITECTURE.md` before writing a single line
- **Must do:** Claim task in `WORK_LOG.md` before starting (prevents conflicts)
- **Must do:** Follow ALL conventions in `PRD.md` Section 2 exactly

### Reviewer
- **Can:** Read any file, flag issues, suggest fixes
- **Cannot:** Directly edit production code — creates a PR or comments only

### Researcher
- **Can:** Add/update files in `knowledge/` directory
- **Cannot:** Change DB schema, app code, or PRD without Architect approval

---

## Work Claiming Protocol (CRITICAL — Prevents Conflicts)

Before starting ANY task:

1. Read `WORK_LOG.md` — is this task already claimed? If yes, stop.
2. Add your claim to `WORK_LOG.md`:
   ```
   | Task name | YOUR_MODEL_NAME | in_progress | YYYY-MM-DD |
   ```
3. Do the work.
4. Update `WORK_LOG.md` to `completed` when done.

**Never work on a task already marked `in_progress` by another agent.**

---

## Decision Authority

| Decision Type | Who Can Make | Where Logged |
|---|---|---|
| DB schema changes | Architect + Vaibhav approval | `PROJECT_DECISIONS.md` + new migration file |
| New API routes | Architect + Vaibhav approval | `PROJECT_DECISIONS.md` |
| Signal weight changes | LearnerAgent only | `knowledge/signal-library/proven-signals.md` |
| Regime model changes | Architect + Vaibhav approval | `knowledge/market-mechanics/regime-detection.md` |
| Style/UI changes | Builder, must follow `PRD.md` Section 2 | — |
| Adding npm packages | Architect + Vaibhav approval | `PROJECT_DECISIONS.md` |
| Trade execution | TraderAgent only, always logs to `trade_log` | Supabase `trade_log` table |

---

## FinNudge — Absolute Rule

`C:\Users\vaibh\OneDrive\Documents\Startup\FinNudge\` is a **completely separate app (budgeting)**. 

- **NEVER edit any file in FinNudge. Ever. For any reason.**
- Read-only reference is allowed (to copy design patterns into FinanceOS)
- All copied code lives in FinanceOS — never imported from FinNudge path
- If a task requires touching FinNudge → stop immediately and tell Vaibhav

---

## What NEVER to Do (Any Agent, Any Role)

1. **Never re-litigate approved decisions.** If it's in `PROJECT_DECISIONS.md` as approved → implement it, don't redesign it.
2. **Never invent styling conventions.** Inline styles with `T` color tokens only. No Tailwind classes. No CSS modules. See `PRD.md` Section 2.1.
3. **Never use Tailwind utility classes.** The codebase does not use them. Do not add them.
4. **Never touch the primary Robinhood account.** Agentic account (`••••0660`) only.
5. **Never execute a trade without the LTCM check.** See `knowledge/market-mechanics/risk-management.md`.
6. **Never add features beyond the current task scope.** No scope creep.
7. **Never commit secrets.** No API keys, no Robinhood tokens, no Supabase service role keys in code.
8. **Never modify `AGENTS.md` or `PRD.md` without Architect role + Vaibhav approval.**

---

## Handoff Protocol

When passing work between models (e.g., Claude architects → Codex builds):

1. **Architect creates:** `features/<feature-name>/FEATURE_ARCHITECTURE.md` with:
   - What to build (precise)
   - File paths to create/modify
   - Data contracts (input/output shapes)
   - UI spec (if frontend)
   - What NOT to do

2. **Builder reads:** That file first, then implements.

3. **On completion:** Builder updates `WORK_LOG.md` and notes any deviations from architecture with reason.

4. **Reviewer checks:** Against the architecture file, not against their own opinion.

---

## Model-Specific Notes

### Claude (Anthropic)
- Strong at: Architecture, analysis, reasoning, writing knowledge base entries
- Weakness: Can drift into scope creep — stick to approved architecture
- Use for: Designing agent systems, writing FEATURE_ARCHITECTURE.md, knowledge research

### Codex / OpenAI models
- Strong at: Fast code generation, boilerplate, implementing clear specs
- Weakness: May invent conventions if spec is ambiguous — be very explicit in architecture files
- Use for: Building out pages, components, API routes from approved specs

### ChatGPT (GPT-4+)
- Strong at: Broad reasoning, good at following explicit instructions
- Use for: Code review, explaining tradeoffs, helping debug

### General rule
The more explicit the `FEATURE_ARCHITECTURE.md`, the better any model performs.
Vague instructions → any model invents its own patterns → inconsistency.

---

## Environment Variables Required

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
ANTHROPIC_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

Robinhood MCP is configured in `.claude.json` (local only, not in repo).

---

## Tech Stack Quick Reference

| Layer | Tech | Import path pattern |
|---|---|---|
| Framework | Next.js 15 App Router | — |
| DB + Auth | Supabase | `@/lib/supabase/server` or `@/lib/supabase/client` |
| AI | Anthropic Claude | `@anthropic-ai/sdk` via `/api/ai/route.ts` |
| Types | Centralized | `@/types` |
| Styling | Inline styles + T tokens | Define `T` object in each file |
| Charts | Recharts | `recharts` |

---

## Live Agent Registry (as of 2026-06-29)

### ResearchAgent
- **Endpoint:** `/api/agents/research/route.ts`
- **Schedule:** Weekdays 9AM (Windows Task Scheduler)
- **Inputs:** watchlist symbols, Massive API fundamentals, Alpha Vantage technicals, StockTwits/Alpha Vantage sentiment
- **Outputs:** `agent_signals` table rows (score 0-100, recommendation, signal_breakdown)
- **Updates (2026-06-29):**
  - Insider scoring: `scoreInsider()` fetches Alpha Vantage INSIDER_TRANSACTIONS, computes 90-day buy/sell ratio, injects as pre-fetched context in LLM prompt (advisory, not hardcoded score override)
  - Risk profile integration: reads `strategy_config.risk_profile`, applies `PROFILE_WEIGHTS` multiplier, uses `score_threshold` from strategy_config as the buy signal cutoff
  - Screener target remains 3 candidates/day max

### DeepSeekAgent
- **Endpoint:** `/api/agents/deepseek/route.ts`
- **Schedule:** Weekdays 9AM (Windows Task Scheduler)
- **Inputs:** same watchlist as ResearchAgent
- **Outputs:** `agent_signals` rows tagged `agent_label = 'deepseek'`; enables LLM P&L comparison vs Claude

### PaperTrader
- **Endpoint:** `/api/agents/paper-trader/route.ts`
- **Schedule:** Weekdays 9:30AM (Windows Task Scheduler)
- **Inputs:** `agent_signals` with score >= `strategy_config.score_threshold`
- **Outputs:** `paper_positions` rows; respects `position_size_pct` from risk profile

### PositionMonitor
- **Endpoint:** `/api/agents/position-monitor/route.ts`
- **Schedule:** Weekdays 4:15PM (Windows Task Scheduler, after market close)
- **Inputs:** open `paper_positions` with `price_target`, `stop_loss`, `highest_price`
- **Behavior:**
  - Trailing stop: `max(original_stop_loss, highest_price × 0.93)`
  - Updates `highest_price` if current price is new high
  - Closes position (sets `exit_reason`) if price hits stop or target
  - Returns cash to buying power on close
- **Outputs:** updated `paper_positions` rows; closed positions get `exit_reason` set

### LearnerAgent
- **Endpoint:** `/api/agents/learner/route.ts`
- **Schedule:** Mondays 6AM (Windows Task Scheduler)
- **Inputs:** `paper_trades`, `learning_log`, closed positions
- **Outputs:** `learning_log` entries; 1-sentence outcome summary per closed trade
- **Updates (2026-06-29):** Weekly reassessment of open positions added — flags `llm_exit` if LLM recommends closing based on updated thesis
- **Gate:** Weight mutation locked until 10+ closed trades (Phase 0)

### ThemeScout
- **Endpoint:** `/api/agents/theme-scout/route.ts` (also Supabase edge function)
- **Schedule:** Sundays 8PM (Windows Task Scheduler)
- **Inputs:** Alpha Vantage news sentiment by sector
- **Outputs:** dynamic watchlist additions tagged by theme

### MacroSentinel
- **Endpoint:** `/api/agents/macro-sentinel/route.ts`
- **Schedule:** Mondays 8AM (Windows Task Scheduler)
- **Inputs:** 8 Alpha Vantage macroeconomic indicators:
  1. Yield Curve (10Y-2Y spread)
  2. Sahm Rule proxy (unemployment rate delta)
  3. Real GDP (QoQ growth)
  4. Nonfarm Payrolls (MoM change)
  5. CPI (YoY inflation)
  6. Retail Sales (MoM change)
  7. Federal Funds Rate
  8. Durable Goods Orders (MoM)
- **Behavior:** Computes weighted danger score 0-100. Assigns regime: GREEN (<25), YELLOW (25-49), ORANGE (50-74), RED (≥75). Advisory-only — does NOT auto-throttle agents or halt trading.
- **Outputs:**
  - `macro_regime` table row (current regime + score)
  - `macro_signals` table rows (per-indicator breakdown)
  - MarketsPage gauge card + signal breakdown table
  - DashboardHome colored banner when regime != GREEN
- **Why advisory-only:** Agent auto-throttle without user seeing first run creates surprising behavior. User reviews regime first, then decides whether to act.

### Agent Diagrams
- **Component:** `components/dashboard/AgentDiagram.tsx`
- **Data:** `public/agent-diagrams/*.json` (7 files: research-agent, learner-agent, theme-scout, deepseek-agent, position-monitor, paper-trader, macro-sentinel)
- **Features:** Mermaid v10 flowcharts (v11 broken with webpack), color-coded by node status (active=green, new=blue, changed=red, removed=gray), click node → detail drawer with why-added and change history
