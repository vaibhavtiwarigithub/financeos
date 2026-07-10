# Live Auto Trading — Implementation Plan

**Created:** 2026-07-10  
**Status:** Architecture-verification only — NO code changes  
**Reviewer:** Claude Sonnet 4.6  
**Source docs read:** FEATURE_ARCHITECTURE.md (live-auto), docs/arch/03-agents.md, docs/arch/08-risk-and-safety.md, lib/autonomy.ts, lib/robinhood-mcp.ts, lib/brokers/adapters/robinhood-mcp.ts, app/api/agents/trader/route.ts, app/api/broker/orders/route.ts, supabase/migrations/037, 093, 094, 095, 103, 104, 105, 106, 107, 108, 116, 121, 122, 124, 132, 133, 134, 135

---

## Section 1 — Architecture-to-code gap analysis by phase

### PA0 — Architecture/schema/UI only

**Architecture requirement:** Additive migrations, RLS/grants/checks; Settings card with audited time-bounded enablement; deployment flag stays false; no autonomous order route.

#### Account number verification

| Check | Result |
|---|---|
| `605420606` (WRONG) in `.ts` files | NOT FOUND — grep across all `.ts` files returned no matches. |
| `605420660` (CORRECT) in `app/api/agents/trader/route.ts` | CONFIRMED at line 18: `const AGENTIC_ACCOUNT = "605420660";` |
| `605420660` in `supabase/migrations/037_trader_proposals.sql` | CONFIRMED at line 55: `account_number text not null default '605420660'` |
| `965848641` (read-only) | Appears in vault references and settings only — not used in order placement |

**Assessment:** No wrong account number found in production code. The previous incorrect draft (`605420606`) was corrected before implementation.

---

#### `AUTONOMOUS_LIVE_ENABLED` location and DB toggle replacement

| Item | Current state | Gap |
|---|---|---|
| `AUTONOMOUS_LIVE_ENABLED` constant | `lib/autonomy.ts` line 32: `export const AUTONOMOUS_LIVE_ENABLED = false` | EXISTS and is correctly `false` |
| `autonomousLivePlacementAllowed()` function | `lib/autonomy.ts` lines 60–64: returns `false` unconditionally when `AUTONOMOUS_LIVE_ENABLED=false` | EXISTS and correct |
| DB `live_auto_enabled` column | MISSING — not in any migration 001–135. `strategy_config` does not have this column. | PA0 migration must add it. |
| DB `live_auto_enabled_until` column | MISSING — not in any migration | PA0 migration must add it. |
| All other PA0 `strategy_config` columns | `live_auto_daily_cap_usd`, `live_auto_max_per_order_usd`, `live_auto_min_evidence_confidence`, `live_auto_max_open_positions`, `live_auto_max_orders_per_day`, `live_auto_policy_version` | ALL MISSING — not in any migration 001–135. |

**Architecture instruction:** PA0 DB migration adds all these columns. The deployment flag (`AUTONOMOUS_LIVE_ENABLED`) must remain as-is in `lib/autonomy.ts`; it is NOT replaced by a DB column — both are required (deployment flag = release control; DB toggle = owner runtime control).

---

#### `trade_proposals` status values

**Current constraint** (migration 037, last updated):
```sql
check (status in (
  'pending_review',   -- awaiting user action
  'approved',         -- user approved
  'rejected',         -- user rejected
  'expired',          -- approval window passed
  'submitted',        -- sent to Robinhood
  'filled',           -- Robinhood confirmed fill
  'failed',           -- submission failed
  'cancelled'         -- cancelled after submission
))
```

**Architecture target states:**
`pending_review`, `approved`, `queued_auto`, `submitted`, `manual_review_required`, `failed`, `expired`, `cancelled`

**Gap analysis:**

