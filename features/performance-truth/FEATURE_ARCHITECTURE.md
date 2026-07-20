# Performance Truth Layer — Feature Architecture

Last updated: 2026-07-09 (v2 — post Codex BLOCKER/HIGH review)  
Status: **P0 — awaiting approval before any implementation**

---

## Goal

Build a deterministic, mandate-aware, cost-adjusted evaluation layer that
answers one question:

> "Did this strategy create repeatable, benchmark-relative edge in the mandate
> it claims to serve?"

Two evaluation targets (both required):
1. **Book/trade metrics** — what actually happened to the paper book (closed trades + NAV)
2. **Opportunity-level metrics** — what would have happened across the full scored opportunity set (decision_observations × observation_labels)

No live trading impact. No LLM weight optimization. Append-only. Deterministic.

---

## Reuse inventory — what already exists

### Analytics math (`lib/analytics/performance-metrics.ts`)
All math already built. Full reuse, zero changes:
- `navToReturns()`, `sharpe()`, `sortino()`, `maxDrawdown()`
- `expectancy(trades[])` — expects rows with `{ pnl_pct, outcome }` directly (NOT `{ returnPct }`)
- `costNet(trades[])`, `slip(trades[])`
- `calibration(rows[])` — expects `{ predicted: number (0–1), win: boolean }` (NOT `{ score, won }`)
- Returns `Metric { value, n, insufficient }` — abstains correctly when n < min

### API (`app/api/agents/performance/metrics/route.ts`)
Reads `paper_performance + paper_trades`, returns full metric set per market.
**Additive change:** accept `?mandateId=` for trade-level filtering. NAV metrics
remain whole-book (paper_performance has no mandate column); label them clearly
as book-level, not mandate-specific. Mandate-specific Sharpe comes from
opportunity-level evaluation in `strategy_evaluations`.

### UI (`components/dashboard/PerformanceTruth.tsx`)
Full metric tiles already render. **Two additive changes only:**
(1) mandate selector dropdown, (2) evaluation history table below existing tiles.
Existing tiles untouched.

### Tables (confirmed columns from migrations audit)
- `paper_trades` — closed via `closed_at IS NOT NULL` (no `status` column)
  - Execution quality: `expected_price`, `realized_slip_pct`, `fill_status`, `spread_applied`, `data_confidence`, `tainted`, `taint_reason`, `excluded_from_learning`
- `paper_performance` — canonical NAV plus seed-based total/daily P&L, cumulative
  outcome counts/win rate, `alpha_pct`, and `bench_return_pct` per `(date, market)`;
  NOT per mandate. Both runtime writers use the same derivation helper so a later
  mark-to-market cannot leave stale/default analytics behind.
- `decision_observations` — immutable append-only; full feature scores, weights_used, signal_id
- `observation_labels` — matured forward returns per observation (used by learning dataset)
- `lib/learning/dataset.ts` — `loadLabeledDataset()` already joins decision_observations × observation_labels
- `edge_universe_members` — **NOT point-in-time**; current-liquid/survivorship-biased.
  Do NOT use for promotion-grade PIT universe evaluation. Flag all evaluations that
  use this as `universe_pit_safe: false` in strategy_evaluations.

### Validation engine (`lib/validation/engine.ts`)
Walk-forward replay, block bootstrap, p-value. Already persists to
**`validation_experiments`** table and updates `strategy_versions.validation_experiment_id`.
This is the canonical challenger evidence ledger. The new `strategy_evaluations`
table is a summary layer that REFERENCES `validation_experiments` via FK — it
does NOT replace it.

### Auth helper
Use `requireOwner()` from `lib/auth/require-owner.ts` — not `requireOwnerSession()`.

---

## Net-new work

### Migration A — `investment_mandates`

