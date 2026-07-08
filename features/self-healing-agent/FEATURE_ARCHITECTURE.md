# Live-Order Caps + Self-Healing / Health-Monitoring Agent

**Status:** DRAFT — awaiting approval. No implementation code until approved.
**Author:** Claude (Opus 4.8), 2026-07-08.
**Companion to:** `features/learning-integrity/FEATURE_ARCHITECTURE.md` (the health
agent surfaces `v_decision_quality` taint rates; the notional caps are an execution
guardrail the agent monitors).
**Decision inputs (user, 2026-07-08):**
- Per-order live $ cap must be controllable from the app, per market (US/India).
- Self-healing agent: LLM model selectable from Settings (like other agents); its
  health shown on the dashboard alongside the existing agent-LLM list.
- Hard boundary (Claude pushback, accepted): an LLM may **diagnose and suggest**, and
  may **auto-apply only deterministic whitelisted actions**. It must **never**
  autonomously change weights, config money-limits, code, or place/cancel orders.

---

# PART A — Live per-order notional caps (per market)

## A1. Current state (verified 2026-07-08)
- `strategy_config.max_order_notional = 50` (single numeric, no currency).
- Enforced only in the US Execution Gateway `app/api/broker/orders/route.ts`
  (`qty * fresh_price > cap` → 403; fail-closed if no cap AND no equity snapshot;
  default fallback = 15% of live equity when the column is null).
- **Gaps:**
  1. No Settings UI to set it — DB-column only.
  2. The Kite route `app/api/kite/order/route.ts` enforces owner-gate + rate-limit +
     long-only + `confirm:true`, but has **no notional cap**. India live orders are
     not $-capped.
  3. Single value is USD-shaped. ₹50 would block every India order; $50 is fine for US.
     One column can't serve both currencies.

## A2. Design
- **Schema (additive):** add `max_order_notional_usd numeric`, `max_order_notional_inr numeric`
  to `strategy_config`. Backfill `usd` from the existing `50`; set `inr` to an approved
  default (proposal: ₹4000 ≈ $48, US-parity). Keep `max_order_notional` as a
  deprecated read-through (usd) for one release, then drop.
- **Enforcement:**
  - US Gateway reads `max_order_notional_usd`.
  - Kite route adds the **same** fresh-quote notional check against `max_order_notional_inr`,
    same fail-closed semantics (no cap resolvable → refuse).
  - Preserve the existing 15%-of-equity fallback per market when the column is null.
- **Settings UI:** owner-gated "Live Order Limits" section with a USD field and an INR
  field, writing `strategy_config` via an owner-gated route (extend the existing
  risk-profile/settings route; never cron-callable).
- **Value shown on the trade-approval screen** so the human sees the ceiling before
  clicking submit.

## A3. Acceptance criteria
- A live US order > USD cap → 403; a live India order > INR cap → 403.
- Neither path can place an uncapped live order (fail-closed retained on both).
- Cap editable in-app by owner only; change is audit-logged.
- No cron path can place or uncap an order.

---

# PART B — Self-healing / health-monitoring agent

## B1. Principle: three tiers, one hard boundary

| Tier | Actor | Allowed | Risk |
|---|---|---|---|
| 1. Deterministic auto-remediation | Rule-based code (no LLM) | Bounded whitelist actions (below) | Low — reversible, no judgment |
| 2. LLM triage | LLM (model from Settings), **read-only** | Diagnose, rank, suggest a fix, mark whether a Tier-1 action can handle it | Low — writes advice only |
| 3. Apply | Human click, or Tier-1 auto for whitelisted actions only | Execute a suggested fix | Gated |

**Hard boundary (non-negotiable):** the LLM never autonomously mutates weights,
`strategy_config` money-limits, code, or places/cancels orders. Those remain human-gated
regardless of LLM confidence. The LLM's output is advice + a whitelisted-action tag.

## B2. Tier 1 — deterministic auto-remediation (rules)
Whitelisted, bounded, already partly present (kill switches, needs-reconcile, AV→FRED
fallback). Candidate actions, each individually feature-flagged:
- Re-run research for the N symbols that failed a cron batch.
- Post-enablement: auto-exclude a trade whose linked `v_decision_quality` is tainted
  (sets `excluded_from_learning`, never deletes).
