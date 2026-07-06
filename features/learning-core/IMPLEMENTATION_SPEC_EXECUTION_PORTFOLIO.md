# Execution Gateway + Portfolio Constructor — Implementation Spec

**Audience:** any implementing model/engineer. Follow exactly; do not improvise. These are the final two blocks of the achievable-now vision (see FEATURE_ARCHITECTURE.md + IMPLEMENTATION_SPEC_PHASE2_3.md).
**Order:** Portfolio Constructor may be built any time after Phase 1. Execution Gateway is independent but its LIVE stage must wait until Phase 2's validation gate exists.

**Non-negotiable safety rails (repeat verbatim in every PR):**
- Human approves EVERY live order — no auto-execution, ever, regardless of validation results.
- Robinhood: account `605420660` only, and it stays MANUAL (paste-command flow) — Robinhood has no public order API; do not attempt one.
- Kite (India): existing two-step confirm flow unchanged.
- All new live-order code paths require `strategy_config.trading_enabled = true` AND explicit human click AND `confirm:true` — three independent gates.
- Everything guarded: missing table/env → feature dormant, legacy behavior byte-for-byte.

---

# PART A — Typed Broker Gateway (US, via Alpaca)

## Why Alpaca
`lib/brokers/alpaca.ts` already reads both Alpaca books (paper + live). Alpaca has a real REST order API with order-state webhooks/polling — the missing piece Robinhood can't provide. Strategy: **proposals → human approval → Alpaca PAPER order (stage 1) → later Alpaca LIVE (stage 2, own approval)**. Robinhood manual flow stays as-is in parallel.

## A.1 Migration `068_broker_orders.sql`

```sql
-- Typed order lifecycle for broker-routed orders. One row per order attempt.
create table if not exists broker_orders (
  id               bigserial primary key,
  created_at       timestamptz default now(),
  proposal_id      uuid,                          -- trade_proposals.id that spawned it
  market           text not null default 'us',
  broker           text not null default 'alpaca',-- 'alpaca' | 'kite'
  broker_env       text not null default 'paper', -- 'paper' | 'live'
  symbol           text not null,
  side             text not null check (side in ('buy','sell')),
  qty              numeric not null,
  order_type       text not null default 'market',
  limit_price      numeric,
  -- lifecycle
  status           text not null default 'pending_submit',
    -- pending_submit -> submitted -> partially_filled -> filled | canceled | rejected | expired | error
  broker_order_id  text,                          -- Alpaca's id
  submitted_at     timestamptz,
  filled_qty       numeric default 0,
  avg_fill_price   numeric,
  closed_at        timestamptz,
  raw_last_state   jsonb,                         -- last broker payload verbatim
  error            text,
  approved_by_user boolean not null default false -- MUST be true before submit
);
alter table broker_orders disable row level security;
create index if not exists border_status_idx on broker_orders(status, created_at desc);
```

## A.2 `lib/brokers/alpaca-orders.ts`

Read `lib/brokers/alpaca.ts` first and reuse its env/key/base-url pattern (paper vs live base URLs). Exports:

```ts
export async function submitAlpacaOrder(o: { symbol: string; side: "buy"|"sell"; qty: number;
  type?: "market"|"limit"; limitPrice?: number; env: "paper"|"live" }):
  Promise<{ ok: boolean; brokerOrderId?: string; raw?: any; error?: string }>   // POST /v2/orders
export async function getAlpacaOrder(brokerOrderId: string, env: "paper"|"live"):
  Promise<{ ok: boolean; status?: string; filledQty?: number; avgFillPrice?: number; raw?: any; error?: string }>  // GET /v2/orders/{id}
export async function cancelAlpacaOrder(brokerOrderId: string, env: "paper"|"live"): Promise<{ ok: boolean; error?: string }>
```
All fetches: `AbortSignal.timeout(10000)`, fail-soft returns, never throw. Map Alpaca statuses → our lifecycle: `new/accepted→submitted`, `partially_filled→partially_filled`, `filled→filled`, `canceled/expired/rejected→ same`.

## A.3 Routes

1. **`app/api/broker/orders/route.ts`**
   - `POST` — body `{ proposal_id, env }` (env defaults `"paper"`; `"live"` additionally requires `strategy_config.trading_enabled === true` else 403). Auth: logged-in user ONLY (never cron). Flow: load proposal (must be status approved + unexpired) → insert `broker_orders` row `approved_by_user=true, status='pending_submit'` → `submitAlpacaOrder` → update row (`submitted` + broker_order_id, or `error`) → journal to `decision_journal` (entry_type `broker_order`). Idempotency: refuse if an active (`pending_submit|submitted|partially_filled`) broker_orders row already exists for the proposal.
   - `GET` — list recent orders (for UI), optional `?status=`.
2. **`app/api/broker/orders/sync/route.ts`** — `POST`, cron-secret auth. For every `submitted|partially_filled` row: `getAlpacaOrder`, update status/filled_qty/avg_fill_price/raw_last_state; on `filled`, journal the fill. Cron: run-agents.ps1 endpoint `"broker-sync"` + register-tasks weekday trigger every 30 min during market hours (use the proposal-reminder Repetition pattern: base 9:30AM, interval 30 min, duration 6.5h).
3. **Reconciliation** — extend `sync` : after updates, fetch Alpaca positions (`fetchAlpacaAccount`) and compare against filled broker_orders aggregates; on mismatch > 1 share, raise an alert (existing `/api/alerts` POST pattern, category "broker", severity warn).

