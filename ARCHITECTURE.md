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

### Our scheduler vs FinRobot's Smart Scheduler
FinRobot's scheduler is event-driven (earnings, news). Ours is simpler but production-hardened:
- 7PM EST daily: earnings calendar refresh (Massive API, no LLM)
- Market open: ResearchAgent screener run (3 candidates/day max)
- Per-signal: LearnerAgent records outcome after trade closes
- Weekly batch: weight mutation after ≥10 closed trades
