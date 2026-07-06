# Learning Core Rebuild — Feature Architecture (DRAFT)

**Status:** DRAFT — Phase 1 pending approval (2026-07-06)
**Origin:** Codex agent-architecture review (`CODEX_AGENT_REVIEW_RESULT.md`). Verdict: Kairos is a governed adaptive *scoring* system, not yet self-evolving. Blocker: no point-in-time, policy-aware, out-of-sample validation that proves a change *causes* reproducible improvement.

**Goal:** Turn the learning plane into a statistically trustworthy, self-evolving engine — the "world-class evolving quant agent" bar — without weakening the existing control plane (deterministic scores, immutable challengers, per-market champions, human live-capital gate).

**Design constraints (keep):** deterministic scoring (no LLM numbers); LLM = hypothesis/feature proposal + narrative only; per-market isolation; human is the FINAL live-capital gate; everything guarded/resilient; free-data-first.

---

## The three phases

### Phase 1 — Scientific ground truth (KEYSTONE)
Give the learner a valid observation→outcome dataset. Nothing above this is trustworthy until it exists.

- **`decision_observations`** (new, immutable, append-only): one row per SCORED candidate — **including rejected ones** (not just filled longs) — capturing the point-in-time state:
  - `id, ts, market, symbol`
  - `code_version` (git sha), `strategy_version_id`, `weights_snapshot_hash`, `data_availability_mask` (which of the 5 dims had real data)
  - raw + transformed features (the dimension sub-inputs, not just the 5 scores): stored as `features jsonb`
  - `analyst_score`, per-dim scores, `entry_eligible` (passed threshold?), `action` (bought/skipped + reason), `fill_price/qty` if filled, `exit_policy_version`
  - Written by ResearchAgent for EVERY candidate it scores (filled or not).
- **`observation_labels`** (new): forward outcomes computed AFTER horizon maturity, never before:
  - `observation_id, horizon (2d|5d|10d|20d), fwd_return, benchmark_neutral_return, sector_neutral_return, max_adverse_excursion, max_favorable_excursion, matured_at`
  - Uses corporate-action-adjusted prices; realistic spread/slippage/fees. A nightly "label maturation" job fills these as each horizon comes due.
  - Realized policy P&L (`paper_trades`) is kept SEPARATE as an execution-policy label, not the alpha label.
- **Walk-forward dataset builder**: purged + embargoed folds around validation boundaries so overlapping swing returns aren't leaked across train/test.
- **Quarantine 10yr personal trades** from alpha: they feed the Mentor/behavioral model only (provenance + policy-era tags); may generate hypotheses but can't satisfy mutation sample sizes or update alpha weights.

Migrations: `059_decision_observations.sql`, `060_observation_labels.sql`.
Jobs: `POST /api/agents/label-maturation` (nightly cron, per market). ResearchAgent writes observations inline.

