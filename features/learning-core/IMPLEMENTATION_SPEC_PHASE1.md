# Phase 1 Implementation Spec — Scientific Ground Truth (decision ledger + matured labels)

**Audience:** any implementing model/engineer. Follow EXACTLY. Do not improvise, rename, "improve", or reorder. Where this doc and the code conflict, STOP and flag.
**Parent doc:** `features/learning-core/FEATURE_ARCHITECTURE.md` (approved direction; horizons 2/5/10/20d, active markets only).
**Prime rules:** additive only; US behavior byte-for-byte unchanged until data accrues; every new write is guarded (missing table/column → silent no-op + console.error, never a thrown error that fails a run); currencies never mixed; market is a tag (`us`|`india`).

---

## Step 0 — Pre-flight (do these checks first)

1. Read `lib/research-agent.ts` `processSymbol()` — confirm it has: `scores` (from `computeScores`, includes `scores.evidence`), `analystScore`, `signalDirection`, `market` variable (`"us"|"india"`), `entry` (`{symbol,isHeld,isEtf,assetClass}`), `strategy` config row, and inserts into `agent_signals` + `signal_score_history`.
2. Confirm `lib/data/scores.ts` `ComputedScores` includes `evidence: ScoreEvidence` (raw sub-features per dimension).
3. Confirm `signal_score_history` insert pattern (resilient fallback) — replicate that guard style.

## Step 1 — Migration `supabase/migrations/059_decision_observations.sql`

Create EXACTLY:

```sql
-- Phase 1 learning-core: immutable point-in-time decision ledger.
-- One row per candidate scored by ResearchAgent (filled OR rejected).
-- NEVER updated after insert. Labels live in observation_labels (060).

create table if not exists decision_observations (
  id                bigserial primary key,
  ts                timestamptz not null default now(),
  market            text not null default 'us',           -- 'us' | 'india'
  symbol            text not null,
  -- versioning / provenance
  code_version      text,                                  -- git sha or build id, nullable
  strategy_version_id bigint,                              -- FK-ish to strategy_versions.id (no hard FK; champion may be absent)
  weights_used      jsonb,                                 -- {fundamental:0.3,...} actually used this scoring
  used_champion     boolean not null default false,
  -- point-in-time features
  features          jsonb not null,                        -- computeScores().evidence blob (raw sub-features per dimension)
  availability_mask jsonb,                                 -- {fundamental:true, technical:true, sentiment:false, macro:true, insider:false}
  -- scores
  analyst_score     numeric not null,
  fundamental_score numeric, technical_score numeric, sentiment_score numeric,
  macro_score numeric, insider_score numeric,
  direction         text,                                  -- long|short|hold as scored
  -- decision
  entry_eligible    boolean not null default false,        -- analyst_score >= threshold AND direction='long'
  action            text not null default 'scored',        -- 'scored' | 'signal_written' | 'skipped_<reason>'
  score_threshold   numeric,                               -- threshold in force at decision time
  price_at_decision numeric,                               -- close/quote used at scoring time, in native currency
  currency          text not null default 'USD',
  signal_id         uuid                                    -- agent_signals.id when a signal row was written
);

alter table decision_observations disable row level security;
create index if not exists dobs_symbol_ts_idx on decision_observations(symbol, ts desc);
create index if not exists dobs_market_ts_idx on decision_observations(market, ts desc);
create index if not exists dobs_unlabeled_idx on decision_observations(ts) where signal_id is not null or entry_eligible = true;

-- Block mutation: ledger is append-only.
create or replace function dobs_block_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'decision_observations is append-only';
end $$;
drop trigger if exists dobs_no_update on decision_observations;
create trigger dobs_no_update before update or delete on decision_observations
  for each row execute function dobs_block_mutation();
```

## Step 2 — Migration `supabase/migrations/060_observation_labels.sql`

```sql
-- Phase 1 learning-core: forward-outcome labels, computed ONLY after horizon maturity.
-- Separate table so features (059) can never see the future.

create table if not exists observation_labels (
  id               bigserial primary key,
  observation_id   bigint not null references decision_observations(id) on delete cascade,
  horizon_days     int not null,                    -- 2 | 5 | 10 | 20 (trading days)
  fwd_return       numeric,                         -- (exit_px - entry_px)/entry_px, cost-adjusted
  benchmark_return numeric,                         -- same-window benchmark return (SPY for us, ^NSEI for india)
  benchmark_neutral_return numeric,                 -- fwd_return - benchmark_return
  max_adverse_excursion numeric,                    -- min((low_t - entry)/entry) over window  (<= 0)
  max_favorable_excursion numeric,                  -- max((high_t - entry)/entry) over window (>= 0)
  entry_price      numeric,                         -- price_at_decision used as entry basis
  exit_price       numeric,
  matured_at       timestamptz not null default now(),
  unique (observation_id, horizon_days)
);

alter table observation_labels disable row level security;
create index if not exists olab_obs_idx on observation_labels(observation_id);
```