| Status | In DB | In Architecture | Action |
|---|---|---|---|
| `pending_review` | YES | YES | Keep |
| `approved` | YES | YES | Keep |
| `queued_auto` | NO | YES | ADD — needed for PA1 autonomous path |
| `submitted` | YES | YES | Keep |
| `manual_review_required` | NO | YES | ADD — PA1 auto fallback |
| `failed` | YES | YES | Keep |
| `expired` | YES | YES | Keep |
| `cancelled` | YES | YES | Keep |
| `rejected` | YES | NO (arch omits) | Keep for backward compatibility, not used in auto path |
| `filled` | YES | NO (arch says broker_orders owns fill state) | Keep for backward compatibility |

**Migration needed (PA0):** Alter `trade_proposals` status constraint to ADD `queued_auto` and `manual_review_required`. Cannot remove existing values because existing rows use them and app code references them.

---

#### `reserve_live_order_budget` RPC — current state vs PA0 requirement

| Item | Current implementation (migration 105) | Architecture requirement | Gap | Severity |
|---|---|---|---|---|
| Existence | EXISTS as `reserve_live_order_budget(bigint, text, text, text, text, text, numeric, text, numeric, numeric, text, int, numeric)` | EXISTS requirement | OK |
| `approved_by_user` hardcoded | Line 88 of migration 105: `'pending_submit', true` — hardcodes `approved_by_user=true` | Must accept `execution_actor` parameter and set `approved_by_user = (actor='owner')` | BLOCKER — cannot use existing RPC for autonomous orders |
| `execution_actor` parameter | ABSENT — no actor parameter | Required | BLOCKER |
| Budget counting scope | Lines 66–68: counts `status not in ('error', 'rejected', 'canceled')` — does NOT count `unknown_needs_reconcile` or `partially_filled` | Must count reserved/submitted/partial/unknown BUY notional so timeouts cannot reopen budget | HIGH |
| Inserts `broker_orders` in same transaction | YES (line 83–89) — atomic insert | Required | OK |
| Advisory lock | YES (line 57) — `pg_advisory_xact_lock(hashtext(current_date::text || ':' || coalesce(p_market,'')))` | Market-local-day advisory lock required | OK |
| SELL exemption | YES (line 60: `if p_side = 'buy'`) | Required | OK |
| Grants | Migration 105 lines 96–97: revoked from PUBLIC, granted to service_role only | Required | OK |
| Overloading risk | Current signature has 13 parameters | Architecture requires `reserve_live_order_budget_v2` — new named RPC, not an overloaded version | Must create new RPC, not overload existing. PostgREST ambiguity issue already documented (migration 083 fixed a similar problem). | HIGH |

**Conclusion:** The existing `reserve_live_order_budget` CANNOT be used for autonomous orders. PA0 must introduce `reserve_live_order_budget_v2` with actor tracking.

---

#### `app/api/broker/orders/route.ts` as Execution Gateway — current state

| Aspect | Current state |
|---|---|
| Auth gate | `requireOwner()` at line 60 — owner-only. This is correct for the manual path but blocks cron/worker callers. |
| Role as shared kernel | NOT extracted. All logic is inline in the route handler. Both the auth guard and the business logic (kill switches, quote, budget, broker submit) live in one function. |
| Can serve as shared kernel | CANNOT in current form — `requireOwner()` is the first gate and cannot be bypassed by a cron worker. Extraction into `executeApprovedProposal()` (as architecture requires) would allow the manual route to call it with `requireOwner()` pre-checked, and the cron worker to call it with `verifyCronSecret()` pre-checked. |
| Lines that would move to kernel | Approximately lines 80–end: proposal lookup, override audit, symbol validation, broker resolution, trading flags, autonomy level, kill switches, data quality gate, account resolution, quote fetch, notional cap, price drift, portfolio limits, budget reservation, broker submit, event write. |
| Owner-override fields (`acceptLowQuality`, `acceptPortfolioRisk`) | Lines 68, 103–120. These are owner-only flags and must NOT be accepted by the autonomous path. The kernel signature must distinguish actor kind. |

