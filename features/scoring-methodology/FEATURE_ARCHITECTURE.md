# Scoring Methodology Upgrade — Feature Architecture

**Last updated:** 2026-07-10  
**Status:** REVIEWED / IMPLEMENTATION-READY, but every rollout phase still requires Vaibhav approval  
**Authors:** Claude Sonnet 4.6; reviewed and materially corrected by ChatGPT/Codex, 2026-07-10  
**Scope:** US equities, US ETFs, and India NSE equities; long-only new positions; 2–20 trading-day swing horizon.

---

## 1. Objective and honest benchmark

Kairos must rank opportunities reproducibly, abstain when evidence is weak, learn only from point-in-time outcomes, and promote a scoring version only after net-of-cost out-of-sample evidence. No public document describes the proprietary “best scoring system in the world,” and no architecture can guarantee profit. The defensible target is the process used by serious systematic research teams:

1. point-in-time universe and data;
2. compact, economically motivated features;
3. cross-sectional expected-return ranking with uncertainty;
4. independent portfolio/risk construction;
5. purged walk-forward validation, costs, and multiple-testing controls;
6. shadow → paper → small-live promotion with rollback.

Research supports starting with momentum/trend, liquidity, volatility, industry-relative strength, and carefully lagged fundamentals. Nonlinear models can help when there is enough broad historical data, but shallow/regularized models are the correct first production model for Kairos’s current sample. References are in §14.

### Current assessment

| Layer | Current state | Target |
|---|---|---|
| Candidate discovery | Mixed static/watchlist/screener sources | PIT universe snapshot + discovery-source attribution |
| Features | Five coarse 0–100 dimensions | Compact raw features with source/as-of/quality metadata |
| Ranking | Renormalized linear heuristic | Setup-specific alpha score + comparable-universe percentile |
| Direction | LLM can return long/neutral/short | Deterministic entry/exit decision; LLM explanation only |
| Confidence | Count/availability semantics | Structural applicable-weight coverage + model uncertainty |
| Learning | Five-weight challenger | Versioned feature/model/setup genome; statistics proposes, human promotes |
| Validation | Existing walk-forward and IC pieces | Purged nested walk-forward, costs, trial accounting, OOF calibration |

The existing five-dimension scorer remains a transparent baseline (`deterministic_v1`). It must not be relabeled `deterministic_v2`.

---

## 2. Non-negotiable invariants

- An LLM may not generate `analyst_score`, `rank_score`, expected return, probability, direction, weights, size, or eligibility.
- DeepSeek comparison signals are `llm_advisory`, never `pending`, and never consumable by PaperTrader or TraderAgent.
- New positions are long-only. A held-position exit is `exit_candidate`/SELL, never a synthetic “short” forecast.
- Missing, stale, failed, degraded, and structurally inapplicable data are distinct.
- The denominator of evidence confidence is **structurally applicable base weight**, never post-renormalization `applied_weights`. The numerator includes only fresh, valid data; degraded dimensions are excluded.
- No model is trained or evaluated on information unavailable at `decision_ts`.
- Cross-sectional transformations use a recorded reference universe for the same market/date. The three daily candidates are not a valid reference universe.
- A scoring version cannot become paper-active or live-eligible merely by changing a string or Settings value.
- LLM explanations can veto/reduce a candidate only through a bounded, evidence-citing schema; they can never rescue a failed deterministic gate.
- Scoring chooses opportunities. Portfolio construction and Execution Gateway independently decide whether and how much may be traded.

---

## 3. Target pipeline

```text
PIT universe snapshot
  → provider observations (value, source, observed_at, available_at, retrieved_at)
  → feature snapshot + per-feature quality
  → deterministic eligibility/liquidity/event gates
  → asset/setup router
  → setup raw-alpha models
  → comparable-universe rank + uncertainty/evidence adjustment
  → deterministic long_candidate | watch | abstain | exit_candidate
  → LLM explanation / bounded veto (optional; never rescue)
  → agent_signals summary + append-only decision_observations canonical snapshot
  → matured labels at 2/5/10/20 trading days
  → IC, precision@K, calibration, net return, turnover, drawdown
  → purged walk-forward challenger comparison
  → shadow → paper → live-review lifecycle
```

### Separation of concerns

- **Universe layer:** defines what could have been selected at the time.
- **Alpha layer:** estimates relative expected return and uncertainty.
- **Decision layer:** applies evidence, event, contradiction, and mandate gates.
- **Portfolio layer:** sizes from calibrated edge, volatility, correlation, current book, and caps.
- **Execution layer:** validates account, quote, limits, budget, idempotency, and broker state.