## A.4 UI (Smart Money → Trade Queue tab)
Where an approved US proposal currently renders the "paste into Claude/Robinhood" command block, ADD a second button: **"Send to Alpaca (paper)"** → confirm dialog (shows symbol/side/qty/est price) → POST /api/broker/orders. Show order lifecycle chip (status + filled/avg) sourced from GET. The Robinhood manual block STAYS — two parallel paths, user picks per order. Live-env button appears ONLY when `trading_enabled` is true, styled with the same "REAL MONEY" warning pattern as the India Kite confirm.

## A.5 Acceptance
- tsc + build + tests pass. Without 068 or Alpaca keys → UI button hidden, routes 400 cleanly, nothing else changes.
- Paper order round-trip verified against Alpaca paper account (submit → sync → filled row) before the live button is ever enabled.
- `docs`: system-map GATEWAY node + Decision entry + WORK_LOG.

---

# PART B — Portfolio Constructor (cross-position risk budgeting)

## Problem
Signals are sized independently (flat pct today; per-trade Kelly after Phase 2). Nothing looks at the BOOK: 5 highly-correlated tech names can each individually pass while the portfolio is one big bet. Sector cap (count-based) is the only guard.

## B.1 `lib/portfolio/constructor.ts` — pure functions (unit-tested; no DB)

```ts
export interface CandidateOrder { symbol: string; market: "us"|"india"; proposedSizePct: number; // from sizing module
  sector: string | null; beta: number | null; dailyVol: number | null; corrProxy?: number | null }
export interface BookPosition { symbol: string; sector: string | null; valuePct: number; beta: number | null; dailyVol: number | null }
export interface PortfolioLimits { maxGrossExposurePct: number /*default 80*/; maxSectorExposurePct: number /*default 30*/;
  maxNameExposurePct: number /*default 12*/; maxPortfolioVolPct: number /*default 2.0 daily*/; maxAvgPairwiseCorr: number /*default 0.7*/ }

// Deterministically shrink/deny candidate sizes so the post-trade book satisfies every limit.
// Order of operations (fixed): name cap -> sector cap -> gross cap -> vol budget -> corr penalty.
// Never increases a size. Returns per-candidate final size + per-rule audit trail.
export function constructPortfolio(book: BookPosition[], candidates: CandidateOrder[], limits: PortfolioLimits):
  { orders: (CandidateOrder & { finalSizePct: number; adjustments: string[] })[]; bookAfter: { grossPct: number; estDailyVolPct: number } }
```

Rules (exact):
- **Name cap:** finalSize ≤ maxNameExposurePct − existing valuePct of same symbol.
- **Sector cap:** scale down candidates in a sector proportionally so sector total (book + candidates) ≤ maxSectorExposurePct. Unknown sector → counts toward a synthetic "UNKNOWN" sector with the same cap.
- **Gross cap:** proportional scale-down so book+candidates gross ≤ maxGrossExposurePct.
- **Vol budget:** portfolio daily vol estimate = sqrt(Σ (w_i × vol_i)²  + 2×corrAssumed×Σ_{i<j}(w_i vol_i)(w_j vol_j)) with corrAssumed = 0.3 default, 0.6 within same sector. If > maxPortfolioVolPct, proportional scale-down of CANDIDATES only (never forced-sells the book).
- **Corr penalty:** if a candidate's sector already holds ≥ 2 positions, multiply its size by 0.7 (stacked-bet haircut), noted in adjustments.
- Sizes floor at 0 (denied) when scaled below 1 share equivalent — deny reason in adjustments.

Inputs: `dailyVol` = 20d stdev of daily returns from price_cache/Yahoo (helper `lib/portfolio/inputs.ts`, fail-soft null → treat vol as sector median, else 2%); `beta` from Phase-2 risk work when present, else null (unused in v1 rules).

## B.2 Wiring into PaperTrader
In `app/api/agents/paper-trade/route.ts`, after per-signal sizes are computed (flat or Kelly) and BEFORE any fill executes: build `book` from open `paper_positions` (this market) + `candidates` from the qualifying signals batch, call `constructPortfolio`, and use `finalSizePct` for each fill. Store `adjustments` in the decision_journal calculations blob. Limits come from `strategy_config` columns (migration `069_portfolio_limits.sql`, all nullable with the defaults above; absent columns → defaults) — human-set, NOT agent-mutable (same moral-hazard rule as sector cap).
Existing count-based sector cap REMAINS as the outer hard guard (defense in depth).

## B.3 UI
Risk Analytics page: "Portfolio Constructor" card — current gross %, est daily vol vs budget, per-sector exposure bars vs cap, and the last run's adjustments list (read from the latest paper_trader decision_journal rows). Match existing card styling.

## B.4 Acceptance
- Unit tests: each rule in isolation + combined ordering + "never increases size" property + currency isolation (mixed-market inputs must throw).
- With 069 absent → defaults apply; behavior differs from today ONLY when a limit binds (document in WORK_LOG).
- tsc + build + tests green; system-map (CONSTRUCTOR node between TRADER sizing and fills); Decision entry.

---

**Sequencing note for the roadmap:** Portfolio Constructor (B) can ship right after Phase 1 (it needs only vol inputs). Gateway paper-stage (A stages 1) any time; Gateway live-stage only after Phase 2's validation gate + a user go. With A+B specced, the spec set covers 100% of the achievable-now vision; remaining upside (paid data tier, cloud infra) are spend decisions, not specs.
