# Scoring Methodology — Implementation Plan

**Created:** 2026-07-10  
**Status:** Architecture-verification only — NO code changes  
**Reviewer:** Claude Sonnet 4.6  
**Source docs read:** FEATURE_ARCHITECTURE.md (scoring), CODEX_SCORING_METHODOLOGY_REVIEW_RESULT.md, docs/arch/03-agents.md, docs/arch/08-risk-and-safety.md, lib/scoring/weighted-score.ts, lib/validation/calibration.ts, lib/validation/engine.ts, lib/deepseek-agent.ts, app/api/agents/paper-trade/route.ts, supabase/migrations/ (001–135)

---

## Section 1 — Architecture-to-code gap analysis by phase

### P0 — Provenance safety (no formula change)

**Architecture requirement:** Tag current ResearchAgent rows `score_source='deterministic_v1'`; DeepSeek rows `score_source='llm_advisory'`; PaperTrader explicitly requires a deterministic version; TraderAgent requires `live_approved`; direction gate replaces LLM direction for new entries.

| Item | Current code | Gap | Severity |
|---|---|---|---|
| `score_source` column on `agent_signals` | MISSING — no migration adds this column. Not present in migrations 001–135. | Column must be added via migration before any code uses it. | BLOCKER |
| `scoring_version` column on `agent_signals` | MISSING — not in any migration | Must be added in same migration as `score_source` | BLOCKER |
| DeepSeek structural exclusion from PaperTrader | PARTIAL: `lib/deepseek-agent.ts` writes `status='advisory'` (line 197). `app/api/agents/paper-trade/route.ts` filters `.eq("status","pending")` (line 148). DeepSeek signals with `status='advisory'` are already excluded by the status filter. | No `score_source` structural filter exists yet. The exclusion relies solely on `status`. If the DeepSeek route or any future caller accidentally writes `status='pending'`, it would be consumable. A `score_source != 'llm_advisory'` filter in PaperTrader is the structural safeguard. | HIGH |
| PaperTrader `score_source` gate | MISSING — PaperTrader queries `status='pending' AND direction='long' AND analyst_score >= threshold` (route.ts lines 147–153). No `score_source` or `scoring_version` filter. | Must add `.eq("score_source","deterministic_v1")` (or approved list) to the signal SELECT. Requires `score_source` column to exist first. | BLOCKER |
| TraderAgent `live_approved` lifecycle gate | MISSING — `app/api/agents/trader/route.ts` selects signals by `analyst_score >= threshold` and status checks. No lifecycle gate. The `live_approved` state does not exist in the current `strategy_versions.state` constraint (see Section 1 / lifecycle gap below). | Both the column and the gate in trader/route.ts are needed. | BLOCKER |
| Mechanical direction gate | MISSING — Direction is still LLM-controlled for normal (non-thin-evidence) cases. `processSymbol()` in `lib/research-agent.ts` calls the LLM and reads direction from the thesis response. The only deterministic override is `direction: "neutral"` when `isThinEvidence()` is true (< 2 dims) or LLM parse fails. | Direction for new positions must be a deterministic output of score/evidence/contradiction gates. LLM may only issue a bounded structured veto. | HIGH |
| `score_source`/`scoring_version` on `decision_observations` | MISSING — Migration 059 defines `decision_observations` with no `score_source`, `scoring_version`, `setup_type`, `rank_score`, `final_score`, `evidence_confidence`, `contradiction_penalty` columns. | These columns are required for canonical PIT snapshots in P0. Must be added as nullable with a migration. | HIGH |
| P0 changes affect money movement | YES — PaperTrader signal selection and TraderAgent live eligibility are directly affected. | — |

---

### P1 — Measure-only feature/universe snapshots

**Architecture requirement:** PIT universe snapshot; feature computation with corporate-action adjustment, source timestamps; canonical snapshots in `decision_observations.features`. No change to paper/live selection.

