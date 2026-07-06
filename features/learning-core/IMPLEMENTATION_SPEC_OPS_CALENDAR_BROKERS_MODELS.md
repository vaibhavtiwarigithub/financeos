# Ops Calendar + Broker Abstraction + Model Freshness — Implementation Spec

**Audience:** any implementing model/engineer. Follow exactly. Approved 2026-07-06.
**Queue position:** after the current build-all items unless interleaved as small wins (Part 1 is small; Part 2 modifies the not-yet-built Gateway spec — read it together with `IMPLEMENTATION_SPEC_EXECUTION_PORTFOLIO.md` Part A; Part 3 is small).

---

## Part 1 — 30-day Agent-Run Calendar (dashboard top)

**Goal:** at a glance: for each of the past 30 days, which agents/flows ran, which succeeded/failed/skipped, and why.

**Data:** `agent_runs` already stores `agent_type, status ('running'|'done'|'error'), started_at, completed_at, result_summary, trigger_source`. Cron-gap journaling (spec 1b, decision_journal entry_type `cron_gap`) covers *missing* runs once built.

**1a. Aggregation route `app/api/agents/calendar/route.ts`** (GET, logged-in user):
- Query `agent_runs` for the last 30 days; group by `date(started_at)` × `agent_type`.
- Per (date, agent): `{ status: "ok" | "error" | "partial" | "skipped", runs: n, summary: <last run's result_summary truncated 200 chars>, trigger: <trigger_source> }`.
  - ok = all runs done; error = any status 'error' or a result_summary starting with an error marker; partial = mix; skipped = result_summary contains "skipped"/"Weekend"/"holiday".
- ALSO derive **expected-but-missing**: for each weekday in range, the expected set = research, paper_trader, position-monitor (+ research-india etc. when market_focus includes India; + learner on Fridays). Expected agent with zero runs that day → `{ status: "missing", summary: "No run recorded — PC off/asleep at trigger time? See scripts/README recovery." }`. Weekends/US holidays are not "missing".
- Return `{ days: [{ date, agents: { research: {...}, paper_trader: {...}, ... } }] }`.

**1b. UI `components/dashboard/AgentCalendar.tsx`**, rendered at the TOP of the main dashboard page (`app/dashboard/page.tsx`, above existing content):
- Horizontal strip: 30 day-columns × agent-rows (compact dots/cells). Color: green ok / red error / yellow partial / gray skipped / hollow-red missing. Weekend columns dimmed.
- Click a cell → popover with the summary ("what/why/next" detail rule: status + result_summary + trigger + a recovery hint for missing/error).
- Collapsible (persist collapsed state to localStorage). Match `T` theme tokens.
- Detail-over-cryptic rule applies: never a bare dot without a click-through explanation.

## Part 2 — Broker Abstraction (swap Alpaca ↔ E*TRADE, multiple brokers, Settings control)

**Honest current state:** Gateway spec Part A calls `lib/brokers/alpaca-orders.ts` directly; `broker_orders` has a `broker` column but nothing routes on it. Swapping brokers would mean editing routes. Fix = typed adapter interface + registry + Settings.

