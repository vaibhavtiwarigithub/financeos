# Kairos Architecture Portal

> Last reviewed: 2026-08-02 (current through `6d14af12`)
> Purpose: the stable entry point to Kairos architecture. It explains where truth
> lives; it does not duplicate the implementation detail held by the documents it links.

## What Kairos is

Kairos is a personal US and India investing research system. It keeps USD and INR
books separate, researches instruments, executes an autonomous paper loop, observes
outcomes, and permits only explicitly governed live actions. LLMs may summarize or
propose; deterministic services own eligibility, pricing, risk controls, accounting,
and broker execution.

## Non-negotiable system properties

1. The US and India markets are separate pools. Values, returns, risk, and decisions
   are never cross-summed across currencies.
2. An LLM is never a money-path authority. It cannot create an executable order,
   override a safety gate, or promote a strategy.
3. A missing, stale, ambiguous, or degraded required input fails closed for the
   decision it protects. Exits retain their independent safety path.
4. Paper behavior is evidence, not proof. Research, shadow, replay, validation, and
   promotion are distinct lifecycle states.
5. Broker credentials, account identifiers, and raw provider responses do not belong
   in client bundles or reference documentation.
6. Daily technical scoring consumes completed regular-market sessions only, and
   scheduled agent slots are expressed in exchange-local time rather than assumed UTC.

## Documentation hierarchy

| Source | Owns | Do not use it for |
|---|---|---|
| `ARCHITECTURE.md` | This portal, source-of-truth rules, cross-cutting principles | Detailed schedules, schemas, or current provider behavior |
| `SYSTEM_OVERVIEW.md` | Short onboarding explanation and high-level lifecycle | Operational implementation detail |
| `docs/arch/` | Definitive chapter-by-chapter operational architecture | Feature alternatives and implementation history |
| `features/<feature>/FEATURE_ARCHITECTURE.md` | Feature micro-architecture: scope, contracts, states, alternatives, rollout, and non-goals | A replacement for shared architecture chapters |
| `features/<feature>/IMPLEMENTATION_RESULT.md` | What was actually delivered and any approved deviations | Future design authority |
| `PROJECT_DECISIONS.md` | Approved decisions, rationale, alternatives, and reversal cost | Unapproved proposals |
| `public/agent-diagrams/system-map.json` | Rendered live agent-to-agent topology and its history | Narrative safety sequences or data-model detail |

Start with [the chapter index](docs/arch/00-index.md). Read a feature document before
changing a scoped feature. Read the decision record before reopening an approved
choice.

## Architecture views

- **System orientation:** [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md)
- **Agent responsibilities:** [docs/arch/03-agents.md](docs/arch/03-agents.md)
- **Schema and data contracts:** [docs/arch/04-database-schema.md](docs/arch/04-database-schema.md)
- **Schedules:** [docs/arch/05-crons-and-scheduling.md](docs/arch/05-crons-and-scheduling.md)
- **Safety and money path:** [docs/arch/08-risk-and-safety.md](docs/arch/08-risk-and-safety.md)
- **Learning and promotion:** [docs/arch/09-learning-loop.md](docs/arch/09-learning-loop.md)
- **Live topology:** Dashboard -> Agents -> the "Agent & Flow Architecture" section.

The topology is rendered from the JSON source above. Do not paste a second copy of
its edges into a chapter. A chapter diagram is appropriate only when it explains a
different altitude, such as a gate sequence, an event timeline, or a subsystem flow.

## Change protocol

Every meaningful change follows this sequence:

1. Record the decision or create/update the feature architecture before implementation.
2. Implement only the approved scope, with tests proportional to risk.
3. Update every affected architecture chapter in the same change.
4. Update the live agent diagram when an agent's inputs, outputs, dependencies, or
   safety boundary changes. Update its history entry with the reason.
5. Add an implementation result when a feature architecture is shipped; record an
   approved deviation rather than silently editing history.
6. Verify the rendered diagram and architecture drift tests before shipping.

The top-level overview and index are not rewritten for every implementation detail.
They are updated when the reading path, system orientation, or documentation ownership
changes. The owning chapter and feature implementation result are mandatory whenever a
change affects their contract. A completed `WORK_LOG.md` entry is not evidence that a
feature shipped until those required records and production migration state agree.

For a scoring-dimension change, "update the architecture" specifically means all
of the following must agree with production code in the same commit:

- plain-English meaning: what question the dimension is trying to answer;
- source order, market applicability, freshness, and fallback behavior;
- exact formula, constants, thresholds, clamps, and any veto/cap;
- missing-data behavior and whether the dimension is excluded or merely displayed;
- whether the value can affect eligibility, sizing, exits, learning, or only explanation.

The definitive home for those facts is `docs/arch/03-agents.md` under
ResearchAgent. Provider mechanics belong in chapter 02, persisted fields in chapter
04, and money-path consequences in chapter 08. A feature document may explain why
a change was proposed, but it must not become the only place where the active
formula is documented.

Changes to a money path additionally require the applicable risk chapter, schema
chapter (when persistence changes), migration verification, and an explicit
fail-closed review. A feature is not complete merely because code compiles.

## In-app reference surface

Dashboard -> Agents -> **System Reference** exposes a curated owner-only allowlist of
these records for reading or download. It is deliberately not a general repository
browser and does not add a main-navigation "Docs" destination. The agent page remains
the appropriate contextual home because it already owns the live topology.