| Item | Current code | Gap | Severity |
|---|---|---|---|
| Universe snapshot persistence | MISSING — no `universe_snapshots` table in any migration 001–135. `agent_signals` has no `universe_snapshot_id` FK. | New table + FK needed. | HIGH |
| Feature snapshot in `decision_observations.features` | PARTIAL — `features jsonb not null` exists (migration 059). It receives `computeScores().evidence` blob from ResearchAgent. The blob does NOT conform to the `ScoringFeatureSnapshot` contract (no `schemaVersion`, `assetType`, `decisionTs`, `universeSnapshotId`, `sourcePayloadHashes`, per-feature `{value, state, source, observedAt, availableAt, retrievedAt}`). | Feature blob needs structural upgrade but must be done additively — the existing blob format is still useful; do not delete it. | MED |
| Corporate action adjustment | MISSING — no dividend/split adjustment on candles. Alpha Vantage `TIME_SERIES_DAILY_ADJUSTED` is available but not guaranteed to be used for scoring. India Yahoo candles may be adjusted depending on the query. | Must verify and document in data provider matrix before P1 ships. | MED |
| Comparable-universe rank | MISSING — no cross-sectional rank computation exists. Three daily finalists are not a valid reference universe as the architecture states. | Universe group computation and percentile ranking not yet built. | HIGH |
| P1 affects money movement | NO — measure-only by definition |

---

### P2 — Shadow setup experts

**Architecture requirement:** Implement pure scorers and deterministic router; persist shadow expert scores; only v1 remains actionable; IC/stability/cost analysis.

| Item | Current code | Gap | Severity |
|---|---|---|---|
| Setup archetypes (`quality_momentum`, `value_inflection`, `post_earnings_drift`, `etf_trend`, `india_quality_momentum`, `india_sector_rotation`) | MISSING — current scorer is a single universal 5-dimension linear blend (`computeWeightedAnalystScore`). No router. | All 6 archetypes need implementation. | HIGH |
| `shadow_decisions` table | EXISTS (migration 065). Records `would_enter`, `score`, `size_pct`, `entry_price` per `policy_version_id`. | Compatible with P2 shadow scoring, but `setup_type` column is missing from `shadow_decisions`. | MED |
| ETF pipeline separation | MISSING — ETFs enter the same `fundamental_score/insider_score` pipeline, receiving neutral 50 for structurally inapplicable dimensions despite migration 032 adding `asset_class` column. | `asset_class='etf'` must route to ETF-specific scorer in P2. | HIGH |
| P2 affects money movement | NO — v1 remains the only actionable signal |

---

### P3 — OOF calibration and expected return

**Architecture requirement:** Fix calibration leakage; fit regularized baseline models per setup/market when sample gates pass; store OOF predictions.

| Item | Current code | Gap | Severity |
|---|---|---|---|
| Calibration leakage | CONFIRMED — `lib/validation/calibration.ts` `fitCalibration()` (lines 82–90): `standardize(rows)` computes means/stdevs from ALL rows (train+test combined), `fitLogistic(X, y)` fits on ALL rows. The walk-forward fold loop (lines 93–101) then calls `predictPWin(coefficients, row)` using the SAME coefficients fitted on all data. Test-set rows were used in both mean/stdev computation and coefficient fitting. This is leakage — the calibration curve is optimistic. Architecture §10 correctly identifies this and requires per-fold fits. | Must replace `fitCalibration()` with a per-fold implementation. Production model fitted only after OOF metrics pass. | BLOCKER |
| Sample gate | CURRENT: `if (rows.length < 60) return null` (line 80). Architecture requires 250+ labeled rows, 50+ effective horizon blocks, 20+ positives and negatives per parameter family. | Threshold must be raised. Current 60-row gate is too permissive for a 5-parameter logistic model. | HIGH |
| OOF prediction storage | MISSING — no schema for per-observation OOF predictions in `model_artifacts` or `observation_labels`. | Need a column or separate table for OOF predictions. | MED |
| P3 affects money movement | YES — `predictPWin` is consumed by `predictPWin` call in paper-trade/route.ts for Kelly sizing. A leaky model may over-size positions. |

---

### P4 — Paper champion/challenger

**Architecture requirement:** Owner promotes v2 to `paper_active`; shadow v1 and v2 on same opportunity set; UI explains features, data quality, comparable group, abstentions.