Cost model constant (code, not SQL): `LABEL_COST_HAIRCUT = 0.001` (10 bps round-trip) subtracted from `fwd_return`.

## Step 3 — ResearchAgent writes observations

**File:** `lib/research-agent.ts`, inside `processSymbol()`, AFTER the `signal_score_history` insert block (keep all existing code unchanged).

Add (adapt variable names to what Step 0 confirmed — they exist today):

```ts
// Phase 1 learning-core: immutable decision observation for EVERY scored candidate
// (filled or rejected). Fail-soft: a missing table (059 not applied) must never
// fail a research run.
try {
  const availability_mask = {
    fundamental: !(scores.evidence?.fundamental as any)?.note,
    technical:   !(scores.evidence?.technical as any)?.note,
    sentiment:   !(scores.evidence?.sentiment as any)?.note,
    macro:       !(scores.evidence?.macro as any)?.note,
    insider:     !(scores.evidence?.insider as any)?.note,
  };
  const currentPriceForObs = currentPrice ?? null; // the price var already computed in processSymbol
  const { error: obsErr } = await supabase.from("decision_observations").insert({
    market,
    symbol,
    strategy_version_id: null,            // filled when champion row id is loaded; else null
    weights_used: { fundamental: fw, technical: tw, sentiment: sw, macro: mw, insider: iw },
    used_champion: usingChampion,
    features: scores.evidence ?? {},
    availability_mask,
    analyst_score: analystScore,
    fundamental_score: scores.fundamental_score,
    technical_score: scores.technical_score,
    sentiment_score: scores.sentiment_score,
    macro_score: scores.macro_score,
    insider_score: scores.insider_score,
    direction: signalDirection,
    entry_eligible: signalDirection === "long" && analystScore >= (scoreThreshold ?? 60),
    action: "signal_written",             // this code path always writes a signal today
    score_threshold: scoreThreshold ?? 60,
    price_at_decision: currentPriceForObs,
    currency: market === "india" ? "INR" : "USD",
    signal_id: null,                      // agent_signals insert doesn't return id today — leave null (Phase 2 wires it)
  });
  if (obsErr && !/does not exist|could not find/i.test(obsErr.message ?? "")) {
    console.error("[research-agent] decision_observations insert failed:", obsErr.message);
  }
} catch (e) { console.error("[research-agent] observation write threw:", e); }
```

**Rules:** do NOT move/duplicate scoring logic; do NOT make the observation write block the run; `scoreThreshold` = the same threshold variable the function already reads from `strategy` config (find its actual name in Step 0 and use it).

## Step 4 — Label maturation cron

**New file:** `app/api/agents/label-maturation/route.ts`

Contract:
- `POST`, `force-dynamic`, auth: `x-cron-secret === process.env.CRON_SECRET` OR logged-in user (copy the exact auth block from `app/api/agents/position-monitor/route.ts`).
- Optional `?market=us|india` scoping (same pattern as position-monitor).
- Algorithm:
  1. `HORIZONS = [2,5,10,20]` (trading days). Approximate trading days as calendar days ×(7/5) when checking maturity: a horizon H is *maturable* when `ts <= now() - interval (H*7/5 +1) days`.
  2. Select up to 200 `decision_observations` rows (per run, oldest first, scoped by `market` if param given) that have at least one maturable horizon missing from `observation_labels` (anti-join via `not in (select observation_id from observation_labels where horizon_days = H)` per horizon, or fetch labels for candidate ids and diff in JS — JS diff is fine).
  3. For each observation+missing-horizon:
     - Fetch daily candles from decision date → decision date + H trading days:
       - India (`symbol` ends `.NS`/`.BO`): `fetchIndiaCandles(symbol, "3mo")` from `lib/india-data.ts`.
       - US: reuse the existing price-history source the backtest uses (`price_cache` table via supabase: `select date, close, high, low from price_cache where symbol=? and date >= ? order by date asc`; if <H+1 rows, fall back to skipping this observation this run — do NOT invent prices).
     - `entry_price = price_at_decision ?? first candle close ON/AFTER ts`. If neither exists → skip.
     - Window = the first H trading-day candles strictly AFTER the entry date.
     - `exit_price` = close of the H-th candle. If fewer than H candles exist yet → not matured; skip (next run catches it).
     - `fwd_return = (exit_price - entry_price)/entry_price - 0.001` (cost haircut).
     - Benchmark: `SPY` via price_cache for us; `^NSEI` via `fetchIndiaCandles("^NSEI","3mo")` for india; same window; `benchmark_return` computed the same way WITHOUT haircut; `benchmark_neutral_return = fwd_return - benchmark_return` (null benchmark → nulls, still insert row).
     - `max_adverse_excursion = min((low_i - entry)/entry)`, `max_favorable_excursion = max((high_i - entry)/entry)` over the window (use close if high/low null).
     - Upsert into `observation_labels` with `onConflict: "observation_id,horizon_days"`.
  4. Return `{ matured: n, skipped: m, market }`.