### Phase 2 — Validation Engine (make evidence mandatory)
- **Deterministic validation service** (`lib/validation/`): fit regularized multivariate models (ridge/elastic-net for excess return, logistic for sign, rank-IC/Spearman for cross-sectional rank) with sector/beta/vol/regime controls; block/bootstrap uncertainty; nested walk-forward + a locked final holdout.
- **Champion-vs-challenger on paired opportunity sets** (same symbols/periods): paired return differences, posterior P(improvement), Sharpe/Sortino, drawdown, turnover, calibration, exposure stability, per-regime, **effective** sample size (clustered/overlap-adjusted), multiple-testing correction.
- **Promotion state machine** (server-enforced, fail-closed): `draft → offline_testing → shadow_paper → eligible → approved`. `promote_champion` REJECTS unless a signed Validation Engine result on a frozen dataset exists. Human approval remains the final live gate — after evidence, not instead of it.
- **Promotion objective = risk-adjusted return** (net expected log-growth / Sharpe under fixed exposure), NOT win-rate — so R:R and expected value drive selection (see the Risk-Reward workstream above).
- **Calibrated P(win) + sizing/exit module**: fit a calibrated probability + a separate, independently-validated sizing/exit policy against the MAE/MFE labels (review #4). This is where risk-reward starts being *learned* instead of hand-set.
- LearnerAgent's `update_signal_weight` no longer picks the number — it proposes a hypothesis; the Validation Engine fits + gates.

### Phase 3 — Controlled evolution (genuinely evolve)
- **Typed strategy genome** (extend `strategy_versions`): feature defs/transforms, missing-data policy, entry/rank threshold, universe/liquidity filters, horizon, exit family, **conviction-scaled sizing (fractional-Kelly / vol-target)**, **dynamic ATR/pattern-conditioned R:R**, exposure limits, regime router — each with an approved search domain. Sizing + R:R are now first-class evolvable genes (see Risk-Reward workstream), validated like alpha. Evolve ONE layer at a time under nested validation. Hash-bound to signals/experiments/trades.
- **Feature registry + discovery**: LLM proposes a machine-readable feature spec (rationale, formula, inputs, lag, expected sign, horizon, falsification test); a deterministic compiler replays it point-in-time, tests incremental value, quarantines until it passes; monitors rolling IC/decay and auto-demotes dead features.
- **Shadow A/B + bounded exploration**: fan every daily observation to champion + a small set of challengers (record hypothetical decisions/fills); paper-only risk-capped contextual bandit for exploration; live capital stays champion-only with auto-rollback on drift/drawdown.
- **Regularized regime conditioning**: point-in-time regime features (trend/vol/breadth/rates/dispersion); mixture-of-experts / partial-pooling so sparse regimes shrink to global. No brittle bull/bear switches.
- **Predeclared promotion objective** (e.g. benchmark-neutral expected log-growth under fixed exposure) + non-inferiority gates; versioned, requires approval to change.

---

## Cross-cutting workstream — Risk-Reward Optimization (first-class goal)

**Problem today:** sizing is a flat `position_size_pct` (10%) and R:R is a fixed profile ratio (~2.85:1) — identical on a barely-qualifying and a max-conviction trade. Conviction only flips a binary entry gate; it never sizes the bet or shapes the payoff. Risk-reward is a hand-set constant, entirely outside the learnable surface. A world-class agent must **press when the edge is real and confident, and stay small/flat otherwise.**

This spans all three phases:

- **Phase 1 (ground truth):** `observation_labels` capture **MAE/MFE** (max adverse/favorable excursion) per candidate per horizon — the raw material for learning "how much room does this pattern need, how far does it run." Also `benchmark_neutral_return` so reward is measured as alpha, not beta.
- **Phase 2 (learn + validate the R:R module):**
  - Fit a **calibrated P(win) / expected-payoff model** (logistic for sign, quantile/regression for magnitude) — NOT the raw analyst_score, which is uncalibrated.
  - Learn **sizing + exit as a SEPARATE validated module** (review #4) against MAE/MFE + return labels: how big, where the stop, where the target — as functions of conviction, volatility, and pattern.
  - **Promotion objective = risk-adjusted return** (net expected log-growth / Sharpe under fixed exposure limits), NOT win-rate. So the engine optimizes **expected value and R:R**, not hit-rate — a 45%-win, 3:1-payoff strategy must be able to win promotion over a 60%-win, 1:1 one.
- **Phase 3 (make it evolvable + conditional — part of the genome):**
  - **Conviction-scaled sizing** — fractional-Kelly or volatility-target sizing from calibrated P(win) × payoff, capped by exposure/concentration limits. Bet bigger only where edge×confidence is high; never full-Kelly (ruin risk).
  - **Dynamic R:R** — ATR/volatility- and pattern-conditioned stops & targets (e.g. stop = k·ATR, target sized to the pattern's historical MFE), replacing the fixed 7/20.
  - **Regime-conditioned posture** — the regime router (P3) adjusts sizing aggression + R:R by regime (e.g. tighter/smaller in high-vol reversals).
  - All bounded by the risk layer + human live-capital gate; sizing/exit changes go through the same walk-forward validation + promotion gate as alpha changes.

**Guardrails:** fractional-Kelly (≤ ½-Kelly) not full; hard per-name and per-sector exposure caps stay human-set (moral-hazard rule); sizing model validated out-of-sample before it can move real size; auto-rollback on drawdown.

## Phase 1 detail (the piece up for approval now)

**Why first:** every other phase optimizes against a label. If the label/dataset is biased (symbol-join, filled-longs-only, policy-P&L, leakage), the whole engine optimizes noise. Phase 1 is the ground truth.

**Scope of the build:**
1. Migration `059_decision_observations` + `060_observation_labels` (+ indexes; RLS off like sibling agent tables). Applied manually (MCP denied) — I'll hand you the SQL + full paths.
2. ResearchAgent (`lib/research-agent.ts`): after scoring each candidate, write a `decision_observations` row (features + availability mask + action) — for filled AND skipped candidates. Guarded/resilient (no-op if table absent).
3. Label maturation job `app/api/agents/label-maturation/route.ts` + cron: nightly, per market; for observations whose horizons have matured, compute fwd/benchmark-neutral returns from Yahoo/price_cache and write `observation_labels`. Idempotent.
4. Walk-forward dataset builder `lib/learning/dataset.ts`: assemble purged/embargoed folds from observations+labels (read-only; consumed by Phase 2).
5. Learner: repoint `query_signals_with_outcomes`/`query_score_correlation` to read the matured label dataset (horizon-aligned, all candidates) instead of the symbol/policy-P&L join; mark personal-trade tools as behavioral-only (no mutation authority).
6. Docs + system-map (new LEDGER node) + PROJECT_DECISIONS (Decision 33).

**Not in Phase 1:** the statistical fitting, promotion gate, genome, shadow — those are Phase 2/3.

**Risk/cost:** additive, resilient; no change to live behavior until observations accrue. Storage grows (~N candidates/day/market × features) — bounded, prune >18mo.

---

## Phase 1 — RESOLVED decisions (refinement, 2026-07-06)

1. **Feature granularity = full raw features, for free.** `computeScores` already returns an `evidence` object per dimension holding the raw sub-inputs (pe_ratio, profit_margin, roe, eps, revenue_growth_yoy, analyst_target, sector, industry, sentiment bull/bear %, macro danger, RSI/MA technicals, insider). Phase 1 stores this whole `evidence` blob as `decision_observations.features` — no refactor of the scorer. This future-proofs Phase 3 feature discovery (raw inputs are captured from day one, not just the 5 scores).
2. **Observation trigger = every symbol that reaches `computeScores`** (holdings + screener candidates + NIFTY candidates), whether it fills or is skipped/rejected. That's the honest "all candidates incl. rejected" set. Symbols filtered out *before* scoring (no features) are NOT logged.
3. **Horizons = 2 / 5 / 10 / 20 trading days. Active markets only** (write observations only for markets currently in `market_focus`) — matches the 2–20d thesis, no wasted storage. [user-approved 2026-07-06]
4. **Label sources / benchmarks:** US fwd prices from price_cache/AV/Massive, benchmark SPY. India from Yahoo `.NS` candles, benchmark `^NSEI`. Phase 1 computes `fwd_return`, `benchmark_neutral_return`, and `max_adverse/favorable_excursion` (all cheap from daily candles). **Sector-neutral return is DEFERRED to Phase 2** (needs peer-set construction). Prices corp-action-adjusted (Yahoo/AV adjusted series); a fixed cost/slippage haircut applied.
5. **No backfill.** Point-in-time features can't be honestly reconstructed for past signals, so the ledger starts fresh from deploy. `signal_score_history` stays as-is for the Score Tracker chart. The dataset simply accrues from go-live.
6. **Phase 1 improves the DATA, not yet the METHOD.** Once matured labels exist, the learner's correlation tools read the horizon-aligned, all-candidate, signal_id-correct dataset (already fixed the symbol-join bug) — but still use simple correlation, clearly flagged as INTERIM. The regularized multivariate fit + walk-forward promotion GATE is Phase 2. This keeps Phase 1 shippable and low-risk.
7. **Retention:** prune `decision_observations` + `observation_labels` older than 18 months (a later cron); bounded storage.

**Volume estimate:** ~10–20 scored candidates/market/day × 2 markets ≈ 30–40 rows/day + 4 label rows each → well under 1M rows/year. Trivial for Postgres.

**Deliverables locked for Phase 1:** migrations 059/060 (manual apply), ResearchAgent observation write, `label-maturation` cron (+ register-tasks entry), `lib/learning/dataset.ts` walk-forward builder, learner repoint + personal-trade quarantine, docs + system-map (LEDGER node) + Decision 33.