```sql
create table public.investment_mandates (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  market                   text not null check (market in ('us', 'india')),
  horizon                  text not null check (horizon in (
                             'swing_2_20d', 'position_1_6m',
                             'long_term_1y_plus', 'income_dividend'
                           )),
  -- 'intraday' excluded: no intraday data/execution model exists
  benchmark_symbol         text not null,
  min_holding_days         int,
  max_holding_days         int,
  evaluation_horizon_days  int[] not null default array[5, 10, 20],
  max_position_pct         numeric not null default 10,  -- advisory/evaluation only; NOT wired to broker gateway
  turnover_budget_monthly  numeric,
  allowed_asset_types      text[] not null default array['equity', 'etf'],
  allowed_signal_families  text[] not null default array['momentum', 'quality', 'technical', 'sentiment', 'macro'],
  tax_sensitivity          text not null default 'medium'
                             check (tax_sensitivity in ('low', 'medium', 'high')),
  income_preference        text not null default 'none'
                             check (income_preference in ('none', 'dividend', 'growth')),
  execution_model          text not null default 'conservative_close'
                             check (execution_model in ('conservative_close', 'optimistic_close')),
  -- NOT a live-trading authorization flag. Advisory/review eligibility only.
  -- Broker gateway NEVER reads this. Live orders always require owner-click gate.
  eligible_for_live_review boolean not null default false,
  mandate_version          int not null default 1,
  active                   boolean not null default true,
  archived_at              timestamptz,
  created_at               timestamptz not null default now()
);

alter table public.investment_mandates enable row level security;
-- Deny by default; service-role routes bypass RLS. Add owner policies only when direct client reads needed.

-- Seed default mandates (maps to existing swing behavior — all existing signals default to these)
insert into public.investment_mandates
  (name, market, horizon, benchmark_symbol, min_holding_days, max_holding_days)
values
  ('Swing US 2-20d',     'us',    'swing_2_20d', 'VOO',        2, 20),
  ('Swing India 2-20d',  'india', 'swing_2_20d', 'NIFTY50.NS', 2, 20);
```

### Migration B — `strategy_evaluations` (append-only, trigger-guarded)

```sql
create table public.strategy_evaluations (
  id                       uuid primary key default gen_random_uuid(),
  mandate_id               uuid not null references public.investment_mandates(id),
  -- Snapshot of mandate AT EVALUATION TIME. Mandate rows are mutable;
  -- evaluations must be reproducible even if mandate config later changes.
  mandate_snapshot         jsonb not null,
  market                   text not null,
  evaluated_at             timestamptz not null default now(),
  evaluator_version        text not null,          -- VERCEL_GIT_COMMIT_SHA or 'local'

  -- Input dataset bounds (for idempotency detection)
  dataset_hash             text,                   -- sha256 of sorted trade IDs
  window_start             date,
  window_end               date,

  -- Trade counts (always filled)
  n_trades_total           int not null default 0,
  n_trades_evaluable       int not null default 0, -- excludes tainted + excluded_from_learning
  tainted_count            int not null default 0,
  excluded_count           int not null default 0,
  n_observations           int,                    -- decision_observations count in window

  -- Book metrics (from closed paper trades + paper NAV; whole-book Sharpe)
  -- Null when n_trades_evaluable < 20
  book_sharpe              numeric,
  book_sortino             numeric,
  book_max_drawdown        numeric,
  book_win_rate            numeric,
  book_expectancy_pct      numeric,
  book_alpha_pct           numeric,
  book_benchmark_symbol    text,
  book_cost_adjusted_return_pct numeric,
  book_slip_vs_modeled_bps numeric,

  -- Opportunity-level metrics (from decision_observations × observation_labels)
  -- Null until observation_labels for this window have matured
  opp_n_labeled            int,
  opp_hit_rate             numeric,                -- fraction of scored signals where actual beat benchmark
  opp_benchmark_neutral_expectancy numeric,        -- avg(label - benchmark_label) across observations
  opp_ic                   numeric,                -- information coefficient (score vs label rank)
  opp_t_stat               numeric,
  universe_pit_safe        boolean not null default false,  -- true only when PIT universe membership exists

  -- Walk-forward validation reference
  validation_experiment_id bigint references validation_experiments(id),
  walk_forward_folds       jsonb,  -- [{fold, start_date, end_date, n_effective, p_improvement, passed}]

  -- Display-only health flag (NOT a live-trading promotion gate)
  -- 'insufficient_sample' | 'negative_or_zero_edge' | 'promising_but_unvalidated' | 'validation_required'
  health_label             text not null default 'insufficient_sample',
  health_reason            text,

  -- FULL promotion gate (separate from health_label):
  -- Requires validation_experiments.passed=true, p_improvement, fold wins, drawdown cap,
  -- benchmark-neutral expectancy, cost-adjustment, taint ratio check.
  -- NOT implemented in P0 display layer. Wired at Learner promotion gate in P1.
  promotion_eligible       boolean not null default false,

  created_at               timestamptz not null default now()
  -- APPEND-ONLY: trigger below blocks updates/deletes
);

alter table public.strategy_evaluations enable row level security;

create index se_mandate_market_idx on public.strategy_evaluations(mandate_id, market, evaluated_at desc);

-- Append-only enforcement (same pattern as decision_observations)
create or replace function se_no_update() returns trigger language plpgsql as $$
begin raise exception 'strategy_evaluations is append-only'; end; $$;
create trigger se_no_update_trigger
  before update or delete on public.strategy_evaluations
  for each row execute function se_no_update();
```