No layer may silently absorb another layer’s responsibility.

---

## 4. Canonical contracts

```typescript
type Market = "us" | "india";
type AssetType = "equity" | "etf" | "adr";
type DataState =
  | "ok"
  | "inapplicable"
  | "missing"
  | "stale"
  | "provider_failed"
  | "degraded";

interface FeatureValue<T = number> {
  value: T | null;
  state: DataState;
  source: string;
  observedAt: string | null;   // market timestamp of the observation
  availableAt: string | null;  // first timestamp Kairos could legally know it
  retrievedAt: string;
  staleAfter: string | null;
}

type SetupType =
  | "quality_momentum"
  | "value_inflection"
  | "post_earnings_drift"
  | "etf_trend"
  | "india_quality_momentum"
  | "india_sector_rotation";

interface ScoringFeatureSnapshot {
  schemaVersion: "1";
  scoringVersion: string;
  symbol: string;
  market: Market;
  assetType: AssetType;
  decisionTs: string;
  marketSessionDate: string;
  universeSnapshotId: number;
  benchmarkSymbol: string;
  sectorId: string | null;
  features: Record<string, FeatureValue<number | boolean | string>>;
  sourcePayloadHashes: string[];
}

interface SetupScore {
  setupType: SetupType;
  rawAlphaScore: number;          // stable deterministic composite; not a probability
  rankScore: number;              // 0..100 percentile within recorded comparable universe
  evidenceConfidence: number;     // 0..1 structural coverage, §7
  contradictionPenalty: number;   // 0..1 direct penalty, §8
  regimeScaler: number;           // bounded [0.75,1.00] in initial release
  finalScore: number;              // rankScore × confidence × (1-penalty) × scaler
  pWin: number | null;             // calibrated OOF model only
  expectedReturnBps: number | null;// calibrated OOF model only, net estimate separate
  predictionIntervalBps: [number, number] | null;
  action: "long_candidate" | "watch" | "abstain" | "exit_candidate";
  reasonCodes: string[];
  scoreSource: "deterministic_v1" | "deterministic_v2" | "llm_advisory";
  scoringVersion: string;
}
```

`analyst_score` remains a compatibility/display field during migration. For v2 it equals rounded `finalScore`; consumers must use `score_source`, `scoring_version`, and lifecycle eligibility rather than treating every 0–100 number as equivalent.

---

## 5. Universe and comparable groups

Every run persists the eligible universe before scoring, including inclusion reason, market, asset type, sector, liquidity fields, and effective timestamps. Historical validation must not apply today’s constituents to the past.

Comparable groups:

- US equity: market/date/sector where sample ≥20; otherwise market/date/asset type.
- US ETF: market/date/ETF category (broad, sector, thematic, fixed income where supported); never rank ETFs against companies.
- India equity: market/date/NSE sector where sample ≥15; otherwise market/date/large/mid-cap liquidity bucket.

Winsorization and z-scores are fitted within the **training/reference** group only. If the group is too small, use pre-registered fixed transforms, mark `rank_quality=degraded`, and do not invent a percentile from the three finalists.

Universe membership must record survivorship limitations. The current `edge_universe_members` list is useful for measure-only work but is not PIT-safe proof.

---

## 6. Feature set and setup experts

### Shared price/liquidity features

- 5/20/60/120 trading-day total return (120d may be absent in early phases)
- 12–1 momentum when enough history exists
- benchmark- and sector-relative 20/60d momentum
- realized volatility and downside volatility
- distance to 52-week high
- volume surprise using prior 20 sessions (exclude current bar from denominator)
- average traded value and, where available, spread/price-impact proxy
- EMA20/50/200 state; EMA is a state feature, not four duplicate indicators

Corporate actions must be adjusted consistently. A split/dividend discontinuity cannot become momentum or a fake drawdown.

### Fundamental/event features

- sector-relative value and quality composites using only fields with PIT `available_at`
- earnings surprise/revision and post-event age
- next earnings/ex-dividend dates as event/risk metadata
- stale filing age and provider quality

If PIT availability cannot be proven, the feature is excluded from training and trading, not backfilled with today’s value.

### India-specific context

- NIFTY 50 and sector-relative strength
- India VIX state
- INR/USD and crude-oil change as bounded context features
- FII/DII flow only after a reliable timestamped source exists

US `macro_regime` must not be reused as India macro evidence. India context begins as a small scaler/feature and earns influence through validation.

### Setup experts

The six existing archetypes remain, but formulas are **priors to validate**, not truths:

