# Kairos â€” Claude Operating Rules

## GitHub Account Routing — Parallel-Safe

- FinanceOS/Kairos pushes only to
  `https://github.com/vaibhavtiwarigithub/financeos.git` using the
  `vaibhavtiwarigithub` credential. FinNudge belongs to `sharveeshrotriya` and is
  read-only from this workspace.
- Do **not** run `gh auth switch` to repair a FinanceOS Git push. GitHub CLI's
  active account is global and switching it races with concurrent FinNudge work.
- This machine uses conditional Git config plus Git Credential Manager to select
  the account by repository directory. Use normal `git fetch`, `git pull`, and
  `git push origin <branch>`; do not change the remote or embed credentials in it.
- Before a side effect, verify `git remote -v` and
  `git config credential.https://github.com.username`. FinanceOS must resolve to
  `vaibhavtiwarigithub`. Never print `git credential fill` output because it
  contains a token.
- `gh` API commands (for example `gh pr create`) still use the globally active
  CLI account. They are not parallel-safe across these two owners; avoid them in
  concurrent work unless a process-scoped credential is explicitly provided.

## Parallelize splittable work across agents

If a task decomposes into independent sub-tasks touching non-overlapping files,
run them in parallel via subagents (Agent tool, one message with multiple calls,
or a Workflow) instead of serially. Use git-worktree isolation when the parallel
agents mutate files so branches don't collide, then octopus-merge the disjoint
results. Serial is the exception — only when sub-tasks share files or one's output
feeds another's input. Default to parallel whenever the work splits cleanly.

## Agent System Map — keep it current

