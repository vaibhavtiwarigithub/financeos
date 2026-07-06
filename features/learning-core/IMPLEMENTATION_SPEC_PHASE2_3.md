# Phase 2 & 3 Implementation Spec — Validation Engine + Controlled Evolution

**Audience:** any implementing model/engineer. Follow exactly; where a detail depends on Phase-1 data shapes, read `lib/learning/dataset.ts` and `features/learning-core/IMPLEMENTATION_SPEC_PHASE1.md` first — do not invent alternative shapes.
**Precondition:** Phase 1 built + migrations 059/060 applied + ≥ ~60 matured labeled observations per market (the engine must refuse to run below its minimums, not fabricate).

---

# PHASE 2 — Validation Engine (evidence before promotion)

## 2.1 Migration `061_validation_experiments.sql`

```sql
create table if not exists validation_experiments (
  id               bigserial primary key,
  created_at       timestamptz default now(),
  market           text not null default 'us',
  challenger_id    bigint not null,             -- strategy_versions.id under test
  champion_id      bigint,                      -- strategy_versions.id compared against
  horizon_days     int not null,
  dataset_hash     text not null,               -- sha256 of ordered observation ids + label values
  n_observations   int not null,
  n_effective      numeric,                     -- overlap/cluster-adjusted effective N
  objective        text not null default 'benchmark_neutral_log_growth',
  -- results
  challenger_score numeric,                     -- objective value, challenger weights
  champion_score   numeric,                     -- objective value, champion weights
  paired_diff_mean numeric,                     -- mean per-observation objective difference
  paired_diff_ci_low numeric, paired_diff_ci_high numeric,  -- 95% block-bootstrap CI
  p_improvement    numeric,                     -- fraction of bootstrap draws where challenger > champion
  folds            jsonb,                       -- per-fold results (walkForwardFolds)
  passed           boolean not null default false,
  fail_reason      text,
  config           jsonb                        -- seeds, fold params, cost model, code_version
);
alter table validation_experiments disable row level security;
create index if not exists vexp_challenger_idx on validation_experiments(challenger_id, created_at desc);

-- strategy_versions lifecycle hardening
alter table strategy_versions add column if not exists validation_experiment_id bigint;
```

## 2.2 `lib/validation/engine.ts` — deterministic, no LLM

Exports (exact signatures):

```ts
export interface ValidationResult { passed: boolean; failReason?: string; experimentId?: number;
  challengerScore: number; championScore: number; pImprovement: number; nEffective: number; }

export async function validateChallenger(supabase: any, opts: {
  market: "us" | "india"; challengerId: number; horizonDays?: 2|5|10|20;   // default 10
}): Promise<ValidationResult>
```