| Setup | Asset | Load-bearing evidence | Initial role |
|---|---|---|---|
| `quality_momentum` | US equity/ADR | positive 20/60d trend, liquidity, quality if PIT | primary |
| `value_inflection` | US equity/ADR | PIT relative value/quality + technical stabilization | shadow until PIT fundamentals proven |
| `post_earnings_drift` | US equity/ADR | timestamped event + surprise/revision + volume/trend | shadow until event feed proven |
| `etf_trend` | US ETF | category-relative trend, liquidity, vol | primary |
| `india_quality_momentum` | India equity | NIFTY/sector-relative trend + liquidity + PIT quality | primary price-only first |
| `india_sector_rotation` | India equity | stable timestamped sector-index data | shadow until source reliability proven |

Router rules are deterministic and pre-registered. An event-qualified symbol can be evaluated by the event expert; otherwise the asset-specific priority applies. If multiple experts qualify, persist all shadow scores but only the pre-declared champion expert may create the actionable signal. This prevents after-the-fact selection of whichever model looked best.

Initial raw-alpha models are monotonic, regularized linear composites over transformed features. Do not hardcode arbitrary `z(...)` formulas until the comparable universe and transformation definition exist. Gradient-boosted trees or shallow neural nets are P5 research candidates only after a broad PIT dataset, nested validation, and a linear baseline comparison.

---

## 7. Evidence confidence — exact math

For setup `s`, let `w_f` be the pre-registered structural weight of feature group `f`. Let `A_s` contain only groups structurally applicable to the symbol/setup.

```text
denominator = Σ w_f for f ∈ A_s
numerator   = Σ w_f for f ∈ A_s where state(f) = ok and freshness passes
data_confidence = numerator / denominator
```

- `inapplicable` is omitted from both numerator and denominator.
- `degraded`, `missing`, `stale`, and `provider_failed` remain in the denominator and contribute zero to the numerator.
- Never use post-renormalization `applied_weights` in either term.
- A missing hard-required feature causes `abstain` regardless of aggregate confidence.
- A malformed/zero denominator produces `quality_status=unknown` and abstain for actionable paths.

This must align with `v_decision_quality` and `features.weighting.base_weights`; the v2 writer must preserve the structural weights, included feature groups, and quality states in `decision_observations.features`.

Initial policy:

- `<0.60`: abstain;
- `0.60–0.74`: shadow/watch only;
- `≥0.75`: eligible for the remaining gates.

These are policy defaults, not learned alpha thresholds. Auto-live may require a stricter threshold and never accepts a quality override.

---

## 8. Contradictions and direction

Contradiction penalties are direct additive values, capped at 1.0. Do not multiply a penalty by a second copy of its own weight.

```typescript
let penalty = 0;
if (bullishEvent && relMomentum20d < -0.03) penalty += 0.30;
if (valueRank > 70 && momentum60d < -0.10) penalty += 0.25;
if (highAttention && volumeSurge < 0.80) penalty += 0.20;
if (hostileRegime && fragileLiquidity) penalty += 0.25;
return Math.min(1, penalty);
```

- `≤0.20`: clean;
- `0.20–0.40`: watch/shadow or deterministic size haircut in the portfolio layer;
- `>0.40`: abstain.

Machine-readable hard vetoes—illiquidity, upcoming earnings policy, missing required evidence, stale quote, corporate-action anomaly—run before the LLM.

Direction/action order:

1. Determine whether the symbol is held in the relevant paper/live book.
2. Evaluate held-position exit rules independently; output `exit_candidate` only for held quantity.
3. For new positions, apply deterministic setup/evidence/contradiction/event gates.
4. Output `long_candidate`, `watch`, or `abstain`.
5. Ask the LLM for explanation and optional bounded veto.
6. A valid veto can only downgrade `long_candidate → watch`; it cannot upgrade any result.

The LLM schema may output summary, risks, catalysts, and `{vetoed, category, citedEvidenceIds}`. It may not output any numeric trading field. Invalid JSON or unavailable LLM leaves the deterministic decision unchanged and records `explanation_status=unavailable`; no LLM is required for correctness.

---

## 9. Persistence and migrations

All migrations are additive and must be applied before schema-coupled code ships. Use the next real migration number discovered at build time; do not copy `N+1` literally.

### `agent_signals` summary columns

Add nullable columns with constraints: `score_source`, `scoring_version`, `setup_type`, `rank_score`, `final_score`, `evidence_confidence`, `contradiction_penalty`, `p_win`, `expected_return_bps`, `abstain_reason`, `reason_codes text[]`, `llm_veto jsonb`, `universe_snapshot_id`.