### Migration C — `mandate_id` FK on existing tables

```sql
-- Nullable first — backfill after seed inserts before making NOT NULL
alter table public.agent_signals          add column mandate_id uuid references public.investment_mandates(id);
alter table public.paper_trades           add column mandate_id uuid references public.investment_mandates(id);
alter table public.decision_observations  add column mandate_id uuid references public.investment_mandates(id);
```

**Backfill SQL** (run after seed, before any NOT NULL constraint):
```sql
-- Assign all existing rows to the matching default mandate by market
update public.agent_signals set mandate_id = (
  select id from public.investment_mandates
  where name = case when market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and active = true limit 1
) where mandate_id is null;

-- Same for paper_trades
update public.paper_trades set mandate_id = (
  select id from public.investment_mandates
  where name = case when market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and active = true limit 1
) where mandate_id is null;

-- Same for decision_observations (market column exists since mig 059)
update public.decision_observations set mandate_id = (
  select id from public.investment_mandates
  where name = case when market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and active = true limit 1
) where mandate_id is null;
```

---

### File wiring — `mandate_id` propagation

Every boundary that creates a signal, observation, paper fill, or validation run
must read the default mandate and attach `mandate_id`. Files to update:

| File | What to change |
|---|---|
| `lib/research-agent.ts` | When inserting `agent_signals`, resolve default mandate from `investment_mandates` by market; pass `mandate_id` |
| `lib/deepseek-agent.ts` | Same — if it also inserts agent_signals or decision_observations |
| `app/api/agents/paper-trade/route.ts` | When calling paper-fill: pass `mandate_id` from linked agent_signal |
| `execute_paper_fill` RPC (migration) | Accept `mandate_id` param; write to paper_trades |
| `lib/learning/dataset.ts` → `loadLabeledDataset()` | Add optional `mandate_id` filter to JOIN |
| `lib/validation/engine.ts` | Accept optional `mandate_id`; filters observations to mandate before walk-forward |

---

### New file: `lib/evaluation/run-evaluation.ts`

Reuses all math from `lib/analytics/performance-metrics.ts`. No LLM. No weight mutation.

