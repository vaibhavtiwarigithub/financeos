# Learning Integrity - Taint Detection, Exclusion & Learner Recovery

**Status:** DRAFT - awaiting approval. No implementation code until approved.
**Author:** Claude (Opus 4.8), reviewed/updated by ChatGPT, 2026-07-08.
**Decision inputs (user, 2026-07-08):**
- Primary mechanism: **tag + exclude** (non-destructive; deletion optional).
- Auto-taint threshold: **moderate** (`data_confidence < 0.5`) - conditional on a proven-correct, deterministic confidence calculation.
- Scope now: **architecture draft only**.

---

## 1. Problem

The research scorer can emit a high-conviction signal from partial data - for example,
GLD/SGOV/IBIT on 2026-07-07 scored high while the logged evidence showed missing
fundamentals, zero technical candles, and unknown macro. The weighted score then
renormalized onto the dimensions that happened to be present.

Those decisions can flow into paper/live books and, after outcomes mature, into the
LearnerAgent and Validation Engine. Bad data can therefore become bad trades, bad
labels, and bad strategy mutations.

We need:

1. A deterministic way to detect low-evidence decisions from already-logged facts.
2. A non-destructive way to stop them polluting learning and validation datasets.
3. A recovery path if a bad learner mutation still lands.
4. A reusable, safe teardown path to replace ad-hoc manual SQL cleanup.

## 2. Non-goals

- No re-fetching or re-scoring historical decisions.
- No live trading-path dependency on this layer.
- No auto-delete by default; delete/reset remains manual, backed up, and dry-run-gated.
- No implementation code until Vaibhav approves this architecture.

---

## 3. Existing primitives to reuse

| Need | Existing table/column |
|---|---|
| Per-decision evidence | `decision_observations`: append-only; `availability_mask` jsonb, `features` jsonb (`weighting.{base_weights,applied_weights,included_dims}`), `weights_used`, `signal_id` |
| Forward labels | `observation_labels`: `observation_id`, horizon returns, MAE/MFE |
| Versioned strategies / rollback | `strategy_versions`: `weights_snapshot`, `genome`, `is_champion`, `parent_version_id`, `promoted_at`, `retired_at`, `state`, `rejection_reason` |
| Prior history | `learning_priors_history`: `prior_id`, `confidence`, `enabled`, `reason`, `changed_by`, `changed_at` |
| Shadow / challenger eval | `shadow_decisions`: `observation_id`, `policy_version_id`, `would_enter`, `score` |
| Paper trade to decision link | `paper_trades.signal_id` -> `decision_observations.signal_id` |
| Live order to decision link | `broker_orders.proposal_id` -> `trade_proposals.id` -> `trade_proposals.signal_id` -> `decision_observations.signal_id` |

### Current schema constraints that matter

- `decision_observations.id` is `bigserial`.
- `decision_observations.signal_id` is `uuid`.
- `paper_trades.signal_id` is `uuid`.
- `broker_orders` currently has no `signal_id`; live quality must join through `proposal_id`.
- `trade_proposals.signal_id` is currently declared as `bigint` in migration 037. It must be migrated to `uuid` before live-order taint joins are trusted.
- `decision_observations` is append-only by trigger; do not add mutable taint columns there.
- `observation_labels` and `shadow_decisions` reference `decision_observations(id)` with `on delete cascade`; the reset/teardown feature must never delete `decision_observations`.
- Any code that reads new quality/tag columns must ship only after the additive migration is applied. No schema-coupled runtime fallback should silently treat missing columns as "clean."

Implication: rollback is a strategy-version pointer operation, not data surgery. The
taint layer should be a thin additive layer over mutable trade/order projections plus
a deterministic view over the immutable observation ledger.

---

## 4. Design

### 4.1 `v_decision_quality` - deterministic quality view

Create a read-only SQL view `v_decision_quality` over `decision_observations`.
It must not mutate the append-only ledger. It covers both historical and future rows.

Concept:

