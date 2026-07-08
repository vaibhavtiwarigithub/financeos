# Live-Order Caps + Self-Healing / Health-Monitoring Agent

**Status:** DRAFT — awaiting approval. No implementation code until approved.
**Author:** Claude (Opus 4.8), reviewed/updated by ChatGPT, 2026-07-08.
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

**Reviewer corrections to A2 (binding):**
- Keep `max_order_notional` as a deprecated USD read-through for at least one release;
  do **not** drop it in this feature. Dropping is a separate approved cleanup after all
  deployed code reads `max_order_notional_usd`.
- `max_order_notional_usd` / `max_order_notional_inr` readers must ship only after the
  additive migration is applied. A live-money route must never treat a missing cap
  column as uncapped.
- The current US 15%-of-equity fallback may remain only when a fresh live equity
  snapshot exists. Kite/India must fail closed if `max_order_notional_inr` is null
  because no trusted Kite equity fallback is defined here.
- Settings writes are owner-human actions only; the health agent/LLM cannot change
  `strategy_config` money limits.

## A3. Acceptance criteria
- A live US order > USD cap → 403; a live India order > INR cap → 403.
- Neither path can place an uncapped live order (fail-closed retained on both).
- Cap editable in-app by owner only; change is audit-logged.
- No cron path can place or uncap an order.
- New positions remain long-only; SELL remains allowed only for held positions. This
  feature must not weaken either order-side guard.

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
The deterministic apply route must also reject any action id that would touch orders,
code, strategy weights, model selection, broker credentials, secrets, or money limits.

## B2. Tier 1 — deterministic auto-remediation (rules)
Whitelisted, bounded, already partly present (kill switches, needs-reconcile, AV→FRED
fallback). Candidate actions, each individually feature-flagged:
- Re-run research for the N symbols that failed a cron batch.
- Post-enablement: auto-exclude a trade whose linked `v_decision_quality` is tainted
  (sets `excluded_from_learning`, never deletes).
- Trigger a one-shot retry using an already-coded fallback path when the primary
  provider is rate-limited. Do not persistently change provider config, API keys,
  provider priority, or budgets.
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
- The LLM prompt/tool contract is read-only. It may receive issue context and emit
  JSON advice, but it must not receive tools or route access that can write
  `strategy_config`, `strategy_versions`, `agent_config`, broker/order tables, code,
  or secrets.

## B4. Tier 3 — apply
- Dashboard renders each suggestion in the System Health card:
  "🔧 Suggested fix: … [Apply]" — the Apply button is enabled **only** when
  `auto_remediable` maps to a whitelisted Tier-1 action; otherwise it's advice-only text.
- Owner click triggers the deterministic action through an owner-gated, CSRF/Origin
  protected route. It must not accept cron secrets. Every apply is audit-logged with
  the triggering triage id.
- Auto-apply without a click is allowed only for explicitly feature-flagged Tier-1
  actions that are non-money, non-order, non-code, non-weight, and reversible. It must
  never call live order routes.

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
- Notional-cap columns are the only money-limit schema in Part A, and they are edited
  only by owner Settings. Part B adds no money/order columns and must not mutate order
  tables except read-only diagnostics.

## B7. Acceptance criteria
- Changing the `health-triage` model in Settings changes the model used on the next run.
- The agent's health (last run, errors) shows in the dashboard agents list.
- Triage suggestions render on the health card; Apply is live only for whitelisted
  deterministic actions.
- No code path lets this agent place/cancel an order, change a money-limit, mutate
  weights, or edit code. (Test: attempt each → blocked.)
- If the LLM is unreachable, Tier-1 remediation and the health card still function
  (LLM is additive, not load-bearing).
- `app/api/kite/order/route.ts` refuses live India orders over `max_order_notional_inr`
  and refuses if the INR cap is null/unavailable.
- `app/api/broker/orders/route.ts` reads `max_order_notional_usd`, with the deprecated
  `max_order_notional` only as a one-release compatibility fallback.

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

**Reviewer correction to B9:** Default INR cap remains an open decision until Vaibhav
explicitly approves it; proposal is INR 4000.

## B10. Diagram / system-map impact
Adds a `health-triage` node reading `agent_alerts`/`agent_runs`/`v_decision_quality` and
writing `health_triage`. On build, update `public/agent-diagrams/system-map.json` +
add the per-agent diagram, and append a history entry per project convention.

## Reviewer changelog (ChatGPT)

- Header: Updated author line to "reviewed/updated by ChatGPT, 2026-07-08" as requested.
- Section A2: Added binding reviewer corrections that keep `max_order_notional` as a deprecated USD read-through for at least one release, require additive migration application before route code reads new cap columns, and forbid uncapped live-money fallback on missing schema.
- Section A2: Corrected cap fallback semantics: US may keep the current fresh-equity 15% fallback; Kite/India must fail closed if `max_order_notional_inr` is null because no trusted Kite equity fallback is defined.
- Section A2/A3: Added explicit owner-human gating for money-limit edits and preserved long-only / sell-only-if-held order-side rules.
- Section B1: Strengthened the hard LLM boundary so the deterministic apply route also rejects action ids touching orders, code, weights, model selection, broker credentials, secrets, or money limits.
- Section B2: Replaced persistent provider "auto-flip" behavior with one-shot fallback retry only; no automated provider config/API-key/priority/budget mutation.
- Section B3: Added a read-only prompt/tool contract for the LLM; it must not receive tools or route access that can write money/config/code/order/secret state.
- Section B4: Required owner-click routes to be CSRF/Origin protected and not cron-callable; auto-apply is limited to reversible non-money/non-order/non-code/non-weight Tier-1 actions.
- Section B6: Clarified that Part B adds no money/order schema and must not mutate order tables except read-only diagnostics.
- Section B7: Added acceptance tests for Kite INR notional-cap enforcement and US Gateway use of `max_order_notional_usd`.
- Section B9: Default INR cap is still an open question until Vaibhav explicitly approves it; proposal remains INR 4000.
- Sections reviewed with no additional change: B5, B8, and B10 were consistent after the safety edits above.