| Item | Current code | Gap | Severity |
|---|---|---|---|
| Version lifecycle states `measure_only`, `live_review_eligible`, `live_approved` | MISSING — current constraint (migration 065) allows: `'draft','testing','rejected','paper_candidate','paper_active','paper_paused','eligible','approved_live','live_paused','retired','shadow_paper'`. Architecture requires `'measure_only'`, `'shadow_paper'` (EXISTS), `'paper_active'` (EXISTS), `'live_review_eligible'`, `'live_approved'`. Note: current DB has `'approved_live'`, NOT `'live_approved'` — all architecture docs use `'live_approved'`. This inconsistency must be resolved in a migration before any gate reads the string. | Migration needed to add `measure_only`, `live_review_eligible`, `live_approved` to the CHECK constraint. Decision needed on whether to rename `approved_live` to `live_approved` or add it as an alias. This BLOCKS P4. | BLOCKER |
| `paper_active` lifecycle consumed by PaperTrader | MISSING — PaperTrader does not currently filter on `strategy_versions.state = 'paper_active'`. It relies on the `agent_signals.status='pending'` filter alone. | Architecture requires PaperTrader to verify the scoring strategy version is `paper_active` before filling. | HIGH |
| P4 affects money movement | YES — PaperTrader paper fill behavior changes |

---

### P5 — Live review

**Architecture requirement:** OOF/paper evidence, stable performance, acceptable drawdown/turnover, no data-integrity alerts, owner promotion to `live_approved`, signal eligible only (risk/execution gates still apply).

| Item | Current code | Gap | Severity |
|---|---|---|---|
| `live_approved` lifecycle state | MISSING — see P4 lifecycle gap above | BLOCKER (inherited) |
| TraderAgent reads `live_approved` gate | MISSING — no lifecycle check in `app/api/agents/trader/route.ts` | Must be added | HIGH |
| Execution Gateway `live_approved` gate | PARTIAL — `app/api/broker/orders/route.ts` checks `quality_status` via `v_decision_quality` (migration 104) and autonomy_level, but does not check `strategy_versions.state = 'live_approved'` | Must be added to gateway | HIGH |
| P5 affects money movement | YES — live order eligibility |

---

## Section 2 — Non-negotiable corrections from Codex review

### Finding 1 — DeepSeek `analyst_score` structural exclusion

**Current gap:**
- `lib/deepseek-agent.ts` generates `analyst_score` via LLM (line 100–105) and writes it to `agent_signals` with `status='advisory'` (line 197).
- PaperTrader filters `status='pending'` only — DeepSeek rows are currently excluded by status, not structure.
- No `score_source` column exists on `agent_signals` to provide structural exclusion.

**Fix required (P0):**
1. Migration: add `score_source text` (nullable, then constrained to `'deterministic_v1'|'deterministic_v2'|'llm_advisory'`) to `agent_signals`.
2. ResearchAgent writes `score_source='deterministic_v1'` on every insert.
3. DeepSeek route writes `score_source='llm_advisory'`.
4. PaperTrader adds `.neq("score_source","llm_advisory")` (or `.in("score_source",["deterministic_v1","deterministic_v2"])` once v2 exists) to its signal SELECT.
5. TraderAgent adds the same filter.

---

### Finding 2 — Evidence confidence denominator math

**Architecture requires:**
```
denominator = Σ w_f for f ∈ A_s  (structurally applicable base weights)
numerator   = Σ w_f for f ∈ A_s where state(f) = ok and freshness passes
```

**Current behavior in `lib/scoring/weighted-score.ts`:**
- `computeWeightedAnalystScore()` renormalizes base weights of INCLUDED dims to sum to 1 (lines 37–47). 
- This is effectively `effWeights[k] = baseWeights[k] / Σ(baseWeights[includedDims])`.
- There is NO separate `evidenceConfidence` output — the function returns only `{score, effWeights, renormalized, includedDims}`.
- `isThinEvidence()` returns true when `includedDims.length < 2` (line 61).

