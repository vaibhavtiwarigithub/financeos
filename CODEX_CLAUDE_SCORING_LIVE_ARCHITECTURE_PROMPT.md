# Claude Code prompt — scoring methodology + safe live autonomy

You are the Architect/Builder for Kairos (FinanceOS). Do not assume this prompt authorizes production code. First perform the architecture-verification deliverable below and stop. Implementation begins only after Vaibhav explicitly says **Approved**, **Proceed**, or **Code it**.

## Required read order

Read completely, in this exact order:

1. `AGENTS.md`
2. `WORK_LOG.md`
3. `PRD.md`
4. `knowledge/KNOWLEDGE_INDEX.md`
5. `knowledge/CONNECTIONS.md`
6. `features/scoring-methodology/FEATURE_ARCHITECTURE.md`
7. `features/live-auto-trading/FEATURE_ARCHITECTURE.md`
8. `docs/arch/03-agents.md`
9. `docs/arch/08-risk-and-safety.md`
10. `CODEX_SCORING_METHODOLOGY_REVIEW_RESULT.md`
11. `features/performance-truth/FEATURE_ARCHITECTURE.md`
12. `features/edge-factor-discovery/FEATURE_ARCHITECTURE.md`

Then inspect the actual code and migrations referenced by those docs, including at minimum:

- `lib/research-agent.ts`
- `lib/deepseek-agent.ts`
- `lib/scoring/weighted-score.ts`
- `lib/data/scores.ts`
- `lib/data/technicals.ts`
- `lib/validation/calibration.ts`
- `lib/validation/engine.ts`
- `lib/learning/dataset.ts`
- `app/api/agents/paper-trade/route.ts`
- `app/api/agents/trader/route.ts`
- `app/api/broker/orders/route.ts`
- `lib/autonomy.ts`
- `lib/robinhood-mcp.ts`
- `lib/brokers/adapters/robinhood-mcp.ts`
- `lib/kill-switches.ts`
- `lib/risk/live-portfolio-gate.ts`
- migrations `094`, `095`, `103`–`108`, `116`, `121`, `122`, `124`, `132`–`135`

## Stage 1 — verify architecture, no implementation

Create these two files:

- `features/scoring-methodology/IMPLEMENTATION_PLAN.md`
- `features/live-auto-trading/IMPLEMENTATION_PLAN.md`

For each plan:

1. Map every architecture phase to exact existing files/functions and the next actual migration number.
2. Separate **current behavior**, **target behavior**, and **blocked/future behavior**.
3. List schema columns/constraints/RPCs that already exist so nothing is duplicated.
4. List every architecture-to-code mismatch with severity and exact fix.
5. Give a dependency-ordered, PR-sized build sequence with tests and rollback.
6. State which phases change paper decisions, live eligibility, or money movement.
7. Verify all RLS/grants/`SECURITY DEFINER`/`search_path` requirements.
8. Do not modify production code, migrations, config, or existing architecture docs in Stage 1.

Stop after writing the two plans and summarize the blockers for Vaibhav.

## Non-negotiable corrections

- Robinhood order account is exactly `605420660`. `605420606` is wrong. `965848641` is read-only research holdings only.
- Do not call `submitRobinhoodOrder()` directly from TraderAgent or an auto cron. Extract/reuse one server-only Execution Gateway kernel.
- Preserve the deployment kill flag. Future auto requires both environment release enablement and an expiring owner DB lease.
- All live submits, manual or auto, must use an atomic daily-budget reservation. A TypeScript read/sum/check is forbidden.
- The current reservation RPC hardcodes `approved_by_user=true`; autonomous execution needs a versioned RPC with the true actor and locked-down permissions.
- No fallback NAV, stale portfolio, guessed MCP schema, or LLM-supplied market/order data on a money path.
- Auto BUY is blocked until live protective exits, partial-fill sync, and reconciliation work.
- DeepSeek numeric scores are advisory only and must be structurally excluded from paper/live consumption.
- Tag the current deterministic scorer `deterministic_v1`; do not mislabel it v2.
- Evidence confidence denominator is structural applicable base weight. Missing/stale/failed/degraded stays in the denominator and contributes zero. `inapplicable` is omitted. Never use post-renormalization `applied_weights`.
- `decision_observations.features` is the canonical feature snapshot. Do not create a second full features blob on `agent_signals`.
- LLM may explain or bounded-veto; it may not score, set direction, fit weights, size, promote lifecycle, change money limits/config/code, or place/cancel orders.
- Learner proposes challengers; deterministic statistics/optimizers fit them; Vaibhav promotes them.
- New positions are long-only. A held-position exit is `exit_candidate`/SELL, not a new short.
- P3 calibration must eliminate the current full-dataset-fit leakage and produce true out-of-fold predictions with purging/embargo.
- Yahoo/TradingView scraping cannot be a live-auto dependency.
- All schema changes are additive, migrated before code, RLS/grants verified, and append-only ledgers remain immutable.

## When Vaibhav later approves implementation

Claim the exact phase in `WORK_LOG.md` before editing. Build in this order only:

1. **Scoring P0** — provenance/source/version safety and deterministic v1 direction; no formula change.
2. **Scoring P1** — measure-only PIT universe/feature snapshots; no trading change.
3. **Scoring P2** — shadow scorers only; v1 remains actionable.
4. **Live PA0** — schema/UI/audit only; deployment auto flag stays false.
5. **Live PA1** — shared execution kernel + shadow autonomous decisions; no broker submit.

Stop for evidence and a new approval before Scoring P3/P4/P5 or Live PA2/PA3/PA4. Never bundle real autonomous enablement into a scoring PR.

## Verification required for every approved phase

- `npm run build` and the repository’s typecheck/test commands;
- deterministic unit tests and DB constraint/RPC tests;
- migration apply/rebuild verification and Supabase advisors;
- before/after counts on financial ledgers for measure-only phases;
- grep/static proof that prohibited call paths do not exist;
- explicit failure tests for null/stale/provider errors, concurrency, duplicate cron, and ambiguous broker outcomes;
- update `WORK_LOG.md` with exact deviations and evidence.

If an architecture requirement conflicts with actual schema/code, do not improvise. Record the conflict in the relevant implementation plan and ask Vaibhav for the narrow decision.