```text
applicable_dims    = structural scoring dims derived from the logged row only
applicable_weight  = sum(base_weights[d]) for d in applicable_dims
real_dims          = dims in applicable_dims where availability_mask[d]=true and dim is not degraded
available_weight   = sum(base_weights[d]) for d in real_dims
data_confidence    = available_weight / applicable_weight
```

Use `features.weighting.base_weights` for `base_weights`.
Do **not** use `weights_used` or `features.weighting.applied_weights` as the denominator;
those are post-renormalization weights and can make a one-dimension decision look fully
covered.

The view must not call or guess the TypeScript `applicableDimensions()` function. It
has to derive structural applicability from values already logged in
`decision_observations`:

- `market = 'india'`: applicable scoring dims are `fundamental`, `technical`, `macro`.
- `features.fundamental.is_etf = true`: applicable scoring dims are `technical`, `sentiment`, `macro`.
- US non-ETF: applicable scoring dims are `fundamental`, `technical`, `sentiment`, `macro`, `insider`.
- US ADR insider exclusion is not reliably reconstructable from current rows unless a structured flag is logged. Until then, if `availability_mask.insider=false` and the symbol is in a small reviewed ADR allowlist, the SQL view may exclude insider; otherwise set `quality_status='unknown'` rather than pretending certainty.
- If `applicable_weight <= 0`, malformed base weights, or a missing base-weight key would affect the denominator, emit `data_confidence=NULL` and `quality_status='unknown'`; never divide by applied/renormalized weights as a fallback.

The view emits:

- `observation_id`
- `signal_id`
- `market`
- `symbol`
- `applicable_dims text[]`
- `real_dims text[]`
- `missing_dims text[]`
- `degraded_dims text[]`
- `decisive_dim text`
- `data_confidence numeric`
- `confidence_band text` (`high >= 0.75`, `med >= 0.5 and < 0.75`, `low < 0.5`)
- `quality_status text` (`ok` or `unknown`)
- `taint_reason text`

### 4.2 Degraded-dimension rules

A dimension is degraded when it is technically present but not real evidence.

Historical fallback rules:

- `fundamental`: evidence note contains "No fundamental data available" or provider/rate-limit text. ETF "no company fundamentals" is structural, not degraded.
- `macro`: `features.macro.regime = 'unknown'`.
- `technical`: `features.technical.dataPoints < 15`.
- `sentiment`: no provider-backed basis, e.g. bullish/bearish both absent/zero and no AV/news sentiment.
- `insider`: unavailable/too few transactions text or `availability_mask.insider=false`.

String matching is a historical bridge only. For future rows, ResearchAgent should log
a structured quality object:

```json
{
  "quality": {
    "fundamental": { "state": "ok|missing|degraded|inapplicable", "reason": "..." },
    "technical":   { "state": "ok|missing|degraded|inapplicable", "reason": "..." },
    "sentiment":   { "state": "ok|missing|degraded|inapplicable", "reason": "..." },
    "macro":       { "state": "ok|missing|degraded|inapplicable", "reason": "..." },
    "insider":     { "state": "ok|missing|degraded|inapplicable", "reason": "..." }
  }
}
```

`v_decision_quality` should prefer `features.quality` and fall back to legacy string
heuristics only for older rows.

### 4.3 Correctness requirements

These are acceptance criteria:

1. **Pure / no I/O.** The quality calculation reads only database columns. No network, LLM, live prices, or provider calls.
2. **Reads logged weights.** It uses `features.weighting.base_weights` and the scorer's own logged evidence. It does not reconstruct live state from current config.
3. **Two-stage fail behavior.**
   - During measure-only rollout, malformed/missing `weighting`, `availability_mask`, or structural inputs produce `data_confidence = NULL`, `quality_status='unknown'`, and no automatic taint write.
   - After golden tests and historical flag-rate checks pass, learner and validation datasets must require `quality_status='ok'` and `excluded_from_learning=false`. Unknown quality is not proof of bad data, but it is also not safe training evidence.