Algorithm (fixed; no alternatives):
1. Load challenger + current champion `weights_snapshot` from `strategy_versions` (challenger's market). Missing champion → compare vs the static balanced profile weights.
2. `rows = await loadLabeledDataset(supabase, market, horizonDays)`. If `rows.length < 60` → `passed:false, failReason:"insufficient_data(<60)"` (record experiment anyway).
3. `folds = walkForwardFolds(rows, { folds: 5, horizonDays })`. Evaluation is SCORING-REPLAY (no refit in Phase 2): for each TEST row compute `scoreW(w, row) = Σ w_dim × row[dim_score]`; strategy return for the row = `benchmark_neutral_return` if `scoreW ≥ score_threshold` (the row's stored threshold) else `0` (not taken). Objective per fold = mean per-row `log(1 + ret)` (log-growth). Paired difference per row = challenger objective term − champion objective term.
4. Uncertainty: moving-block bootstrap over the time-ordered paired diffs, block length = `horizonDays`, 1000 resamples, seed = 42 (fixed). → CI + `p_improvement`.
5. `n_effective = n / horizonDays` (overlap adjustment — documented, simple, conservative).
6. **Pass rule (all):** `p_improvement ≥ 0.80` AND `paired_diff_ci_low > -ε` (ε = 0.0005) AND `n_effective ≥ 12` AND challenger wins ≥ 3 of 5 folds.
7. `dataset_hash = sha256(JSON.stringify(rows.map(r => [r.id, r.fwd_return])))` (node `crypto`). Insert `validation_experiments` row; update `strategy_versions.validation_experiment_id`; if passed, set challenger `state='eligible'`.

## 2.3 Promotion gate (fail-closed)

**File:** `app/api/strategies/versions/route.ts`, inside `action === "promote_champion"`, BEFORE the demote/promote writes:

```ts
// Phase 2: evidence gate. A challenger may only be promoted if a PASSED
// validation experiment is attached. Fail-closed; override requires explicit
// body.force_unvalidated === true AND is journaled.
const { data: candRow } = await supabase.from("strategy_versions")
  .select("id, market, state, validation_experiment_id").eq("id", version_id).maybeSingle();
const vId = (candRow as any)?.validation_experiment_id;
let validated = false;
if (vId) {
  const { data: vx } = await supabase.from("validation_experiments").select("passed").eq("id", vId).maybeSingle();
  validated = (vx as any)?.passed === true;
}
if (!validated && body.force_unvalidated !== true) {
  return NextResponse.json({ error: "Promotion blocked: challenger has no PASSED validation experiment. Run POST /api/validation/run first (or pass force_unvalidated:true — journaled)." }, { status: 412 });
}
if (!validated && body.force_unvalidated === true) {
  await supabase.from("decision_journal").insert({ entry_type: "governance_override",
    summary: `Champion promoted WITHOUT validation (force_unvalidated) — version ${version_id}`, resolved: true });
}
```
Resilient: if `validation_experiments` table missing (061 not applied), treat as `validated=false` only when the column `validation_experiment_id` exists; if even that column is absent (pre-061), allow legacy behavior unchanged.

## 2.4 `app/api/validation/run/route.ts`

POST; auth = cron secret or logged-in user; body `{ challenger_id, market?, horizon_days? }` → calls `validateChallenger`, returns the result. UI button on `/dashboard/strategies` ("Validate") calls it and shows pass/fail + p_improvement (small addition to the strategies page; render the numbers, no styling invention — copy existing card patterns).

## 2.5 Learner integration

In `update_signal_weight` (learner route): after the challenger insert succeeds, fire-and-forget `fetch(${NEXT_PUBLIC_APP_URL}/api/validation/run, { body: { challenger_id } })` with the cron secret header, and include in the tool result: `"validation": "queued — challenger cannot be promoted until it passes"`.

## 2.6 Promotion objective (Decision)

Objective = **mean per-observation log(1+benchmark_neutral_return) on taken signals** ("benchmark_neutral_log_growth"). Version it in `validation_experiments.objective`. Changing it requires a new PROJECT_DECISIONS entry.

## 2.7 Calibrated P(win) + sizing/exit module (second half of Phase 2)

1. `lib/validation/calibration.ts`: `fitCalibration(rows)` — logistic regression (implement plain IRLS or gradient descent in TS, no new deps; features = the 5 dim scores standardized; target = `benchmark_neutral_return > 0`) with 5-fold walk-forward calibration curve output (predicted-vs-realized decile table). Store fitted coefficients in a new `model_artifacts` table (`062_model_artifacts.sql`: id, market, kind='pwin_logistic', coefficients jsonb, fitted_at, dataset_hash, calibration jsonb).
2. `lib/risk/sizing.ts`:
```ts
// Conviction-scaled sizing. Never > halfKellyCap of pool, never < 0.
export function kellyFraction(pWin: number, payoffRatio: number): number  // (p*b - (1-p))/b
export function positionSizePct(pWin: number, payoffRatio: number, opts?: { halfKellyCap?: number /*default 0.10*/, floorPct?: number /*default 0.02*/ }): number
```
`positionSizePct` = clamp( 0.5 × kellyFraction, floorPct..halfKellyCap ) when `pWin` calibrated & payoffRatio from the pattern's median MFE/|MAE|; if no calibrated model for the market → return the legacy flat `position_size_pct` (UNCHANGED behavior).
3. PaperTrader: replace the flat `positionSizePct` ONLY when a `model_artifacts` pwin row exists for the market: compute pWin via stored coefficients, payoffRatio via median(MFE)/median(|MAE|) from `observation_labels` for that symbol's market+horizon 10 (fallback global median), size with `positionSizePct(...)`. Journal the sizing inputs in the decision_journal calculations blob.
4. Dynamic R:R (stops/targets): stop = `entry × (1 + max(MAE_p25, -0.10))` and target = `entry × (1 + min(MFE_p75, 0.40))` computed from ledger percentiles for the market (fallback = legacy profile stop/target when <30 labeled rows). Implement in PaperTrader where priceTarget/stopLoss are currently computed; keep signal-provided overrides winning.

**Phase 2 acceptance:** tsc + build clean; promotion of an unvalidated challenger returns 412; validation run writes an experiment row; with <60 labels everything degrades to legacy behavior byte-for-byte.

---

# PHASE 3 — Controlled evolution

## 3.1 Typed strategy genome — migration `063_strategy_genome.sql`
Add to `strategy_versions`: `genome jsonb` with the canonical shape:
```json
{ "features": {"included": ["fundamental","technical","sentiment","macro","insider"], "transforms": {}},
  "entry": {"score_threshold": 60, "direction": "long"},
  "universe": {"us": "screener_default", "india": "nifty100", "liquidity_min_dollar_vol": null},
  "horizon_days": 10,
  "exit": {"family": "ledger_percentile", "stop_mae_pctile": 25, "target_mfe_pctile": 75, "trail": 0.93},
  "sizing": {"mode": "half_kelly", "cap_pct": 10, "floor_pct": 2},
  "regime": {"router": "none"} }
```
Search domains (hard bounds, enforced in code): score_threshold 50–75; horizon ∈ {2,5,10,20}; stop_mae_pctile 10–40; target_mfe_pctile 60–90; cap_pct 5–15. Learner may propose a change to ONE genome field per challenger (plus weights). `validateChallenger` replays entry-threshold + horizon changes directly on the ledger (both are replayable from stored rows); exit/sizing changes validate via the labels' MAE/MFE distributions. Genome hash (`sha256(JSON.stringify(genome))`) stamped on signals (`agent_signals.genome_hash` — same migration).

## 3.2 Feature registry — migration `064_feature_registry.sql`
`feature_registry(id, name unique, spec jsonb /*rationale, formula, inputs, lag_days, expected_sign, horizon, universe, falsification_test*/, status 'proposed'|'quarantined'|'active'|'retired', proposed_by, ic_history jsonb, created_at)`. New learner tool `propose_feature(spec)` → inserts `status='proposed'`. A deterministic job (`app/api/validation/feature-check/route.ts`) computes the feature point-in-time for the last N ledger rows (only from inputs already present in `features` blob or price history), computes rolling Spearman IC vs `benchmark_neutral_return`, requires |IC|≥0.03 with p<0.1 across 2 of 3 folds to move `proposed→quarantined→active`; auto-retires actives whose rolling 60-obs IC falls below 0.01 for 3 consecutive checks. Active features append into `decision_observations.features` (namespaced `custom.<name>`) and become available to Phase-2 fits. LLM code/prose NEVER executes — the compiler only supports a whitelisted expression grammar over existing feature keys (`+ - * / log abs min max` and lags).

## 3.3 Shadow A/B — migration `065_shadow_decisions.sql`
`shadow_decisions(id, ts, market, symbol, policy_version_id, would_enter boolean, score numeric, size_pct numeric, entry_price numeric)`. In ResearchAgent, after writing the observation, loop over up to 3 `strategy_versions` in `state='shadow_paper'` for the market and record what EACH would have decided (pure scoring replay — no fills, no cash). Nightly, label-maturation also computes shadow outcomes by joining `shadow_decisions` to `observation_labels` via (symbol, ts→observation). Promotion pass-rule gains: challenger must ALSO win the paired shadow comparison over ≥ 20 shadow decisions. Exploration stays paper-only: a flag `strategy_config.exploration_enabled` (default false) lets at most ONE challenger auto-enter `shadow_paper` per week (the learner's best-validated challenger).

## 3.4 Regime conditioning
Point-in-time regime features appended to every observation (`features.regime.*`): trend (SPY/NIFTY 50d-vs-200d), realized vol (20d stdev), breadth (advancers share if available), rate proxy (10Y yield level from macro_signals). Phase-2 fit gains interaction terms `dim_score × regime_vol_bucket` (low/mid/high terciles) with strong L2 shrinkage toward the global coefficient (partial pooling: `coef_regime = coef_global + shrunk_delta`). No hard regime switches; the sizing layer may scale `cap_pct` by 0.5 in the high-vol tercile (bounded, journaled).

## 3.5 Governance rewiring
Auto-guard change (learner route): tripped guard blocks `update_signal_weight` LIVE proposals only — hypothesis writing, validation runs, and shadow research continue. Replace the win-rate trigger with: champion health = drawdown > 15% from 90d peak OR calibration drift (pwin decile table max |gap| > 0.25) OR data-availability < 60% over 10 runs.

**Phase 3 acceptance:** all additive; shadow/exploration OFF by default; genome absent → legacy scoring identical; tsc+build clean; system-map updated (SHADOW, REGISTRY, GENOME nodes); Decisions 34–36 recorded.

---

# CURRENT-APP ARCHITECTURE IMPROVEMENTS (parallel track, independent of phases)

Ranked; each is a bounded task a basic model can execute against this description.

1. **[P0] Transactional paper fills.** Review finding (accepted, deferred): fill = multiple unchecked writes. Create one Postgres RPC `execute_paper_fill(signal_id, market, qty, fill_price, ...)` (SECURITY DEFINER, migration `066`) doing claim→event→trade→position→cash in ONE transaction with `select ... for update` on the pool row; PaperTrader calls the RPC and falls back to the current JS sequence if the RPC is absent. Same for `close_paper_position`.
2. **[P1] Remaining execClaude call-sites.** ~7 non-order sites still spawn a text-completion subprocess that cannot call MCP tools (holdings/quotes/charts helpers). Replace each with direct REST (AV/FD/Yahoo) or delete if dead. Grep `execClaude(` to enumerate; port one at a time; each must keep its current output contract.
3. **[P1] agent_runs.market column.** Migration `067`: add `market text default 'us'`; write it in every agent route that inserts agent_runs (research cron already infers it — store instead of inferring); replaces the symbols-based inference in the research idempotency guard.
4. **[P2] NSE India-IP resilience.** If NSE stays geo-blocked from the US box: add `NSE_PROXY_URL` env support in `lib/nse-data.ts` (prefix all NSE calls when set). Doc-only until the user provides a proxy.
5. **[P2] India holiday calendar.** Static `lib/india-holidays.ts` (NSE holiday list, yearly update) consulted by the India cron routes to skip holidays (mirrors US_HOLIDAYS).
6. **[P2] Observability for learning.** Langfuse spans around validation runs + a `/dashboard/agents` card showing last validation experiment per market (pass/fail, p_improvement, n_effective).

**Global implementation rules for ALL of the above (repeat to any implementer):** additive + guarded (missing table/column → legacy behavior, never a crash); market is a tag; currencies never summed; no new npm deps without approval; after editing, re-read files to confirm persistence (env glitch reverts edits) and grep-verify markers before committing; `npx tsc --noEmit` and `npm run build` must pass; update system-map.json + PROJECT_DECISIONS + WORK_LOG in the same change set; migrations are handed to the user with full absolute paths for manual apply.