**Severity: HIGH** — PA1 requires extraction before an autonomous worker route can be created. This is the single largest structural change in PA0/PA1.

---

### PA1 — Shadow autonomous decisions

**Architecture requirement:** Extract and test shared execution kernel; auto worker evaluates proposals and records would-submit/would-block reasons; NO broker submit.

| Item | Current state | Gap | Severity |
|---|---|---|---|
| Shared kernel function | DOES NOT EXIST | Must be created as `lib/execution/kernel.ts` or `lib/orders/execute-approved-proposal.ts` | BLOCKER for PA1 |
| Shadow autonomous decision logging | DOES NOT EXIST — no table for would-submit/would-block records | Need `autonomous_shadow_decisions` table or extend `trade_proposals` with `execution_mode='auto'` and `policy_snapshot jsonb` | HIGH |
| Autonomous worker route | DOES NOT EXIST | `app/api/agents/auto-trader/route.ts` (new) — uses `verifyCronSecret()`, single-run lease, calls kernel | HIGH |
| Single-run lease | DOES NOT EXIST — no DB column or mechanism to prevent concurrent auto-trader runs | Must implement (e.g. `strategy_config.auto_run_active` flag or an advisory lock) | HIGH |
| PA1 scoring version lifecycle gate | MISSING — auto path must require `live_approved` strategy version. Neither the column nor the gate exists yet. | Depends on scoring plan migration 136 adding `live_approved` to constraint. | HIGH |
| `trade_proposals.execution_mode` | MISSING — not in current schema | PA0 migration adds `execution_mode text` and `auto_run_id uuid` and `auto_decided_at timestamptz` | MED |

---

## Section 2 — Blockers before PA1 can ship

The following must exist AND be proven operational before PA1:

| Blocker | Current state | Status |
|---|---|---|
| `live_approved` strategy version lifecycle state in DB | MISSING from `strategy_versions.state` constraint | BLOCKER — scoring plan migration 136 must be applied first |
| Shared execution kernel extracted from `app/api/broker/orders/route.ts` | DOES NOT EXIST | BLOCKER |
| `broker_order_events` append-only ledger | DOES NOT EXIST — no migration, no `.ts` references | Required by PA1/PA2 for audit trail. Table must be created before kernel can write events. |
| `live_auto_enabled` + lease columns on `strategy_config` | MISSING | BLOCKER — PA0 migration must apply first |
| `reserve_live_order_budget_v2` RPC with actor tracking | DOES NOT EXIST | BLOCKER for PA1 shadow (even shadow runs must verify all caps would pass) |
| `trade_proposals.execution_mode`, `policy_snapshot`, `auto_run_id`, `auto_decided_at` | MISSING | BLOCKER for recording PA1 shadow decisions |
| `queued_auto` and `manual_review_required` status values | MISSING from constraint | Needed before PA1 auto worker can set proposal status |

**Live exits** (Section 7 of FEATURE_ARCHITECTURE.md):

| Item | Current state | Status |
|---|---|---|
| Live protective-exit path for held positions | DOES NOT EXIST — `PositionMonitor` handles paper positions only. No live held-position SELL path via the Execution Gateway. | LAUNCH BLOCKER for PA3 autonomous BUY. Needed for PA2. |
| Partial-fill sync | DOES NOT EXIST — `broker_orders.sync/route.ts` exists but partial fill handling is incomplete. `broker_order_events` table does not exist for the ledger. | Needed for PA2. |
| Reconciliation flow | PARTIAL — `unknown_needs_reconcile` status exists (migration 095) but no full reconciliation worker that resolves fill/cancel/reject states and blocks new entries on mismatch. | Needed for PA2. |

---

## Section 3 — Next migration number

See scoring plan Section 3: **next available migration number is 136**.