4. **Trading path stays independent.** Order submission and portfolio code must not depend on this layer to place orders. This layer can tag, explain, and filter learning; it cannot be a new order-execution gate unless separately approved.
5. **Flag != exclude.** Computed confidence and mutable exclusion are distinct. A bad flag is reversible by owner override.
6. **Golden tests + monitor.** Unit/golden tests assert worked examples against real or fixture rows. A daily System Health reporter emits tainted/unknown percentages by market.

Moderate auto-flagging (`data_confidence < 0.5`) turns on only after all of the above are green. Until then, ship measure-only.

### 4.4 Worked checks

These cases must pass as golden tests:

- Bad GLD/SGOV/IBIT-style ETF row: applicable `{technical, sentiment, macro}`; technical missing, macro degraded, only sentiment real -> confidence roughly `sentiment_weight / (technical + sentiment + macro)` -> below 0.5 -> tainted.
- Legit ETF with real technicals, real macro, real sentiment -> confidence near 1.0 -> clean.
- Full-coverage US equity with all applicable dims real -> confidence 1.0 -> clean.
- India equity with real fundamentals, real technicals, real macro -> confidence 1.0 -> clean.
- Malformed historical row with no `features.weighting.base_weights` -> `quality_status='unknown'`, `data_confidence=NULL`, not auto-tainted during measure-only.

---

## 5. Trade/order tagging

Add nullable columns, additive and safe:

- `paper_trades`: `data_confidence numeric`, `quality_status text`, `tainted boolean default false`, `taint_reason text`, `excluded_from_learning boolean default false`
- `broker_orders`: same five columns
- `observation_labels` or the ledger-quality join path: must expose equivalent quality/exclusion fields to validation and feature-learning code before any challenger can use post-feature data.

Population:

- **At creation - paper:** PaperTrader joins `v_decision_quality` by `paper_trades.signal_id -> decision_observations.signal_id` and writes the five fields.
- **At creation - live:** Execution Gateway joins by `broker_orders.proposal_id -> trade_proposals.id -> trade_proposals.signal_id -> decision_observations.signal_id`.
- **Backfill:** One-time job tags existing `paper_trades` and `broker_orders`.
- **Override:** Owner can flip `excluded_from_learning` manually; every override writes `decision_journal` or an admin audit row.

Taint rule after enablement:

```text
if quality_status='ok' and data_confidence < 0.5:
  tainted = true
  excluded_from_learning = true
  taint_reason = 'low data_confidence: <degraded/missing dims>'
else if quality_status='unknown' or data_confidence is null:
  measure-only: leave untainted
  learning-enabled: exclude from learner/validation until reviewed
```

---

## 6. Learner and validation filtering

The primary pollution fix is not deletion. It is dataset filtering.

Closed-trade learner queries must include:

```sql
coalesce(excluded_from_learning,false) = false
and coalesce(tainted,false) = false
and data_confidence is not null
and coalesce(quality_status,'unknown') = 'ok'
```

Apply the equivalent filter to every learning input path:

- `app/api/agents/learner/route.ts` closed `paper_trades` queries.
- `computeScoreCorrelation()` fallback over `paper_trades`.
- `lib/learning/dataset.ts::loadLabeledDataset()` / validation engine reads from `decision_observations x observation_labels`.
- `app/api/validation/feature-check/route.ts` feature IC evaluation.
- `shadow_decisions` promotion metrics.

For ledger-based paths, do one of:

1. Add `data_confidence`, `quality_status`, and `excluded_from_learning` to `observation_labels` at label creation time; or
2. Join `v_decision_quality` by `observation_labels.observation_id`.

Do not depend only on `paper_trades` tags. The validation engine and feature discovery
learn from the observation ledger, not only filled paper trades.

---

## 7. Learner mutation recovery

Reuse `strategy_versions` and `learning_priors_history`.

- Every weight mutation should already create a new `strategy_versions` challenger row with `parent_version_id` and `weights_snapshot`.
- Recovery is: retire the bad version, re-promote the parent for the same market, and log the reason.
- `revert_learner(market, to_version?)`: owner-gated admin op. `to_version` defaults to current champion's parent.
- Prior restoration should use `learning_priors_history` only when the mutation actually changed priors. If prior changes are unrelated user edits, do not roll them back blindly.