```typescript
import {
  navToReturns, sharpe, sortino, maxDrawdown,
  expectancy, costNet, slip, calibration
} from "@/lib/analytics/performance-metrics";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

export async function runEvaluation(mandateId: string, market: string, supabase: SupabaseClient) {
  // 1. Fetch mandate (fail closed on error)
  const { data: mandate, error: mandateErr } = await supabase
    .from("investment_mandates").select("*").eq("id", mandateId).single();
  if (mandateErr || !mandate) return { ok: false, error: mandateErr?.message ?? "mandate not found" };

  // 2. Closed, non-tainted, evaluable trades for this mandate
  //    paper_trades closes via closed_at (no status column)
  const { data: allTrades, error: tradesErr } = await supabase
    .from("paper_trades")
    .select("pnl_pct, spread_applied, realized_slip_pct, expected_price, fill_price, analyst_score, closed_at, tainted, excluded_from_learning")
    .eq("mandate_id", mandateId)
    .eq("market", market)
    .not("closed_at", "is", null);
  if (tradesErr) return { ok: false, error: tradesErr.message };

  const trades = allTrades ?? [];
  const taintedCount = trades.filter(t => t.tainted).length;
  const excludedCount = trades.filter(t => t.excluded_from_learning && !t.tainted).length;
  const evaluable = trades.filter(t => !t.tainted && !t.excluded_from_learning);

  // Dataset hash for idempotency detection (sort by closed_at so order doesn't matter)
  const tradeIds = [...trades].sort((a, b) => a.closed_at < b.closed_at ? -1 : 1).map(t => t.closed_at);
  const datasetHash = createHash("sha256").update(JSON.stringify(tradeIds)).digest("hex").slice(0, 16);
  const windowStart = trades.length ? trades.reduce((a, b) => a.closed_at < b.closed_at ? a : b).closed_at?.slice(0, 10) : null;
  const windowEnd   = trades.length ? trades.reduce((a, b) => a.closed_at > b.closed_at ? a : b).closed_at?.slice(0, 10) : null;

  // 3. NAV series for whole-book metrics (paper_performance has no mandate column)
  const { data: navRows, error: navErr } = await supabase
    .from("paper_performance")
    .select("date, nav, alpha_pct, bench_return_pct")
    .eq("market", market).order("date");
  if (navErr) return { ok: false, error: navErr.message };

  // 4. Compute book metrics (reuse existing math — do NOT reimplement)
  const returns = navToReturns((navRows ?? []).map(r => r.nav));
  // expectancy() expects rows with pnl_pct field directly
  const expM    = expectancy(evaluable);
  const sharpeM = sharpe(returns);
  const sortM   = sortino(returns);
  const maxDDM  = maxDrawdown(returns);
  const costM   = costNet(evaluable);
  const slipM   = slip(evaluable);
  // calibration() expects { predicted: 0..1, win: boolean }
  const calibM  = calibration(
    evaluable.map(t => ({ predicted: Number(t.analyst_score ?? 50) / 100, win: (t.pnl_pct ?? 0) > 0 }))
  );
  const alphaPct = (navRows ?? []).length
    ? (navRows![navRows!.length - 1].alpha_pct ?? null)
    : null;

  // 5. P0 display health label (NOT a promotion gate)
  const n = evaluable.length;
  const MIN_EVAL = 20;
  let healthLabel = "insufficient_sample";
  let healthReason = `Need ${MIN_EVAL} evaluable trades, have ${n}`;
  if (n >= MIN_EVAL) {
    if (sharpeM.insufficient || sharpeM.value <= 0) {
      healthLabel = "negative_or_zero_edge";
      healthReason = `Sharpe ${sharpeM.insufficient ? "N/A" : sharpeM.value.toFixed(2)} ≤ 0`;
    } else if (sharpeM.value < 0.5) {
      healthLabel = "promising_but_unvalidated";
      healthReason = `Sharpe ${sharpeM.value.toFixed(2)} < 0.5; run walk-forward validation`;
    } else {
      healthLabel = "validation_required";
      healthReason = `Sharpe ${sharpeM.value.toFixed(2)} ≥ 0.5; confirm with walk-forward`;
    }
  }
  // promotion_eligible requires validation_experiments.passed=true — NOT set here in P0

  // 6. Persist (append-only — never upsert)
  const { error: insertErr } = await supabase.from("strategy_evaluations").insert({
    mandate_id:               mandateId,
    mandate_snapshot:         mandate,  // snapshot mandate at evaluation time
    market,
    evaluator_version:        process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    dataset_hash:             datasetHash,
    window_start:             windowStart,
    window_end:               windowEnd,
    n_trades_total:           trades.length,
    n_trades_evaluable:       n,
    tainted_count:            taintedCount,
    excluded_count:           excludedCount,
    // Book metrics (whole-book NAV — not mandate-scoped Sharpe, document this)
    book_sharpe:              sharpeM.insufficient ? null : sharpeM.value,
    book_sortino:             sortM.insufficient ? null : sortM.value,
    book_max_drawdown:        maxDDM.insufficient ? null : maxDDM.value,
    book_win_rate:            expM.insufficient ? null : expM.winRate,  // use winRate, not value
    book_expectancy_pct:      expM.insufficient ? null : expM.value,
    book_alpha_pct:           alphaPct,
    book_benchmark_symbol:    mandate.benchmark_symbol,
    book_cost_adjusted_return_pct: costM.insufficient ? null : costM.value,
    book_slip_vs_modeled_bps: slipM.insufficient ? null : slipM.value * 10000,
    // Opportunity metrics: null until observation_labels mature (P1)
    opp_n_labeled:            null,
    opp_hit_rate:             null,
    opp_benchmark_neutral_expectancy: null,
    opp_ic:                   null,
    opp_t_stat:               null,
    universe_pit_safe:        false,  // edge_universe_members is NOT PIT-safe
    // Walk-forward: null until validation_experiments run referencing this mandate
    validation_experiment_id: null,
    walk_forward_folds:       null,
    health_label:             healthLabel,
    health_reason:            healthReason,
    promotion_eligible:       false,  // P0: never set to true here
  });
  if (insertErr) return { ok: false, error: insertErr.message };

  return {
    ok: true,
    n: trades.length,
    n_evaluable: n,
    health_label: healthLabel,
    health_reason: healthReason,
    sharpe: sharpeM,
  };
}
```