Do **not** add a second full `features` blob to `agent_signals`; `decision_observations.features` is the canonical PIT snapshot. Duplication would drift. A signal links to it through `signal_id`.

Add numeric range checks as `NOT VALID`, backfill/inspect legacy rows, then validate in a later step. Add a DB constraint so new `status='pending'` rows require an approved deterministic source; legacy rows must be explicitly backfilled, not silently accepted. RLS remains enabled and service-only. Verify table grants because current Supabase projects may not expose new tables/columns automatically.

### `decision_observations`

This table already has `features jsonb`, `availability_mask`, and UUID `signal_id`, and is append-only. Add only missing summary columns: `score_source`, `scoring_version`, `setup_type`, `rank_score`, `final_score`, `evidence_confidence`, `contradiction_penalty`, `p_win`, `expected_return_bps`, `universe_snapshot_id`.

Never update or delete historical observations to “upgrade” them. New logic writes new rows/versioned snapshots.

### Version lifecycle

Extend the existing `strategy_versions` lifecycle rather than creating an unrelated activation switch. Each scoring challenger records `scoring_version`, code/config hash, feature schema, universe definition, training cutoff, trial-family ID, and validation experiment. Lifecycle:

```text
draft → measure_only → shadow_paper → paper_active → live_review_eligible → live_approved → retired
```

Only owner promotion changes lifecycle. Learner/LLM may propose a challenger; it cannot activate one. PaperTrader consumes `paper_active`; TraderAgent/live auto consumes only `live_approved` and rechecks the linked validation evidence.

---

## 10. Validation, calibration, and learning

### Labels

- Forward returns at 2/5/10/20 **trading-day** horizons.
- Benchmark-neutral and sector-neutral returns.
- Corporate-action-adjusted prices.
- Labels mature only after the horizon; late/provider-revised labels are versioned, never overwritten silently.

### Required evaluation

- Spearman rank IC and Newey–West uncertainty by market/setup/horizon.
- Top-K precision/hit rate and top-minus-median spread for this long-only system.
- Net-of-spread/slippage/fees/tax-assumption expectancy and turnover.
- Brier score, log loss, and expected calibration error for `pWin`.
- Sharpe/Sortino, max drawdown, benchmark alpha, concentration, and regime/year stability.
- Champion-vs-challenger paired results on the same opportunity set.
- Trial count/effective number of variants, Deflated Sharpe or a documented multiple-testing correction.

### Walk-forward rules

- Purge samples whose forward-label windows overlap the test window; apply an embargo.
- Fit transforms, imputers, coefficients, and calibrators on each training fold only.
- Produce out-of-fold predictions for every validation metric.
- The current `lib/validation/calibration.ts` fits coefficients on the full dataset and then scores fold test rows with those same coefficients; that is leakage. P3 must replace this with per-fold fits and a final production fit only after OOF metrics pass.
- Do not use `60 observations` as a universal green light. Require enough effective, non-overlapping observations for model complexity and both outcome classes. Initial default: at least 250 labeled rows, at least 50 effective horizon blocks, and at least 20 positive and 20 negative outcomes per fitted parameter family; otherwise keep `pWin`/expected return null.

### Learning boundary

The LearnerAgent may:

- discover hypotheses/features;
- request deterministic experiments;
- propose bounded challenger configs;
- summarize failures.

It may not directly change active weights, thresholds, setup routing, code, money limits, or lifecycle state. Numeric optimizers/regularized fits produce candidate parameters; the LLM does not.

---

## 11. Data-source policy

Provider tiers and quotas change; `docs/DATA_PROVIDER_MATRIX.md` (or the existing canonical provider review) must record current plan, quota, freshness, market coverage, legal/ToS status, and fallback behavior. Do not label a source “free” in code architecture without verifying the configured account tier.

- Massive/Polygon, Alpha Vantage, FMP, Finnhub, Upstox, Robinhood, and Kite are official/API sources where configured.
- Yahoo endpoints are an unofficial, no-SLA fallback and cannot be the sole live-auto dependency.
- TradingView paid UI access does not grant an API license; CSV/manual validation is allowed, scraping/auth automation is not an architectural dependency without explicit ToS review.
- Fallbacks may supply research/shadow data only when source equivalence is validated. Provider substitution is recorded in the snapshot and can reduce confidence.
- API exhaustion results in cached-with-freshness, alternate approved provider, or abstain. Never fabricate or ask an LLM for market data.

---

## 12. Build phases and exact gates

### P0 — provenance safety (no formula change)