- Auto-flip a data provider to its fallback when the primary is rate-limited.
- Auto-resolve a stale `agent_alerts` row when its condition has cleared.
Each action: idempotent, logged to `agent_alerts`/`decision_journal`, and reversible.
None touch orders, weights, money-limits, or code.

## B3. Tier 2 — health-triage LLM agent (read-only)
- **New agent** `health-triage`. Runs on schedule (and/or on a new CRITICAL alert).
- **Model selectable from Settings:** add a row to `agent_config`
  (`agent_name='health-triage'`, default `deepseek-v4-flash` — cheap advisory).
  It then appears in the existing Settings → LLM Config selector automatically,
  same pattern as `macro-read`/`mentor`. `getConfiguredModel('health-triage')` with a
  safe fallback.
- **Inputs (read-only):** open `agent_alerts`, recent `agent_runs` errors,
  `v_decision_quality` daily taint/unknown rate, provider budgets (`provider_budget_7d`),
  broker-token expiry.
- **Output:** one triage record per open issue — `root_cause`, `blast_radius`,
  `suggested_fix` (plain English), `auto_remediable` (bool → maps to a Tier-1 action id
  or null), `severity`, `model_used`, tokens. Written to a new table
  `health_triage` keyed to `agent_alerts.issue_key`.
- **Never** writes to money/code/order/weight paths.

## B4. Tier 3 — apply
- Dashboard renders each suggestion in the System Health card:
  "🔧 Suggested fix: … [Apply]" — the Apply button is enabled **only** when
  `auto_remediable` maps to a whitelisted Tier-1 action; otherwise it's advice-only text.
- Owner click triggers the deterministic action (owner-gated route). Every apply is
  audit-logged with the triggering triage id.

## B5. Dashboard health of the agent itself (user requirement)
- `health-triage` logs to `agent_runs` (`agent_type='health_triage'`) → last-run,
  errors, tokens show in the existing agents list exactly like the other agents.
- The model-freshness checker covers `health-triage` too (deprecated-model → CRITICAL).
- The agent's model + enabled toggle appear in Settings → LLM Config with the rest.
- So it's a first-class citizen: same health surface, same model-config surface as
  every other agent LLM already on the dashboard.

## B6. Schema
- New table `health_triage(id, ts, issue_key text, root_cause text, blast_radius text,
  suggested_fix text, auto_remediable boolean, remediation_action text, severity text,
  applied boolean default false, applied_at, applied_by, model_used text,
  tokens_input int, tokens_output int)`. Links to `agent_alerts` via `issue_key`.
- `agent_config`: one new row `health-triage`.
- No changes to money/order tables from this feature.

## B7. Acceptance criteria
- Changing the `health-triage` model in Settings changes the model used on the next run.
- The agent's health (last run, errors) shows in the dashboard agents list.
- Triage suggestions render on the health card; Apply is live only for whitelisted
  deterministic actions.
- No code path lets this agent place/cancel an order, change a money-limit, mutate
  weights, or edit code. (Test: attempt each → blocked.)
- If the LLM is unreachable, Tier-1 remediation and the health card still function
  (LLM is additive, not load-bearing).

## B8. Rollout
1. **A first (small, high-value guardrail):** per-market notional caps + Settings UI +
   Kite enforcement. Independent of the agent.
2. **B-Tier 1:** deterministic remediation whitelist (feature-flagged, off by default).
3. **B-Tier 2:** `health-triage` agent + `agent_config` row + `health_triage` table +
   dashboard surfacing (read-only advice).
4. **B-Tier 3:** one-click apply for whitelisted actions only.

## B9. Open questions
- Triage cadence: every N hours vs only on new CRITICAL? (proposal: on new CRITICAL +
  a 6h heartbeat.)
- Which Tier-1 actions ship in the first whitelist.
- Default INR cap value (proposal ₹4000).
- Does `health-triage` also summarize into the daily briefing email?

## B10. Diagram / system-map impact
Adds a `health-triage` node reading `agent_alerts`/`agent_runs`/`v_decision_quality` and
writing `health_triage`. On build, update `public/agent-diagrams/system-map.json` +
add the per-agent diagram, and append a history entry per project convention.
