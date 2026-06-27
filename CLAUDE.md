# FinanceOS — Claude Operating Rules

## Project Intelligence Layer

**Active every session. No exceptions.**

Before responding to any substantial instruction, Claude must:

1. **Classify** the user instruction as one of:
   - Product direction | Feature request | UI/UX rule | Architecture rule
   - Technical implementation rule | Bug fix | Random idea | Scope creep
   - Contradiction to prior rule | Approved decision

2. **Check** `PROJECT_RULES.md` — does this conflict with existing rules?

3. **Check** `PROJECT_DECISIONS.md` — does this change an approved decision?

4. **Log** meaningful instructions in `PROJECT_BUILD_LOG.md`.

5. **Warn** the user if the instruction creates drift or scope creep.

6. **Suggest** the correct build-flow step if the user is skipping ahead.

7. **Update** `PROJECT_SCORECARD.md` after major architecture or implementation milestones.

### Required Reading — Every Session Start

Read these files before responding to any substantial project instruction:
- `AGENTS.md` ← **READ FIRST. Multi-agent coordination layer.**
- `WORK_LOG.md` ← what's in progress, what's claimed, what's next
- `PRD.md` ← full product spec, coding conventions, DB schema
- `knowledge/KNOWLEDGE_INDEX.md` ← market knowledge base
- `PROJECT_DECISIONS.md`
- `ARCHITECTURE.md`
- Relevant `features/<feature-name>/FEATURE_ARCHITECTURE.md`

### Do Not Over-Log

Skip logging for: tiny wording changes, obvious bug fixes, test file edits, config tweaks with no product impact.

Only log meaningful project-shaping instructions.

## Architecture-First Mode

**Prime directive: Architecture before code.**

For every feature, screen, API, data model, workflow, integration, or infrastructure change:

1. Understand user intention.
2. Inspect existing code only to understand current architecture.
3. Read `ARCHITECTURE.md` and relevant `features/<name>/FEATURE_ARCHITECTURE.md`.
4. If feature architecture file doesn't exist, create it as draft first.
5. Produce architecture proposal.
6. Wait for explicit approval.
7. After approval, update feature architecture file.
8. Only then write implementation code.

### Approval Gate

Only proceed to implementation when user says one of:
- "Approved" | "Proceed" | "Code it" | "Implement this" | "Yes, build it" | "Apply this architecture" | "Approved, implement"

If user says "next", "show me", "what do you think", "explain", "refine" — stay in architecture mode.

### Bug Fix Exception

Small bug fix with no product/UX/data/API/architecture impact → proceed after short explanation.
If fix affects product behavior, data flow, UI, navigation, state, persistence, security, or API contracts → architecture gate applies.

### Drift Prevention

When implementing approved architecture:
- Do not invent new layouts
- Do not add unapproved features
- Do not change navigation unless approved
- Do not change data contracts unless approved
- Do not simplify in ways that lose product intent
- Do not "improve" beyond approved scope without asking

### Vague Request Handling

If user says "fix this", "improve this", "make it better", "clean this up", "refactor this" → do NOT code immediately. Produce architecture proposal first.
