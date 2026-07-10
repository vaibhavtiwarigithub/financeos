# Kairos Architecture — Chapter Index
> Last updated: 2026-07-10

This directory contains the definitive architecture documentation split into narrow chapters.
Each chapter is independently updateable — a change to brokers doesn't touch the agents chapter.
SYSTEM_OVERVIEW.md remains the single canonical document; these chapters are narrow cuts of it
for faster orientation and targeted updates.

## Chapters

| File | What it covers | Update when |
|---|---|---|
| `01-what-is-kairos.md` | Core idea, three principles, feature map, big-picture diagram, comparison vs ordinary scanner | Product direction changes, new feature areas added, principle changes |
| `02-tech-stack.md` | Frontend/backend/AI/broker/data provider tables; provider adapter layer (embeddings, rerank, email, brokers, LLM router) | New library, new provider, new adapter, framework upgrade |
| `03-agents.md` | Every agent: endpoint, schedule, inputs, outputs, key behavior | New agent added, existing agent schedule/behavior changes, agent removed |
| `04-database-schema.md` | All tables grouped by subsystem; column types and notes | Any schema migration: new table, new column, dropped column, new index, new trigger |
| `05-crons-and-scheduling.md` | Vercel crons + Windows Task Scheduler table; how to add a cron | New cron, schedule change, cron removed, new endpoint wired to cron |
| `06-env-variables.md` | Required, optional, and runtime-editable vault variables | New env var added, var removed, var moved to/from vault |
| `07-coding-conventions.md` | T token styling, DB access patterns, API route conventions, agent conventions, auth gates | Conventions change (rare); new pattern adopted project-wide |
| `08-risk-and-safety.md` | 9 safety gates, autonomy ladder, kill switches, circuit breaker, account allowlist, append-only ledgers | Any change to order flow, autonomy levels, money gates, or broker account roles |
| `09-learning-loop.md` | LearnerAgent detail, champion/challenger system, genome, weight mutation gates, Performance Truth Layer, Validation Engine, RAG pipeline | Learning flow changes, new guardrails, genome parameter changes, Phase 1 unlock |

## Update rules

When a change lands, update ONLY the relevant chapter(s). Do not touch other chapters.

| Type of change | Chapters to update |
|---|---|
| New agent | `03-agents.md` + `05-crons-and-scheduling.md` (if cron) + `04-database-schema.md` (if new tables) |
| New table or column | `04-database-schema.md` |
| New env var | `06-env-variables.md` |
| New broker or data provider | `02-tech-stack.md` |
| New cron | `05-crons-and-scheduling.md` |
| New safety gate or autonomy change | `08-risk-and-safety.md` |
| LearnerAgent / mutation / genome change | `09-learning-loop.md` |
| Product direction or feature area change | `01-what-is-kairos.md` |
| Coding convention change | `07-coding-conventions.md` |

## What lives elsewhere

- `SYSTEM_OVERVIEW.md` — canonical single-file view of the whole app (keep current per CLAUDE.md)
- `AGENTS.md` — multi-agent coordination layer (read first every session)
- `ARCHITECTURE.md` — deeper implementation detail
- `features/*/FEATURE_ARCHITECTURE.md` — per-feature architecture files
- `PRD.md` — full product spec, coding conventions, DB schema
- `public/agent-diagrams/system-map.json` — live agent diagram rendered at `/dashboard/agents`