**Gap:**
1. The function does NOT compute `data_confidence = numerator / denominator` using structural applicable weights as denominator. It renormalizes weights instead.
2. `inapplicable`, `degraded`, `stale`, `provider_failed` states are not tracked as distinct data quality states — they are all treated as "not included".
3. There is no `evidenceConfidence: number` (0–1) computed and returned for use as a hard gate.
4. `v_decision_quality` (migration 104) computes `data_confidence` and `quality_status` but the logic there may not align with the architecture's formula (needs verification against migration 104 SQL).

**Fix required (P0/P1):**
1. `computeWeightedAnalystScore` must be extended or replaced with a function that also computes `evidenceConfidence` using the correct denominator.
2. `DataState` taxonomy (`ok|inapplicable|missing|stale|provider_failed|degraded`) must be threaded through from provider layer.

---

### Finding 3 — Direction gate

**Current state:** LLM is the ONLY direction gate for normal signals. `processSymbol()` forces `direction:"neutral"` only when `isThinEvidence()` OR LLM parse fails (added per WORK_LOG 2026-07-06). For all other cases (score passes, 2+ dimensions included), direction is whatever the LLM returns.

**Architecture requires:** Direction is purely deterministic: new positions are `long_candidate` when score/setup/evidence/contradiction gates pass; otherwise `watch` or `abstain`. LLM issues only a structured veto with `{vetoed, category, citedEvidenceIds}`.

**Fix required (P0):**
1. Add deterministic direction logic: `if (analystScore >= threshold && evidenceConfidence >= 0.60 && !thinEvidence) direction = "long"` else `direction = "neutral"`.
2. LLM veto schema must be added: `llm_veto: {vetoed: boolean, category?: string, citedEvidenceIds?: string[]}`. A valid veto can only downgrade `long → watch`.
3. Exit signals for held positions remain a separate path (exempted from this gate per CLAUDE.md locked rule).

---

### Finding 4 — Calibration leakage in `lib/validation/calibration.ts`

**Exact current behavior (confirmed):**
- Line 82: `standardize(rows)` — means/stdevs computed from ALL rows.
- Line 83: `X = rows.map(r => DIMS.map(dim => ((r[dim] ?? 50) - means[dim]) / stdevs[dim]))` — all rows standardized with full-dataset statistics.
- Lines 86–88: `fitLogistic(X, y)` — fitted on ALL rows.
- Lines 93–101: Walk-forward folds iterate test rows and call `predictPWin(coefficients, row)` — but `coefficients` was fitted on all data including those test rows. This is in-sample scoring of the calibration curve.

**Correct behavior required (P3):**
```typescript
for (const fold of folds) {
  const { means, stdevs } = standardize(fold.train);  // ONLY train
  const X_train = fold.train.map(r => DIMS.map(dim => ...));
  const y_train = fold.train.map(r => ...);
  const { intercept, coefs } = fitLogistic(X_train, y_train);
  // Predict on fold.test using ONLY fold-specific means/stdevs/coefs
  for (const row of fold.test) { ... }
}
// Final production model: fit on ALL data (for inference only, not calibration)
```

**Severity:** BLOCKER for P3. The calibration curve produced by current code is optimistic — it will show better reliability than reality. This would corrupt Kelly sizing if the model is activated.

---

### Finding 5 — Scoring version lifecycle

**Current `strategy_versions.state` constraint (migration 065):**
```
'draft','testing','rejected','paper_candidate','paper_active','paper_paused',
'eligible','approved_live','live_paused','retired','shadow_paper'
```

**Architecture target lifecycle:**
```
draft → measure_only → shadow_paper → paper_active → live_review_eligible → live_approved → retired
```

**Gap:**
- `measure_only` — does NOT exist in constraint. Must be added.
- `live_review_eligible` — does NOT exist. Must be added.
- `live_approved` — does NOT exist. DB has `approved_live` (different string). ALL architecture docs and safety gates use `live_approved`. **Must add `live_approved` to the constraint.** Decision needed on `approved_live`: keep it for legacy rows, add `live_approved` as the new canonical value.
- `paper_candidate`, `eligible`, `approved_live`, `live_paused` are in the DB but not in the architecture target. Do NOT remove them in migrations (existing rows use them); add new values additively.
- Code that reads lifecycle state must use the exact DB string, not a documentation alias.

---

### Finding 6 — `decision_observations.features` as canonical snapshot