PA0 live-auto migrations should be sequenced AFTER scoring P0 migrations. Suggested:
- `136_scoring_p0_schema.sql` — scoring plan P0 schema
- `137_agent_signals_llm_veto.sql` — scoring llm_veto column  
- `138_live_auto_pa0_schema.sql` — live-auto PA0 columns

Do NOT reuse number 113 (has a collision in current repo).

---

## Section 4 — Dependency-ordered build sequence

### PA0-Step 1 — Schema (migration 138)

**What changes:**
```sql
-- strategy_config new columns
alter table strategy_config add column if not exists live_auto_enabled boolean not null default false;
alter table strategy_config add column if not exists live_auto_enabled_until timestamptz;
alter table strategy_config add column if not exists live_auto_policy_version integer not null default 1;
alter table strategy_config add column if not exists live_auto_daily_cap_usd numeric;
alter table strategy_config add column if not exists live_auto_max_per_order_usd numeric;
alter table strategy_config add column if not exists live_auto_min_evidence_confidence numeric;
alter table strategy_config add column if not exists live_auto_max_open_positions integer;
alter table strategy_config add column if not exists live_auto_max_orders_per_day integer;

-- trade_proposals new columns and status values
alter table trade_proposals add column if not exists execution_mode text default 'manual';
alter table trade_proposals add column if not exists policy_snapshot jsonb;
alter table trade_proposals add column if not exists auto_run_id uuid;
alter table trade_proposals add column if not exists auto_decided_at timestamptz;
-- Extend status constraint to add queued_auto and manual_review_required
alter table trade_proposals drop constraint if exists trade_proposals_status_check;
alter table trade_proposals add constraint trade_proposals_status_check check (status in (
  'pending_review','approved','rejected','expired','submitted','filled',
  'failed','cancelled','queued_auto','manual_review_required'
));

-- broker_order_events append-only ledger
create table if not exists broker_order_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  broker_order_id bigint not null references broker_orders(id),
  proposal_id bigint references trade_proposals(id),
  event_type text not null,
  broker text,
  broker_order_ref text,
  filled_qty numeric,
  remaining_qty numeric,
  fill_price numeric,
  raw_payload_hash text,
  actor_kind text,   -- 'owner' | 'autonomous_worker'
  auto_run_id uuid
);
alter table broker_order_events enable row level security;
-- append-only: block updates and deletes
create or replace function boe_block_mutation() returns trigger language plpgsql as $$
begin raise exception 'broker_order_events is append-only'; end $$;
create trigger boe_no_update before update or delete on broker_order_events
  for each row execute function boe_block_mutation();
```

**Files:** `supabase/migrations/138_live_auto_pa0_schema.sql` (new)

**Tests:** Verify columns exist; verify `broker_order_events` trigger blocks UPDATE; verify `trade_proposals` accepts `queued_auto` and `manual_review_required`; verify strategy_config defaults are conservative.

**Rollback:** Drop new columns (no data loss at PA0 — no auto code routes use them yet).

**Money movement:** NO — schema only.

---

### PA0-Step 2 — `reserve_live_order_budget_v2` RPC (migration 139)

**What changes:** New RPC that accepts `p_execution_actor text` ('owner'|'autonomous_worker'), sets `approved_by_user = (p_execution_actor = 'owner')`, counts `unknown_needs_reconcile` and `partially_filled` in the daily budget, inserts `broker_order_events` row in same transaction. Granted only to `service_role`. Old `reserve_live_order_budget` remains for backward compatibility with existing manual path.

**Files:** `supabase/migrations/139_reserve_budget_v2.sql` (new)

**Tests:** Verify owner actor sets `approved_by_user=true`; autonomous actor sets `approved_by_user=false`; `unknown_needs_reconcile` orders count toward daily budget; concurrent calls serialize via advisory lock.

**Rollback:** Drop new RPC. Manual path continues using v1.

**Money movement:** NO — RPC not yet called by any live path in PA0.

---

### PA0-Step 3 — Settings UI and Settings API for live_auto_enabled