1. Migration: source/version/summary columns and safe constraints.
2. Tag current ResearchAgent rows `deterministic_v1`, version `v1.0`; DeepSeek rows `llm_advisory`.
3. PaperTrader explicitly requires the current `paper_active` deterministic version.
4. TraderAgent requires `live_approved` scoring lifecycle for live BUY proposals.
5. Replace LLM direction for new entries with a deterministic v1 threshold/evidence gate; held exits remain separate.

### P1 — measure-only feature/universe snapshots

1. Add PIT universe snapshot and feature computation.
2. Persist canonical snapshots in `decision_observations.features`.
3. Verify corporate-action adjustment, source timestamps, reference-universe ranks, and US/India market calendars.
4. No change to paper/live selection.

### P2 — shadow setup experts

1. Implement pure scorers and deterministic router.
2. Persist all expert scores as shadow evidence; only v1 remains actionable.
3. Run IC/stability/cost analysis over broad PIT opportunities.

### P3 — OOF calibration and expected return

1. Correct the calibration leakage.
2. Fit regularized baseline models per setup/market only when sample gates pass.
3. Store OOF predictions, model artifact/hash, transformation parameters, and trial-family count.

### P4 — paper champion/challenger

1. Owner promotes v2 to `paper_active` after validation.
2. Shadow v1 and v2 on the same opportunity set.
3. UI explains features, data quality, comparable group, abstentions, and outcome history.

### P5 — live review

Require statistically and economically positive OOF/paper evidence, stable performance across time slices, acceptable drawdown/turnover, no unresolved data-integrity alerts, and owner promotion to `live_approved`. This only makes the signal eligible; all risk and execution gates still apply.

---

## 13. Acceptance tests

- Same snapshot + same version produces byte-stable score/reason codes.
- DeepSeek/LLM signals cannot be claimed by PaperTrader or TraderAgent even if status is accidentally set pending.
- ETF cannot enter equity setup or fundamental denominator.
- India cannot consume US macro as valid India evidence.
- Degraded/stale/failed required data remains in confidence denominator and contributes zero numerator.
- `applied_weights` are never used for confidence math.
- Contradiction penalty can reach abstain threshold; tests cover each combination.
- New unheld short/SELL is impossible; held exit quantity cannot exceed verified holdings.
- Rank computation fails to watch/abstain when the comparable universe is absent or too small.
- Current-bar volume is excluded from its own baseline; all N-day features have no off-by-one/look-ahead.
- Split/dividend-adjusted return tests for US and India.
- Walk-forward preprocessing and calibration fit only on fold train data.
- Pending actionable signal requires deterministic source and active version.
- Auto/live eligibility requires `live_approved`; score threshold alone is insufficient.
- Missing provider data produces abstain or approved fallback with provenance, never neutral 50 as real evidence.

---

## 14. Evidence basis

- [Gu, Kelly & Xiu, *Empirical Asset Pricing via Machine Learning* (RFS 2020)](https://academic.oup.com/rfs/article/33/5/2223/5758276): nonlinear interactions can help with broad data; price trends, liquidity, and volatility are dominant predictors; shallow learning can outperform deeper models in low-signal finance.
- [Harvey, Liu & Zhu, *…and the Cross-Section of Expected Returns*](https://www.nber.org/system/files/working_papers/w20592/w20592.pdf): factor discovery requires multiple-testing discipline.
- [Bailey & López de Prado, *The Deflated Sharpe Ratio*](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf): correct selection bias, non-normality, and backtest overfitting.
- [Bailey et al., *The Probability of Backtest Overfitting*](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253): ordinary holdouts are insufficient when many strategies are tried.
- [Jegadeesh/Titman momentum evidence](https://www.nber.org/papers/w7159): momentum is a reasonable prior, not permission to skip contemporary out-of-sample validation and trading costs.

## 15. What Claude must not improvise

- Do not implement all phases in one PR.
- Do not invent migration numbers; inspect the repo first.
- Do not create a second feature truth store.
- Do not hardcode thresholds as “validated”; mark priors and lifecycle state.
- Do not make Yahoo/TradingView scraping a live dependency.
- Do not train a complex model on the current handful of paper trades.
- Do not make any scoring change affect live trading until its migration, tests, shadow evidence, and owner promotion exist.

## 16. Provider Data-Truth Amendment (2026-07-31)

Formula review is not sufficient acceptance for a scoring feature. Every dimension
must publish provider taxonomy/units, availability semantics, silent-default hit rate,
production distribution including floor/ceiling mass, and a market-local frozen
counterfactual. The corrective baseline and remaining semantic proposals are recorded
in `features/scoring-data-truth/FEATURE_ARCHITECTURE.md`.