**Current state:**
- `decision_observations.features jsonb not null` EXISTS (migration 059).
- It IS populated by ResearchAgent with `computeScores().evidence` blob.
- The blob contains per-dimension sub-features but does NOT conform to `ScoringFeatureSnapshot` interface (no `schemaVersion`, `assetType`, `decisionTs`, `universeSnapshotId`, `sourcePayloadHashes`, or per-feature `{value, state, source, observedAt, availableAt, retrievedAt}`).
- Summary columns `score_source`, `scoring_version`, `setup_type`, `rank_score`, `final_score`, `evidence_confidence`, `contradiction_penalty`, `p_win`, `expected_return_bps`, `universe_snapshot_id` do NOT exist on `decision_observations`.

**Fix required (P0/P1):**
Migration to add missing summary columns to `decision_observations` (all nullable, NOT VALID constraints):
- `score_source text`
- `scoring_version text`
- `setup_type text`
- `rank_score numeric`
- `final_score numeric`
- `evidence_confidence numeric`
- `contradiction_penalty numeric`
- `p_win numeric`
- `expected_return_bps numeric`
- `universe_snapshot_id bigint`

The existing `features` blob must NOT be replaced — it is the canonical v1 snapshot. New fields augment it.

---

## Section 3 — Next migration number

**Last committed migration:** `135_mandate_id_fk.sql`

**Note:** There is a naming collision at 113: both `113_broker_orders_kite_gtt.sql` and `113_agent_config_prompt_versioning.sql` exist. This is an existing problem — do not create another `113_*` file.

**Next available migration number: 136**

All P0 migrations should start at `136_*`.

---

## Section 4 — Dependency-ordered build sequence

### Step 1 — Schema foundation (migration 136)

**What changes:** Add `score_source`, `scoring_version` to `agent_signals`; add `score_source`, `scoring_version`, `setup_type`, `rank_score`, `final_score`, `evidence_confidence`, `contradiction_penalty`, `p_win`, `expected_return_bps`, `universe_snapshot_id` to `decision_observations` (all nullable, `NOT VALID` range checks for numeric columns); add `measure_only`, `live_review_eligible`, `live_approved` to `strategy_versions.state` constraint.

**Files affected:** `supabase/migrations/136_scoring_p0_schema.sql` (new)

**Tests:** Verify all three tables accept the new columns; verify `strategy_versions` constraint accepts new state values; verify existing rows are unaffected.

**Rollback:** Drop new columns (no data loss if migration runs before code); alter constraint back.

**Money movement:** NO — schema-only, no routing changes.

---

### Step 2 — ResearchAgent score_source tag (P0, code)

**What changes:** `lib/research-agent.ts` `processSymbol()` writes `score_source:'deterministic_v1'`, `scoring_version:'v1.0'` on every `agent_signals` insert and `decision_observations` insert. Requires Step 1 migration to be applied.

**Files affected:** `lib/research-agent.ts`

**Tests:** Unit test that `agent_signals` insert payload includes `score_source='deterministic_v1'`; integration smoke run confirms `decision_observations.score_source` is populated.

**Rollback:** Remove the two new fields from the insert payload (columns remain, rows get `null`).

**Money movement:** NO — tagging only, does not change signal values or selection.

---

### Step 3 — DeepSeek score_source tag (P0, code)

**What changes:** `lib/deepseek-agent.ts` writes `score_source:'llm_advisory'` on `agent_signals` insert. Already writes `status:'advisory'` — this adds structural reinforcement.

**Files affected:** `lib/deepseek-agent.ts`

**Tests:** Verify `agent_signals` rows from DeepSeek route have both `status='advisory'` AND `score_source='llm_advisory'`.

**Rollback:** Remove field from insert payload.

**Money movement:** NO — tagging only.

---

### Step 4 — PaperTrader structural exclusion gate (P0, code)

**What changes:** `app/api/agents/paper-trade/route.ts` signal SELECT (lines 147–153) adds `.neq("score_source","llm_advisory")` filter (or positive allowlist once more sources exist). Requires Steps 1–3.

**Files affected:** `app/api/agents/paper-trade/route.ts`