- Fail-soft everywhere; batch candle fetches with the same ~8-parallel/300ms-pause pattern used in `app/api/scan/india/refresh/route.ts`.

**Cron registration:**
- `scripts/run-agents.ps1`: add endpoint `"label-maturation" = @{ method="POST"; url="$BASE/api/agents/label-maturation"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=300 }` (matches existing style).
- `scripts/register-tasks.ps1`: add `@{ Name="label-maturation"; Trigger=(WeekdayTrigger "6:00PM"); Agent="label-maturation" },` to `$tasks` and `"label-maturation" = 10` to `$timeLimits`.

## Step 5 — Walk-forward dataset builder

**New file:** `lib/learning/dataset.ts` (read-only; no writes)

```ts
export interface LabeledObservation { /* observation cols + the label cols for ONE horizon */ }
export interface WalkForwardFold { train: LabeledObservation[]; test: LabeledObservation[]; trainEnd: string; testEnd: string; }

// Join decision_observations × observation_labels for one market+horizon,
// ordered by ts. Only matured rows.
export async function loadLabeledDataset(supabase: any, market: "us"|"india", horizonDays: 2|5|10|20): Promise<LabeledObservation[]>

// Purged, embargoed, anchored walk-forward split.
// folds: chronological; each test window testDays long; purge = drop the last
// `horizonDays` of each train window (their labels overlap the test window);
// embargo = skip `embargoDays` (default = horizonDays) after each test window
// before the next train may include data.
export function walkForwardFolds(rows: LabeledObservation[], opts?: { folds?: number; testDays?: number; horizonDays?: number; embargoDays?: number }): WalkForwardFold[]
```

Implementation notes: pure functions; fold logic operates on the `ts` field; default `folds=5`. Unit-testable without DB (`walkForwardFolds` takes plain arrays).

## Step 6 — Learner repoint (INTERIM method, better data)

**File:** `app/api/agents/learner/route.ts`

1. `query_score_correlation`: FIRST try the ledger — load `loadLabeledDataset(svc, LEARN_MARKET, 10)`; if ≥ 10 rows, compute the same Pearson but with `x = row[dimension+"_score"]`, `y = benchmark_neutral_return ?? fwd_return`, and return `{ source: "observation_ledger", horizon_days: 10, n, correlation, interpretation, caveat: "INTERIM: univariate correlation — Phase 2 replaces with regularized multivariate walk-forward fit" }`. If < 10 ledger rows, fall back to the existing signal_id-joined paper-trades path unchanged (tag `source: "paper_trades_fallback"`).
2. `query_trade_decisions` + `semantic_search_decisions` (the 10-yr personal history): append to their returned JSON: `"role": "behavioral_evidence_only", "note": "Personal trade history is quarantined from alpha: it may inspire hypotheses but CANNOT satisfy n_trades or justify update_signal_weight."` AND in `update_signal_weight`, no change needed — `n_trades` is already gated on paper trades count; add a comment stating personal history must never feed it.
3. System prompt: add one line: `Personal trade history (query_trade_decisions/semantic_search_decisions) is BEHAVIORAL evidence only — never cite it as justification for update_signal_weight.`

## Step 7 — Docs + diagram (same change set)

1. `public/agent-diagrams/system-map.json`: add node `LEDGER` ("📒 Decision ledger\ndecision_observations + labels") with edges `RESEARCH --> LEDGER` and `LEDGER --> LEARNER`; append history entry. Validate JSON with `node -e "JSON.parse(...)"`.
2. `PROJECT_DECISIONS.md`: Decision 33 (template as prior decisions) — "Point-in-time decision ledger + matured horizon labels (Phase 1 learning-core)".
3. `WORK_LOG.md`: dated entry.
4. `features/learning-core/FEATURE_ARCHITECTURE.md`: flip Phase 1 status to "built, pending migration apply".

## Step 8 — Acceptance checks (must all pass before commit)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → compiles.
2b. Unit tests (vitest — see improvement 1c in IMPLEMENTATION_SPEC_PHASE2_3.md): `walkForwardFolds` purge/embargo property (no train label-window overlaps its test window) + label math (fwd_return/MAE/MFE) on a hand-built candle fixture. `npm run test` → pass.
3. Grep-verify (env glitch guard): `grep -c decision_observations lib/research-agent.ts` ≥ 1; `ls app/api/agents/label-maturation/route.ts`; `grep -c label-maturation scripts/run-agents.ps1 scripts/register-tasks.ps1` ≥ 1 each; `grep -c observation_ledger app/api/agents/learner/route.ts` ≥ 1.
4. WITHOUT migrations applied, `POST /api/agents/research/cron?market=us` must behave exactly as before (observation insert fails soft).
5. Hand the user: full paths of `059_decision_observations.sql` + `060_observation_labels.sql` to run in the Supabase SQL editor, and note to re-run `register-tasks.ps1`.

**Explicitly OUT of scope for Phase 1:** any change to scoring math, weights, promotion, sizing, exits, or UI. No new npm dependencies.