**What changes:** Settings page gains a "Autonomous Trading" card with:
- Enable Auto switch (disabled if `AUTONOMOUS_LIVE_ENABLED=false` in env, else requires typed confirmation `ENABLE AUTO`)
- Lease duration selector (max 24h)
- Cap inputs (`live_auto_daily_cap_usd`, `live_auto_max_per_order_usd`, etc.)
- Current lease expiry display
- Append-only `decision_journal` entry on any change

**Files:** `app/api/settings/live-auto/route.ts` (new, owner-gated), `components/dashboard/settings/LiveAutoCard.tsx` (new)

**Tests:** Verify that `AUTONOMOUS_LIVE_ENABLED=false` (current) makes the enable switch disabled; verify decision_journal entry is written on change; verify lease expiry is set correctly.

**Rollback:** Remove the UI card. No money impact.

**Money movement:** NO — PA0 only creates the DB state, no autonomous order route exists.

---

### PA1-Step 1 — Shared execution kernel extraction

**What changes:** Extract the money-moving logic from `app/api/broker/orders/route.ts` into:

```typescript
// lib/execution/execute-approved-proposal.ts
export async function executeApprovedProposal({
  proposalId,
  env,
  actor,  // { kind: "owner", userId } | { kind: "autonomous_worker", runId }
  acceptLowQuality,    // only allowed when actor.kind === "owner"
  acceptPortfolioRisk, // only allowed when actor.kind === "owner"
  overrideReason,
}: ExecuteProposalInput): Promise<ExecuteProposalResult>
```

The existing route `app/api/broker/orders/route.ts` becomes a thin wrapper: `requireOwner()` → `executeApprovedProposal({actor: {kind:"owner", userId}})`.

Autonomous worker route `app/api/agents/auto-trader/route.ts` (PA1 shadow only — no broker submit): `verifyCronSecret()` → evaluates proposals → records would-submit/would-block → NO broker submit call in PA1.

**Files:** `lib/execution/execute-approved-proposal.ts` (new), `app/api/broker/orders/route.ts` (modified to delegate), `app/api/agents/auto-trader/route.ts` (new, shadow-only)

**Tests:** Unit tests for every gate in the kernel; integration test that owner route behavior is byte-for-byte identical before and after extraction; test that auto-worker route records correct would-submit/would-block reasons without calling the broker.

**Rollback:** Restore inline logic in route.ts; remove new files. HIGH RISK — must be done carefully to avoid regressions on the manual path.

**Money movement:** Manual path behavior must not change. NO new autonomous money movement in PA1 (shadow only).

---

### PA1-Step 2 — Shadow decision logging

**What changes:** Auto-worker route writes `trade_proposals.execution_mode='auto'`, `auto_run_id`, `auto_decided_at`, and status `'queued_auto'` (would-submit) or `'manual_review_required'` (would-block). These are shadow records — no broker submission.

**Files:** `app/api/agents/auto-trader/route.ts`, cron entry in `vercel.json`

**Tests:** Run the auto-worker; verify shadow proposals created with `execution_mode='auto'`; verify no broker calls made; verify that concurrent runs are blocked by single-run lease.

**Rollback:** Disable the cron entry.

**Money movement:** NO — shadow only.

---

## Section 5 — Non-negotiable gate: no `submitRobinhoodOrder()` direct calls

### Current call sites (all `.ts` files)

| File | Call site | Role | Acceptable? |
|---|---|---|---|
| `lib/robinhood-mcp.ts` | Line 411: function DEFINITION (`export async function submitRobinhoodOrder(...)`) | Function definition | N/A |
| `lib/brokers/adapters/robinhood-mcp.ts` | Line 2: import; Line 38: `const res = await submitRobinhoodOrder({...})` | Broker ADAPTER — this IS the correct location. The adapter is the one place allowed to call the underlying transport. | ACCEPTABLE |

