# Kairos Architecture Chapter Index

> Last reviewed: 2026-08-02 (current through `6d14af12`)

This directory is the definitive chapter-by-chapter operational architecture. Each
chapter is independently updateable: a broker change does not require editing the
agent chapter. Use [ARCHITECTURE.md](../../ARCHITECTURE.md) for the documentation
hierarchy and [SYSTEM_OVERVIEW.md](../../SYSTEM_OVERVIEW.md) for a short orientation.

## Chapters

| File | What it covers | Update when |
|---|---|---|
| `01-what-is-kairos.md` | Core idea, principles, feature map, onboarding diagrams | Product direction or feature areas change |
| `02-tech-stack.md` | Runtime stack, providers, adapters, and integrations | A library, provider, adapter, or framework changes |
| `03-agents.md` | Agent responsibilities, inputs, outputs, and behavior | An agent changes or is added/removed |
| `04-database-schema.md` | Tables, persistence contracts, indexes, and triggers | Any schema migration changes a data contract |
| `05-crons-and-scheduling.md` | Vercel and local schedules, operational timing | A cron is added, removed, or rescheduled |
| `06-env-variables.md` | Required, optional, and runtime-editable variables | An environment variable changes ownership |
| `07-coding-conventions.md` | UI, data access, API, and agent conventions | A project-wide convention changes |
| `08-risk-and-safety.md` | Money-path gates, autonomy, kill switches, ledgers | Order flow, autonomy, or safety behavior changes |
| `09-learning-loop.md` | Evaluation, learning, validation, and promotion controls | Learning flow, genome, or promotion controls change |

## Source-of-truth hierarchy

| Source | Owns |
|---|---|
| `ARCHITECTURE.md` | Architecture portal, principles, documentation ownership, and read paths |
| `SYSTEM_OVERVIEW.md` | Concise product and system orientation |
| `docs/arch/` | Detailed operational architecture |
| `features/<feature>/FEATURE_ARCHITECTURE.md` | Feature micro-architecture: contracts, states, alternatives, rollout, and non-goals |
| `features/<feature>/IMPLEMENTATION_RESULT.md` | What actually shipped and approved deviations |
| `PROJECT_DECISIONS.md` | Approved decisions, rationale, and reversal cost |
| `public/agent-diagrams/system-map.json` | Rendered agent-to-agent topology and topology history |

When these sources disagree, reconcile the conflict in the same change. A feature
document cannot silently override a shared chapter or approved decision.

The overview and this index change only when the reading path or ownership changes.
The affected chapter and feature implementation result change with the implementation
that changes their underlying contract.

## Update rules

| Change | Update |
|---|---|
| New or changed agent | `03-agents.md`; topology JSON/history; `05-crons-and-scheduling.md` when scheduled |
| Scoring dimension, formula, source, weight, applicability, missing-data rule, veto, or cap | `03-agents.md` plain-English explanation + exact formula contract; `02-tech-stack.md`, `04-database-schema.md`, and `08-risk-and-safety.md` when their ownership changes |
| New table, column, index, trigger, or RPC | `04-database-schema.md` |
| New provider, broker, or runtime integration | `02-tech-stack.md` |
| New or changed schedule | `05-crons-and-scheduling.md` |
| New environment variable or vault ownership | `06-env-variables.md` |
| Money-path, autonomy, or safety-gate change | `08-risk-and-safety.md` and relevant feature design |
| Learning, validation, strategy, or promotion change | `09-learning-loop.md` and relevant feature design |
| Product scope/principle change | `01-what-is-kairos.md` and `SYSTEM_OVERVIEW.md` |
| Feature implementation | Its feature design and an implementation result; affected shared chapters |

## Diagram ownership

Agent-to-agent topology lives only in `public/agent-diagrams/system-map.json`, rendered
on Dashboard -> Agents -> Agent & Flow Architecture. Do not paste the same edges into
chapters. A chapter diagram is appropriate only when it documents a different view,
such as a gate sequence, timeline, or contained subsystem. The drift test in
`tests/arch-diagram-drift.test.ts` validates the map files and declared overlaps.

## In-app access

Dashboard -> Agents -> System Reference exposes a small owner-only allowlist for
reading or downloading architecture records. It is not a repository browser and does
not replace this documentation structure.