**Tests:** Integration test: insert a fake `status='pending'` signal with `score_source='llm_advisory'`; verify PaperTrader does NOT fill it. Insert same with `score_source='deterministic_v1'`; verify it IS a candidate.

**Rollback:** Remove the `.neq()` filter. Behavior degrades to status-only exclusion (still safe because DeepSeek writes `status='advisory'`).

**Money movement:** YES — paper fill selection changes. Low risk (existing DeepSeek signals already excluded by status).

---

### Step 5 — Mechanical direction gate (P0, code)

**What changes:** `lib/research-agent.ts` `processSymbol()` computes direction deterministically from `analystScore`, `evidenceConfidence`, and thin-evidence gate BEFORE calling the LLM. LLM call becomes explanation-only. Add `llm_veto` jsonb field to `agent_signals` for structured veto storage.

**Files affected:** `lib/research-agent.ts`; `supabase/migrations/137_agent_signals_llm_veto.sql` (new — adds `llm_veto jsonb` column to `agent_signals`)

**Tests:** Test that a signal with score >= threshold, evidenceConfidence >= 0.60, thin_evidence=false gets `direction='long'` regardless of LLM response; test that LLM-vetoed long is downgraded to `watch` only.

**Rollback:** Remove direction gate logic and restore LLM direction reading. HIGH RISK — removes a safeguard, requires human review.

**Money movement:** YES — paper fill directions may change. Must run in shadow for at least one week before promoting.

---

### Step 6 — OOF calibration fix (P3, code)

**What changes:** `lib/validation/calibration.ts` `fitCalibration()` replaced with per-fold implementation (fits means/stdevs/coefficients on `fold.train` only; uses those fold-specific params to predict `fold.test`). Production model fit from full dataset stored separately for inference.

**Files affected:** `lib/validation/calibration.ts`

**Tests:** Verify that OOF calibration curve Brier score is worse than (or equal to) the current leaky curve — if OOF is better, something is wrong. Unit test: single fold, verify `predictPWin` on test rows uses only train statistics.

**Rollback:** Restore old implementation (but do NOT activate for sizing until P3 evidence requirements are met).

**Money movement:** INDIRECT — affects Kelly sizing via `predictPWin`. Do not activate for sizing until evidence gates pass.

---

### Step 7 — Strategy lifecycle states (migration 136 extension)

Already covered in Step 1. Verify that `live_approved` and `measure_only` are in the constraint before P4/P5 code is written.

---

## Section 5 — RLS/grants/security concerns

| Concern | Table/Function | Current state | Required fix | Severity |
|---|---|---|---|---|
| `decision_observations` append-only trigger | `dobs_block_mutation` (migration 059) | EXISTS and fires on UPDATE/DELETE | New nullable columns added in migration 136 must not break the trigger (INSERT is still allowed; trigger only blocks UPDATE/DELETE). | LOW |
| `agent_signals` RLS | `agent_signals` | `alter table agent_signals disable row level security` (migration 002). Direct service-client access only. | Verify that no new `score_source` / `scoring_version` route uses the anon client — service client only. | MED |
| `strategy_versions` RLS | `strategy_versions` | RLS disabled (migration 036). | No change needed now. When lifecycle-gate code reads `state='live_approved'`, confirm the query uses service client (cron/agent paths) or owner-gated routes. | LOW |
| `model_artifacts` table | `model_artifacts` (migration 062) | RLS status not verified in this review | Verify RLS is not accidentally exposed to anon/authenticated roles since it contains calibrated model coefficients. | MED |
| New `universe_snapshot_id` FK on `decision_observations` | `decision_observations` | Append-only trigger exists | If `universe_snapshots` table is added in P1, the FK on `decision_observations` must reference it as a nullable FK-by-value (not a hard FK enforced on append) to avoid breaking the append-only trigger. | MED |
| Migration 113 naming collision | `supabase/migrations/` | TWO files named `113_*.sql` — `113_broker_orders_kite_gtt.sql` and `113_agent_config_prompt_versioning.sql` | This is a pre-existing problem. Supabase applies migrations alphabetically within the same prefix number. Verify both applied correctly. Do not create another `113_*`. | HIGH — pre-existing |