**2a. `lib/brokers/types.ts`:**
```ts
export interface BrokerOrderResult { ok: boolean; brokerOrderId?: string; raw?: any; error?: string }
export interface BrokerOrderState { ok: boolean; status?: "submitted"|"partially_filled"|"filled"|"canceled"|"rejected"|"expired"; filledQty?: number; avgFillPrice?: number; raw?: any; error?: string }
export interface BrokerAdapter {
  id: string;                 // "alpaca" | "etrade" | "kite" | ...
  market: "us" | "india";
  envs: ("paper"|"live")[];   // which environments this broker supports
  isConfigured(): Promise<boolean>;   // keys present?
  submitOrder(o: { symbol: string; side: "buy"|"sell"; qty: number; type?: "market"|"limit"; limitPrice?: number; env: "paper"|"live" }): Promise<BrokerOrderResult>;
  getOrder(brokerOrderId: string, env: "paper"|"live"): Promise<BrokerOrderState>;
  cancelOrder(brokerOrderId: string, env: "paper"|"live"): Promise<{ ok: boolean; error?: string }>;
}
```
**2b. `lib/brokers/registry.ts`:** `const ADAPTERS: Record<string, () => BrokerAdapter>` — lazy factories. Ships with `alpaca` (wraps alpaca-orders.ts) and `kite` (wraps lib/kite.ts placeEquityOrder/kiteGet order status; envs: ["live"] only — Kite has no paper). `getBroker(id)`, `listBrokers(market)`, `getActiveBroker(supabase, market)` (reads config, falls back: us→alpaca, india→kite).
**2c. Config:** migration `073_broker_config.sql`: `strategy_config` gains `active_broker_us text default 'alpaca'`, `active_broker_india text default 'kite'`. Settings → Agents section: per-market broker dropdown listing `listBrokers(market)` with a configured/not-configured badge (from `isConfigured()`), and a note "keys go in Admin → Vault / .env — never entered here".
**2d. Gateway routes use ONLY the registry** (`getActiveBroker`), never a direct adapter import. `broker_orders.broker` records which adapter executed each order (already in the schema). The 30-min sync loop iterates DISTINCT brokers present in open orders — so multiple brokers can have in-flight orders simultaneously (e.g. you switch mid-week; old Alpaca orders still sync while new E*TRADE orders flow).
**2e. Adding a future broker (e.g. E*TRADE) =** one new file `lib/brokers/etrade.ts` implementing `BrokerAdapter` + one registry entry + its keys in the vault. Zero route/UI changes. Document this recipe in the file header of registry.ts.
**Safety unchanged:** all three human gates (trading_enabled + click + confirm) sit ABOVE the adapter layer; adapters never gate.

## Part 3 — Model/LLM Freshness Checker (fortnightly)

**Goal:** surface "a newer/better model exists for agent X" in-app. NEVER auto-switch — human decides in the existing agent-config UI.

**3a. Route `app/api/models/check/route.ts`** (POST, cron-secret or user):
- Read current assignments from `agent_config` (agent_name → model).
- Fetch available models per provider (fail-soft each):
  - Anthropic: `GET https://api.anthropic.com/v1/models` (header `x-api-key` from env ANTHROPIC_API_KEY if present, `anthropic-version` required).
  - Groq: `GET https://api.groq.com/openai/v1/models` (Bearer GROQ_API_KEY).
  - DeepSeek: `GET https://api.deepseek.com/models` (Bearer DEEPSEEK_API_KEY).
- Diff: models available but unused; models in use that no longer appear (deprecation risk!). Heuristic "newer": same family prefix with a higher version/date suffix than the assigned one.
- Store result in `model_check_results` (migration `074`: id, checked_at, findings jsonb, providers_ok jsonb). Raise an `/api/alerts` info alert only when findings are non-empty ("Model check: claude-x-y available; learner uses claude-opus-4-8. Review in Agents → config."), and a WARN alert when an in-use model is missing from its provider list (deprecation).
**3b. Cron:** register-tasks.ps1 task `model-check`, trigger: WEEKLY Monday 7:30 AM (every week is fine — cheap; the "every 2-3 weeks" ask is satisfied by weekly, and StartWhenAvailable covers missed Mondays). run-agents.ps1 endpoint entry, timeout 120s.
**3c. UI:** Agents page — small "Model freshness" card: last check date, per-agent current model, any findings (new/deprecated), and a "Check now" button (POST the route). No selection UI here — link text points to the existing agent-config model picker. Honest empty state: "No provider keys for X — can't check that provider."
**Scope guard:** this checks MODELS from providers already integrated. "Newer agent frameworks on the market" is not machine-checkable — out of scope; the card carries a one-line note saying architecture-level upgrades come from reviews (like the Codex cycle), not this checker.

## Docs
- PROJECT_DECISIONS: fold into one entry (Decision 35): ops calendar (visibility), broker adapter registry (swap/multi-broker via Settings, safety gates above adapters), model freshness (inform-only, never auto-switch).
- WORK_LOG rows per part; system-map: no new agent-flow nodes (calendar/model-check are ops surfaces; broker registry sits inside the existing GATEWAY node — update that node's description when Gateway is built).

## Acceptance
- tsc + build (+ tests when vitest lands: the calendar aggregation's expected-set/missing logic and the model-diff heuristic as pure functions).
- All migrations resilient (absent → current behavior). Calendar renders with zero agent_runs (empty state). Model check with zero provider keys → honest "can't check" card, no crash.
- Migrations delivered as clickable links + full paths.