---

### New routes

**`POST /api/agents/evaluation/run`** (owner-gated, no cron access)
```typescript
// Body: { mandateId: string, market: 'us' | 'india' }
// Auth: requireOwner() — no cron secret accepted
// Calls: runEvaluation() → returns { ok, health_label, n, n_evaluable, sharpe }
// No live trading data exposed or mutated
```

**`GET /api/agents/evaluation/results`** (owner-gated)
```typescript
// Query: ?mandateId=&market=&limit=20
// Returns: strategy_evaluations rows, latest first
// Does NOT expose: mandate_snapshot (strip to keep response lean)
```

---

### UI additions to `PerformanceTruth.tsx` (additive only)

1. **Mandate selector** (top of card)
   - Dropdown from `investment_mandates` where `market = currentMarket AND active = true`
   - Default: `Swing US 2-20d` / `Swing India 2-20d`
   - Drives `?mandateId=` on existing `/api/agents/performance/metrics` call for trade metrics
   - Note label: "NAV/Sharpe is whole-book — trade metrics below are mandate-filtered"

2. **Evaluation history table** (below existing tiles)
   - Reads `GET /api/agents/evaluation/results?mandateId=&market=`
   - Columns: Date | Trades(eval/total) | Sharpe | MaxDD | Alpha | Health | WF Pass
   - "Run Evaluation" button → POST → spinner → refresh
   - Table is read-only. No edit/delete.
   - Show `universe_pit_safe` as a warning chip when false.

---

## Pass/fail gate — P0 vs promotion

**P0 (this feature):** health_label display only. Four states:
- `insufficient_sample` — n_evaluable < 20
- `negative_or_zero_edge` — Sharpe ≤ 0
- `promising_but_unvalidated` — Sharpe 0–0.5
- `validation_required` — Sharpe ≥ 0.5 (requires walk-forward to become promotion-eligible)

**Promotion gate (P1, wired at LearnerAgent):** all of:
- `validation_experiments.passed = true`
- `p_improvement` threshold met
- ≥ 3/5 folds won
- `n_effective` ≥ min by horizon
- Benchmark-neutral expectancy > 0
- Max drawdown within mandate limit
- Tainted/evaluable ratio below threshold
- No unresolved data-quality warnings

`promotion_eligible` in strategy_evaluations is always `false` in P0. Only the
LearnerAgent promotion gate (after walk-forward) sets it via a new row insert.

---

## Opportunity-level evaluation (current design gap — add to P1 scope)

P0 evaluates only closed paper trades (book truth). This is insufficient for
signal quality proof because trades are policy-selected.

The repo already has the infrastructure:
- `decision_observations` — all scored candidates (not just traded ones)
- `observation_labels` — matured forward returns
- `lib/learning/dataset.ts` — `loadLabeledDataset()` joins these
- `lib/validation/engine.ts` — walk-forward replay