Mutation guardrails:

- Reject a candidate trained on any tainted/excluded trade or unknown-quality ledger row after enablement.
- Reject a candidate if validation used any row with `quality_status <> 'ok'` or `data_confidence is null`.
- Clamp per-run weight deltas server-side.
- Shadow quarantine: a new candidate must accumulate `K` shadow outcomes before promotion to champion / production sizing.

---

## 8. Reusable safe teardown

Owner-gated admin route. Dry-run is the default.

Verbs:

- `exclude_tainted?market=X`: flags only, no deletion.
- `reset_paper?market=X&dryRun=true`: returns counts and exact operations.
- `reset_paper?market=X&confirm=true`: creates backup under `backups/`, then transactionally resets mutable paper state.

`reset_paper` may touch only mutable projections for the chosen market:

- `paper_portfolio`
- `paper_positions`
- `paper_trades`
- pending paper-only proposals/orders, if explicitly scoped

It must not delete or mutate:

- `decision_observations`
- `observation_labels`
- `shadow_decisions`
- `paper_order_events`
- `learning_log`
- `strategy_versions`
- `evidence_records`

The reset route must use service-role only, owner auth, dry-run counts, backup-first,
and explicit market scoping.

---

## 9. What each part protects against

| Failure | Guard |
|---|---|
| Bad data -> high score | `v_decision_quality.data_confidence` measures evidence coverage |
| Tainted trade -> learner | `excluded_from_learning` + quality filters |
| Tainted observation -> validation/feature learning | `v_decision_quality` join or label-level quality columns |
| Confidence calc bug -> silent mass exclusion | measure-only rollout, unknown state, golden tests, monitor, owner override |
| Bad mutation lands | champion-parent revert + shadow quarantine |
| Manual cleanup breaks app | dry-run + backup + append-only-respecting reset |

---

## 10. Rollout

1. **Phase 1 - Measurement:** `v_decision_quality` view, structured future `features.quality` logging, golden tests, monitor. No auto-taint yet.
2. **Phase 1B - Pollution-proofing:** trade/order taint columns, observation-label or ledger-quality join, backfill, learner/validation/feature filters. Enable moderate auto-flag only after golden tests and historical flag-rate review are green.
3. **Phase 2 - Mutation safety:** `revert_learner()`, mutation guardrails, shadow quarantine.
4. **Phase 3 - Ops:** admin exclude/reset route with dry-run and backup.

---

## 11. Open questions

- `K` for shadow quarantine. Default proposal: 10 closed shadow outcomes per market, but validate against observed signal frequency.
- Exact `features.quality` shape for future rows.
- Historical degraded-dim heuristics for old rows.
- `trade_proposals.signal_id` type migration from `bigint` to `uuid`.
- Moderate threshold 0.5: validate flag rate across full history before enabling. It should catch the true bad set, not a broad percentage of normal decisions.

---

## 12. Diagram / system-map impact

The learner <- trades <- decision_observations flow gains a quality gate. On build,
update `public/agent-diagrams/system-map.json` and the affected learner/paper-trader
diagrams, then append a history entry per project convention.

## Reviewer changelog (ChatGPT)

- Section 3: Updated author line to "reviewed/updated by ChatGPT, 2026-07-08" as requested.
- Section 3: Added an explicit migration-order rule: code that reads new taint/quality columns must ship only after its additive migration is applied, and missing columns must not be treated as clean data.
- Section 4.1: Tightened the `data_confidence` denominator rule to fail `unknown` when structural/base weights are malformed instead of falling back to post-renormalized `applied_weights`.
- Section 5: Added the requirement that validation/feature-learning paths get equivalent quality/exclusion fields through `observation_labels` or a `v_decision_quality` join, not only through `paper_trades`.
- Sections reviewed with no additional change: Sections 1, 2, 7, 8, 9, 10, 11, and 12 were consistent with the known schema/safety constraints after the edits above.