`public/agent-diagrams/system-map.json` is the single diagram of how every
agent/flow connects to the others (rendered on `/dashboard/agents` → "System
Map", the default diagram view). It is NOT auto-generated. Whenever an
agent-to-agent data flow, handoff, table dependency, schedule, or the
learning loop changes — anything that alters how the agents collaborate —
update `system-map.json` in the same change: fix the mermaid `diagram`, the
`nodes` descriptions, and append a `history` entry (date/event/nodeId/reason).
The per-agent diagrams (`public/agent-diagrams/<agent>.json`) follow the same
rule for changes scoped to a single agent. A flow change that ships without a
diagram update is incomplete.

## Architecture chapters — keep them current

`docs/arch/` contains the definitive architecture documentation, split into narrow
chapters so only the relevant chapter is touched on each change. Each chapter file
starts with a "Last updated" date and an "Update this file when" line.

`docs/arch/00-index.md` is the master index; it maps each chapter to the code changes
that require updating it. Whenever a change ships, update ONLY the relevant chapter(s)
— do NOT touch chapters whose subsystem was unchanged.

| Chapter | Update when |
|---|---|
| `01-what-is-kairos.md` | Product direction, feature map, core loop changes |
| `02-tech-stack.md` | New provider added (embeddings/rerank/email/broker/LLM), stack change |
| `03-agents.md` | Agent added/removed/rescheduled, input/output shape changed |
| `04-database-schema.md` | Migration applied: new table/column/index/RLS |
| `05-crons-and-scheduling.md` | Cron added/removed/rescheduled |
| `06-env-variables.md` | New env var added, vault key added |
| `07-coding-conventions.md` | Styling convention, auth pattern, or API contract changes |
| `08-risk-and-safety.md` | Safety gate added/changed, autonomy level, account allowlist |
| `09-learning-loop.md` | LearnerAgent, champion/challenger, genome, Performance Truth |

`SYSTEM_OVERVIEW.md` is kept as a high-level intro that redirects to `docs/arch/`.
A change that ships without updating the relevant `docs/arch/` chapter is incomplete.
(Human-readable companion to the `system-map.json` diagram rule above.)

## Project Intelligence Layer

**Active every session. No exceptions.**

Before responding to any substantial instruction, Claude must:

1. **Classify** the user instruction as one of:
   - Product direction | Feature request | UI/UX rule | Architecture rule
   - Technical implementation rule | Bug fix | Random idea | Scope creep
   - Contradiction to prior rule | Approved decision

2. **Check** `PROJECT_RULES.md` â€” does this conflict with existing rules?

3. **Check** `PROJECT_DECISIONS.md` â€” does this change an approved decision?

4. **Log** meaningful instructions in `PROJECT_BUILD_LOG.md`.

5. **Warn** the user if the instruction creates drift or scope creep.

6. **Suggest** the correct build-flow step if the user is skipping ahead.

7. **Update** `PROJECT_SCORECARD.md` after major architecture or implementation milestones.

### Required Reading â€” Every Session Start

Read these files before responding to any substantial project instruction:
- `AGENTS.md` â† **READ FIRST. Multi-agent coordination layer.**
- `WORK_LOG.md` â† what's in progress, what's claimed, what's next
- `docs/arch/00-index.md` — chapter index — which chapter covers what
- `docs/arch/` relevant chapter(s) for the task area
- `knowledge/KNOWLEDGE_INDEX.md` â† market knowledge base
- `PROJECT_DECISIONS.md`
- Relevant `features/<feature-name>/FEATURE_ARCHITECTURE.md`

### Do Not Over-Log

Skip logging for: tiny wording changes, obvious bug fixes, test file edits, config tweaks with no product impact.

Only log meaningful project-shaping instructions.

## Scoring Data-Truth Review Protocol

Any review of a score, eligibility gate, risk posture, or learning feature is
incomplete until it tests the real provider-to-decision contract in production.
Static code review and fixture-only tests are necessary but insufficient.

Required, per market and per provider:

1. Query production distributions: n, nulls, availability, min/p10/median/p90/max,
   exact floor/ceiling rates, and threshold-near counts.
2. Enumerate every default/fallback and report its production hit fraction. A silent
   money-path default requires explicit evidence provenance or removal.
3. Compare provider taxonomy, units, and enums with the scorer's expected key space.
   Report mapping coverage and unknown keys.
4. Read availability from the authoritative mask/evidence state, never from a non-null
   placeholder score.
5. Join guardrail cohorts to matured outcomes before calling a condition protective.
6. Produce a frozen, read-only counterfactual showing expected threshold flips before
   changing a live formula. Do not rewrite historical decisions.
7. Prove US and India separately. Cross-market aggregates cannot validate a money-path rule.
8. Search for duplicate scorers, schedulers, Edge Functions, and legacy endpoints.

A scoring review may not be marked complete without SQL/query evidence, or an explicit
blocker stating why production evidence could not be obtained.

## Architecture-First Mode

**Prime directive: Architecture before code.**

For every feature, screen, API, data model, workflow, integration, or infrastructure change:

1. Understand user intention.
2. Inspect existing code only to understand current architecture.
3. Read relevant `docs/arch/` chapter and `features/<name>/FEATURE_ARCHITECTURE.md`.
4. If feature architecture file doesn't exist, create it as draft first.
5. Produce architecture proposal.
6. Wait for explicit approval.
7. After approval, update feature architecture file.
8. Only then write implementation code.

### Approval Gate

Only proceed to implementation when user says one of:
- "Approved" | "Proceed" | "Code it" | "Implement this" | "Yes, build it" | "Apply this architecture" | "Approved, implement"

If user says "next", "show me", "what do you think", "explain", "refine" â€” stay in architecture mode.

### Bug Fix Exception

Small bug fix with no product/UX/data/API/architecture impact â†’ proceed after short explanation.
If fix affects product behavior, data flow, UI, navigation, state, persistence, security, or API contracts â†’ architecture gate applies.

### Drift Prevention

When implementing approved architecture:
- Do not invent new layouts
- Do not add unapproved features
- Do not change navigation unless approved
- Do not change data contracts unless approved
- Do not simplify in ways that lose product intent
- Do not "improve" beyond approved scope without asking

### Vague Request Handling

If user says "fix this", "improve this", "make it better", "clean this up", "refactor this" â†’ do NOT code immediately. Produce architecture proposal first.

---

## Agent System Design Rules (locked decisions â€” push back if contradicted)

### ResearchAgent scope
1. **Always research existing Robinhood holdings first.** Pull positions via `get_equity_positions` on account `965848641` (Trading account â€” approved read-only per Option B, 2026-06-28; see CONNECTIONS.md). These are highest priority â€” agent must be able to say SELL on owned positions. `605420660` is the ONLY account permitted for order placement.
2. **Holdings vs screener candidates are different.** Holdings â†’ SELL signals allowed. Screener candidates â†’ LONG only (long-only enforcement applies to NEW positions, not exits).
3. **Screener target: 3 candidates/day** (not 5). With $10k NAV and 10% sizing, max 10 positions total. Daily churn of 5 new candidates = overtrading.

### Screener design (approved architecture)
- **Do NOT use Robinhood `run_scan` as primary.** Too shallow. Use FinancialDatasets `screen_stocks` for fundamentals + Alpha Vantage technicals.
- **Dual-bucket always running (no explicit regime detection):**
  - Momentum bucket: RSI > 60, price > 50-day MA, revenue acceleration, positive earnings revision
  - Value bucket: P/E < sector median, high FCF yield, insider buying, recent analyst upgrades
- Let ResearchAgent score both buckets. Top 3 by analyst_score win. Regime adaptation emerges from scoring, not hardcoded logic.
- **Push back if user asks for explicit "bull/bear mode" switching.** The scoring naturally adapts â€” explicit regime detection is fragile and adds moving parts.

### Learning
- LearnerAgent runs **weekly batch** (not per-trade). Per-trade notes: write 1-sentence outcome summary per closed trade to `learning_log`.
- Weight mutation locked in Phase 0. Requires 10+ closed trades before Phase 1 unlocks.

### Push-back mandate
Claude MUST push back on:
- Adding more than 3 screener candidates/day
- Explicit market regime detection logic
- Removing SELL signal capability for existing holdings
- Running real TraderAgent orders without approval_required mode
- Any feature that adds agent complexity before the weekly learning loop has run at least once