**P1 addition:** populate `opp_*` columns in strategy_evaluations:
- Filter `decision_observations` by `mandate_id` and horizon window
- Join to `observation_labels` (matured only)
- Compute `opp_ic`, `opp_t_stat`, `opp_hit_rate`, `opp_benchmark_neutral_expectancy`
- Mark `universe_pit_safe: true` only when a proper PIT universe snapshot exists

---

## What NOT to do (hard constraints)

- No LLM in evaluation path — deterministic only
- Do NOT mutate `strategy_config`, money limits, or strategy weights from evaluation
- Do NOT make `mandate_id` NOT NULL until backfill verified in production
- Do NOT add `intraday` mandate — no intraday data or execution model exists
- Do NOT use `eligible_for_live_review` as a broker gateway signal — advisory label only
- Do NOT replace `validation_experiments` with `strategy_evaluations` — they serve different roles
- Do NOT call `expectancy()` with `{ returnPct }` — it expects `{ pnl_pct }`
- Do NOT call `calibration()` with `{ score, won }` — it expects `{ predicted (0-1), win }`
- Do NOT query `paper_trades` with `.eq("status", "closed")` — use `.not("closed_at", "is", null)`
- Do NOT call `requireOwnerSession()` — use `requireOwner()` from `lib/auth/require-owner.ts`
- Do NOT set `promotion_eligible = true` in P0 — reserved for P1 LearnerAgent gate

---

## P1 follow-ups (separate feature docs)

1. **Opportunity-level evaluation** — populate `opp_*` columns using `decision_observations × observation_labels` + `lib/validation/engine.ts` with mandate filter
2. **Data quality ledger** — `data_quality_log` table per (symbol, date, dimension) with source/freshness/confidence; feed into `data_confidence` on paper_trades/decision_observations
3. **Conservative paper execution model** — stale quote guard, partial fills, "would_not_fill" outcomes, market-hours check per market
4. **ResearchDecision output shape** — extend agent_signals to include `expected_return_bps`, `evidence_quality`, `missing_evidence[]`, `positive_drivers[]`, `negative_drivers[]`, `abstention_reason`

---

## Acceptance criteria

- [ ] `investment_mandates` seeded with Swing US + Swing India defaults
- [ ] All new `paper_trades` inserts get `mandate_id` from linked `agent_signals`
- [ ] All new `agent_signals` get `mandate_id` set in `lib/research-agent.ts`
- [ ] All new `decision_observations` get `mandate_id` before insert
- [ ] `runEvaluation()` uses `.not("closed_at", "is", null)` — not `status`
- [ ] `expectancy()` called with `pnl_pct` field; `book_win_rate` stored from `expM.winRate`
- [ ] `calibration()` called with `{ predicted: score/100, win: pnl_pct > 0 }`
- [ ] All Supabase errors return `{ ok: false, error: message }` — no silent failures
- [ ] `strategy_evaluations` rows never updated/deleted (trigger enforced)
- [ ] `promotion_eligible` is always `false` in P0
- [ ] `mandate_snapshot` populated with mandate row JSON at evaluation time
- [ ] `dataset_hash` populated so UI can detect duplicate/same-dataset reruns
- [ ] RLS enabled on `investment_mandates` and `strategy_evaluations` (deny by default)
- [ ] `eligible_for_live_review` NOT read by any broker gateway or order placement code
- [ ] `/api/agents/evaluation/run` uses `requireOwner()` and returns 401 without session
- [ ] PerformanceTruth.tsx shows "NAV/Sharpe is whole-book" label + mandate selector + history table
- [ ] Existing metric tiles (Sharpe/Sortino/MaxDD/Calibration) continue working unchanged
- [ ] `lib/validation/engine.ts` — NOT changed in P0; `validation_experiments` remains canonical

---

## Migration summary

| # | Table | Change | Risk |
|---|---|---|---|
| A | investment_mandates | NEW + RLS | Low — no FK deps initially |
| B | strategy_evaluations | NEW + RLS + append-only trigger | Low — no existing code reads it |
| C | agent_signals | ADD mandate_id (nullable) | Low — nullable, backfill after seed |
| C | paper_trades | ADD mandate_id (nullable) | Low — nullable |
| C | decision_observations | ADD mandate_id (nullable) | Low — trigger already blocks non-inserts |

All migrations additive. No existing columns modified. No existing behavior changed.