**Assessment:** `submitRobinhoodOrder()` is called ONLY in:
1. Its own definition file (`lib/robinhood-mcp.ts`)
2. The broker adapter (`lib/brokers/adapters/robinhood-mcp.ts`)

No direct calls exist in:
- `app/api/agents/trader/route.ts` — confirmed
- `app/api/broker/orders/route.ts` — confirmed (it calls the broker adapter via the registry, which internally calls `submitRobinhoodOrder`)
- Any other agent or cron route — confirmed

**Architecture compliance:** The current call structure IS already compliant. The Gateway calls the registry → adapter → `submitRobinhoodOrder`. The concern in the architecture doc about bypassing the Gateway does not apply to current code.

**PA1 requirement:** The extracted `executeApprovedProposal()` kernel must call the broker adapter via the registry (same as the current Gateway). It must NOT import `submitRobinhoodOrder` directly. The static test (architecture doc §11) should verify that only the adapter file imports from `lib/robinhood-mcp.ts`.

**Test to add:** A static import check (via grep or a Jest module test) that verifies `submitRobinhoodOrder` is only imported by `lib/brokers/adapters/robinhood-mcp.ts`.

---

## Section 6 — RLS/grants/security concerns

| Concern | Detail | Severity |
|---|---|---|
| `reserve_live_order_budget_v2` permissions | Must be `SECURITY DEFINER` with fixed `search_path = public`. Must REVOKE from `public`, `anon`, `authenticated`. GRANT only to `service_role`. | CRITICAL — same as v1 |
| `broker_order_events` RLS | Table must have RLS enabled (done in migration above). Service-role-only access via server-side routes. No direct client reads. | HIGH |
| `broker_orders` RLS | CONFIRMED — migration 089 enabled RLS and locked to service_role only. | OK |
| `live_auto_enabled` write path | The Settings API route that enables auto (`app/api/settings/live-auto/route.ts`) must use `requireOwner()` + request guard + `decision_journal` entry. Must NOT be cron-callable. | CRITICAL |
| `strategy_config` auto columns read in autonomous worker | Worker must read `live_auto_enabled`, `live_auto_enabled_until`, autonomy_level via service client. Must fail closed if any read fails. | HIGH |
| Deployment flag interlock | `autonomousLivePlacementAllowed()` in `lib/autonomy.ts` checks `AUTONOMOUS_LIVE_ENABLED` FIRST. If the env var is absent/false, the DB state is irrelevant — no autonomous order is allowed regardless. This interlock must be preserved in the extracted kernel. | CRITICAL |
| Decision-journal append for auto enablement | Every change to `live_auto_enabled`, `live_auto_enabled_until`, or any auto cap must write a `decision_journal` row with old/new policy, actor, timestamp, expiry BEFORE the config change is committed. Fail-closed: if the journal write fails, abort the config change. | HIGH |
| `live_auto_min_evidence_confidence` must be >= `live path threshold` | If `live_auto_min_evidence_confidence` is set lower than the manual live confidence threshold (currently 0.5 from `v_decision_quality` gate), autonomous orders could pass a lower quality bar than manual ones. Constraint: must enforce `live_auto_min_evidence_confidence >= 0.75` (architecture §7 default policy for auto). | HIGH |
| Single-run lease for auto worker | Concurrent auto-worker invocations (duplicate cron fires) must not both pass gates and submit. Advisory lock or a `strategy_config.auto_run_active` boolean with CAS semantics must be used. | HIGH |
| `approved_by_user` integrity | Old `reserve_live_order_budget` must continue to be used ONLY by manual path (sets `approved_by_user=true`). New `reserve_live_order_budget_v2` used by both paths, correctly setting actor. No code path may call v1 for autonomous orders. Add a code comment or assertion. | HIGH |
| `api_key_vault` — Robinhood tokens | Vault access is service-role-only (migration 089). Tokens must never appear in `broker_order_events.raw_payload_hash` (hash only, not the token). The architecture explicitly states: "Never store tokens." | CRITICAL |

