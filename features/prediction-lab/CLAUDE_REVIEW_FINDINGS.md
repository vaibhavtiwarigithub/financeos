# Prediction Lab — Claude architecture review findings

Reviewer: Claude (Sonnet 5.5) · Date: 2026-10-21 · Reviewed: `features/prediction-lab/FEATURE_ARCHITECTURE.md` v1.0 at `c3c9ac9a` (repo `main`, clean tree, no active conflicting work-log claim).
Scope: architecture review only. No production write, migration, inference call, trial, worker change or deploy was performed. Production access was read-only SQL on 2026-10-21; the strategy-replay GET route was **not** called.

## 1. Verdict

**REVISE, then approve P0–P1 only.** The design is honest about what it does not know and its evidence discipline (paired baselines, no free winners, versioned trials, separate verdicts) is sound. But as drafted it (a) proposes persistence that duplicates existing immutable registries, (b) leads with a paid prompt challenger the data cannot evaluate for months, and (c) rests on four verified defects in the code it plans to reuse. The smallest useful release is P1: a read-only projection over existing evaluation tables plus the zero-cost paired delta **council minus deterministic score**, because production shows the council tracking the deterministic score it is given.

Approve now: P0 repairs (below) and P1. Do not approve: P3 (paid challenger), any new table, P4+ implementation.

## 2. Findings

### P0

**P0-1 — The proposed prompt challenger (P3) cannot be evaluated at the actual data budget.**
Evidence: production council batch `2026-10-20 23:47:54 UTC` has 1–6 qualifying sessions per cell and no t-statistic anywhere (all `insufficient_evidence`). One session accrues per market day. The draft's own rough count says h10 needs ≈120 sessions to clear even the legacy 12-window count. A challenger doubles the calls of the member it challenges (the existing cohort is ~100–300 symbols per member per session). Incumbent-vs-challenger is a *paired difference of differences*, which is noisier than either IC; its variance is unmeasured because no paired series with ≥ 20 sessions exists.
Correction made: P3 deferred; new precondition = ≥ 30 matured sessions of the incumbent's paired delta against the deterministic score so a power calculation uses a measured variance (section 18).

### P1

**P1-1 — `strategy-replay` GET registers trials despite documenting itself as a dry run.**
`app/api/agents/strategy-replay/route.ts:13` ("GET … writes nothing") vs `:222` (`register_trial` runs before the `persist` branch at `:246`, for the real rule and both controls). Verified `register_trial` (production function definition) is idempotent per `(family, spec_fingerprint)` under `pg_advisory_xact_lock`, returns `was_new=false` on repeats, and `trial_family_ledger` has 4 rows, all from `strategy-replay-route`. So it is not a runaway; it is a contract violation and a permanent +1 trial for any *changed* fingerprint. The draft called it P0; downgraded to P1.
Correction: split registration into the POST path (or make GET compute the fingerprint without the RPC); add a test that a GET leaves `trial_family_ledger` unchanged.

**P1-2 — Label builder assumes a 16:00 ET / 15:30 IST close every day.**
`lib/llm-council/availability-label.ts:12-23`. DST is handled by `Intl`, but US early-close sessions (13:00 ET, about three per year) are treated as closing at 16:00, so a forecast made between 13:00 and 16:00 passes the `closeAtMs(...) > availableAt` test (`:47`) for a close that had already printed. India special sessions (e.g. Muhurat trading) would be given regular hours. Impact: few days a year but it is exactly the leakage class the architecture exists to prevent.
Correction: per-session close time from the calendar owner, fail closed for unknown close; fixtures for early-close, DST transition days and India special sessions (section 8).

**P1-3 — The compiler's RSI is mislabelled "Wilder".**
`lib/strategy-replay/compile.ts:65-79`: documented as "Wilder RSI, the standard definition", implemented as a simple average of gains/losses over the last `period` bars (its own comment concedes the reduction). No registered rule uses RSI today (only the VOO 200-session SMA trend), so nothing is silently wrong yet.
Correction: rename `rsi_simple` or implement Wilder smoothing as a new `ruleVersion`, with reference-value tests, before any RSI rule is registered (section 10).

**P1-4 — HAC lags are positional and unreliable at the small samples the lab will live in.**
`lib/score-variants/core.ts:51-66, 99-109, 143`. `hacMeanT` is a correct Bartlett estimator, but lag `h−1` is applied over the *filtered list* of qualifying sessions, so skipped sessions make distant dates adjacent. At h=10 the lag is 9; for 20–30 sessions the bandwidth ratio is 0.3–0.5 where Newey–West t over-rejects against a normal reference (fixed-b theory, Kiefer–Vogelsang 2005 — training knowledge, not re-verified). Positive: `meetsAdoptionGate` is already hard-coded `false` (`:147`), so no current decision depends on this t.
Correction: session-indexed lags with explicit gaps; label t `descriptive` until a fixed-b or bootstrap/permutation reference is calibrated on simulated serially dependent nulls (section 11). The thresholds are proposals.

**P1-5 — Five new tables duplicate existing registries.**
Existing owners: `score_variant_registry` (append-only trigger, `declared_at`, jsonb weights), `score_variant_eval_runs` (paired variant vs baseline, per market/sample/horizon, reused 2026-10-14 for insider v2), `llm_council_ic_runs` (per-series IC with `series_key`, `cohort_key`, `forecast_model`, `qualifying_sessions`, `independent_windows`, `t_stat`), `trial_family_ledger` + `register_trial` (denominator, advisory lock), `backtest_experiments` (31 sealed rows), `upgrade_path_attribution_runs` (19 rows). Dispositions in section 14: extend registry (4 nullable columns), extend result tables (5 nullable columns), drop `events` and `comparison_points` (recomputable cache), defer `review_notes` to P6 (the only genuinely new object). Net: zero new tables through P5.

**P1-6 — The council is anchored to the deterministic score, so its incremental value is the first question.**
Same batch, US all-research h2: deterministic +0.332, 50/50 blend +0.332, API median/DeepSeek +0.309; h5 deterministic +0.398 vs median +0.335. India h2 deterministic −0.171 vs council −0.108. Debated and independent series are identical (zero debate rounds). The prompt contains the deterministic score. None of these is significant (1–6 sessions) but the structure says "council ≈ deterministic input", which the draft's section 9 acknowledges only as a caveat. Correction: P1 computes the paired council-minus-deterministic delta on the common symbols from stored data (no inference); the score-hidden ablation stays a later, separately approved experiment.

### P2

- **P2-1 Reuse map omissions.** The draft omits the 2026-10-14 shadows that are already part of "dimensions & formulas": `insider_v2_shadow` (493 rows, latest 2026-10-21 12:01 UTC, crons `kairos-insider-v2-shadow-a/-b`, `-eval`), the India LLM-events evaluator, the index-sleeve shadow and the live-recommendation tracker. Added to section 4.
- **P2-2 Stale adoption-gate wording in other docs.** `meetsAdoptionGate` is now hard-coded false, but `features/score-variants-forward-shadow`, `features/insider-score-routine-sales` and the registry entries for those shadows still describe a "t ≥ 2.4 adoption gate" the code cannot meet. Follow-up for the owners of those docs (not edited in this review).
- **P2-3 Unequal roster coverage.** In the labelled cohort `claude-sonnet-4-6` and `gpt-5.6-sol` cover 103 observations/1 session at h2; `claude-sonnet-5-5` and `gpt-5.6-luna` cover 257–258/3 sessions. Head-to-head comparisons must use the intersection; the draft's matched-population rule already requires this — made explicit in section 5.
- **P2-4 Short-window IC context.** The 3-month US composite audit found rank IC +0.03 (t ≈ 0.4); a +0.33 over five sessions is not in tension with it. The UI must show session counts beside every IC (added to P1).

## 3. Existing-versus-missing matrix

Verified = observed in source or production on 2026-10-21. "Callable" = code exists, scheduling not verified.

| Capability | Status | Evidence |
|---|---|---|
| Council collection crons (US/India, several windows) | Verified scheduled | `cron.job`: `kairos-council-us`, `-us-am`, `-us-pm`, `-india`, `-india-am`, `-india-mid`, all active |
| Council evaluator batch | Verified producing | batch `2026-10-20 23:47:54 UTC`, h2/h5 cells; **which scheduler runs it was not identified by job-name search** |
| Fixed formula evaluator | Verified scheduled | `kairos-score-variants-eval` 15:10 UTC; `score_variant_eval_runs` 312 rows, latest 2026-10-20 15:20 |
| Mined formula declarations | Verified registered | 9 rows in set `formula_mined_v1_aab358160c2e3787` (first 2026-10-15 17:01 UTC) |
| Insider v2 producer/evaluator | Verified scheduled | 3 crons active; 493 rows, latest 2026-10-21 12:01 UTC |
| Trial denominator | Verified | `register_trial` definition read; 4 ledger rows |
| Rule compiler / NAV / negative controls | Callable, one hardcoded rule | `app/api/agents/strategy-replay/route.ts`; GET registers trials; POST refuses sealing (409) |
| Strategy template shadow storage | **Missing** | `strategy_template_shadow_configs` does not exist; parser exists in `template-shadow-contract.ts` |
| Sealed historical replay | Partial | `backtest_experiments` 31 rows (latest 2026-10-18); route cannot seal the VOO seam |
| Portfolio attribution | Narrow | `upgrade_path_attribution_runs` 19 rows (US international-allocation only per the draft) |
| `strategy_evaluations` | 0 rows | Different subsystem (mandate-level ledger), not evidence the replay engine is absent |
| Paired council-vs-deterministic delta | **Missing** | Not stored anywhere; computable from stored series (P1) |
| Hypothesis/lesson store | **Missing** | Genuinely new, P6 only |
| Early-close-aware label builder | **Missing** | P1-2 |
| Wilder RSI | **Missing** | P1-3 |
| Session-indexed HAC / calibrated small-sample t | **Missing** | P1-4 |

## 4. Alternatives considered

| Alternative | Decision | Cost avoided / incurred |
|---|---|---|
| Five new tables (draft) | Rejected for P0–P5 | Avoids two declaration clocks, a points table that doubles the largest tables, and migration/RLS/test surface for objects with no consumer |
| Extend registry/result tables | Adopted | 9 nullable columns, additive; legacy rows unchanged |
| Run prompt challenger now at h10 | Deferred | Avoids doubled member calls for ≥ 6 months of immature labels |
| Run challenger at h2/h5 as primary | Rejected for now | Changes the primary endpoint away from the prompt's h10 contract; revisit only with owner approval and a stated rationale |
| Vector database for notes | Rejected (agrees with draft) | Relational tags suffice at this volume |
| Second simulator / backtester | Rejected (agrees with draft) | Reuse `simulatePortfolio`; parity gate before any "app impact" claim |
| Score-hidden council ablation | Deferred to a later experiment | One extra call per forecast; answer the free paired-delta question first |

## 5. Minimum implementation slices, reuse owners and gates

1. **P0 repairs** (≈ four small, independent changes). Owners: `strategy-replay/route.ts` (P1-1), `availability-label.ts` + `trading/market-calendar` (P1-2), `strategy-replay/compile.ts` (P1-3), `score-variants/core.ts` (P1-4). Gates: a fixture test per defect (GET leaves ledger unchanged; early-close and India special-session labels; RSI reference values; session-gap lag and null-calibration simulation); full suite; no new trial.
2. **P1 read-only projection**: one route under the Learning read namespace reading `llm_council_ic_runs`, `score_variant_eval_runs`, `upgrade_path_attribution_runs`; computes paired delta on common symbols from stored series; shows session counts, coverage, `descriptive` labels; symbol link to existing score history. Gates: stored rows displayed; missing/immature vs broken distinguished; no inference, no schema; viewer routes return aggregates only.
3. **P2** only after P1 runs for ≥ 30 sessions: the nine nullable columns, `statistics_version`, common-sample hash; migration verified applied before code ships.
4. Everything later keeps the draft's gates (P3 deferred, P4–P6 unchanged, plus the parity audit below).

## 6. Not audited by this review (explicitly NOT PERFORMED)

Council `core.ts`, subscription worker and cron prompt/packet construction (only their stored outputs were inspected); dimension diagnostics and technical edge registry; `lib/edges/folds.ts` / `oos-experiment.ts` purging; `simulatePortfolio` and constructor/rotation/lot/cost parity with the production execution path; `attribution-writer` provenance; benchmark registry versions; earnings/peer expectation producers; whether historical dimension scores are genuine as-of inputs; model-identity drift in call ledgers; raw-packet privacy of existing projections. These remain P0 work before P5; no claim in this review depends on them.

## 7. Remaining owner decisions and prerequisites

1. Approve P0 repairs + P1 (recommended) or defer all.
2. Confirm that new work extends existing tables rather than creating the five proposed records.
3. Decide, only after P1 data exist, whether a prompt challenger is worth its call cost; and whether its primary horizon stays h10.
4. Decide whether the 30-session precondition and the proposed t-statistic handling (descriptive until calibrated) are acceptable; these are proposals, not proven optima.
5. First strategy family and mechanisms (draft section 10) remain unchosen.

## 8. Sources and limits of their evidence

All fetched 2026-10-21 from the arXiv abstract pages; abstracts only, full papers not read.

- StockBench, arXiv:2510.02209 (v1 2025-10-02, v2 2026-03-02) — https://arxiv.org/abs/2510.02209. Reports most evaluated LLM agents fail to beat buy-and-hold. Abstract does not state window, universe or prospective vs historical; unverified beyond the abstract.
- AlphaAgent, arXiv:2502.16789 (v2 2025-06-09) — https://arxiv.org/abs/2502.16789. LLM alpha mining with AST originality and complexity regularization, evaluated on CSI 500 and S&P 500 "past four years". Historical evaluation (inferred); author claims, no live result.
- R&D-Agent-Quant, arXiv:2505.15155 (v2 2025-09-25, NeurIPS 2025) — https://arxiv.org/abs/2505.15155. Claims up to 2× annualized return vs classical factor libraries "in real-market backtests". Backtest claim only; markets/periods not stated in the abstract.
- AlphaPilot, arXiv:2610.15488 (2026-10-11) — https://arxiv.org/abs/2610.15488. RL-trained multi-turn factor-mining agents; out-of-sample rolling backtests on CSI300/CSI500 (mean total return 42.93%/54.19%, Sharpe 2.46/2.86). Backtest only, Chinese indices, no live trading, no limitations stated in the abstract. Not evidence for a small US/India ledger.
- "What LLM Trading Agents Actually Do in Production", arXiv:2609.05663 (2026-09-04) — https://arxiv.org/abs/2609.05663. Live fleets with real funds (crypto memecoin vaults, Hyperliquid perps); finds no directional edge; replay league of 416 scenarios shows models statistically indistinguishable at that horizon. Contradicts the optimistic backtests above for live LLM agents; observational, short windows, one design lineage, crypto only.
- Probability of Backtest Overfitting (Bailey et al.) and QuantConnect research guide, cited by the draft — not re-fetched in this review.
- Kiefer–Vogelsang (2005) fixed-b asymptotics — cited from training knowledge; not re-verified.

Evidence classes: AlphaAgent, RD-Agent-Quant, AlphaPilot = historical/backtest author claims; 2609.05663 = live observational; StockBench = unverified from the abstract.

## 9. Return to Codex

**Edits made** to `FEATURE_ARCHITECTURE.md` (v1.0 → v1.1, see its "Review revision log"): status/verdict; section 4 (strategy-replay row corrected with verified idempotency, score-variant and result tables named as reuse owners, omitted 2026-10-14 shadows added); section 5 (re-verified numbers plus the council≈deterministic finding, roster coverage, short-window caution, ledger count); section 8 (early-close defect); section 10 (RSI defect); section 11 (positional lag and small-sample t); section 14 (five records → zero tables, nine nullable columns); section 18 (P0 repairs list, P1 redefined as the smallest release, P3 deferred with a precondition); review revision log and answers to the draft's own questions.

**Unresolved disagreements:** (1) I would not build or approve P3 now; the draft keeps it as an owner-approved option. (2) I read the draft's "dedicated tables" as unnecessary; if you still want a comparison-run table for UI simplicity, justify it against `llm_council_ic_runs` / `score_variant_eval_runs` first.

**Diagrams:** unchanged; none names the dropped tables, and the evidence flow remains accurate.

**Next safe action:** fix the four P0 defects as independent, test-first changes (no migration, no inference), then build the P1 projection. Do not call `GET /api/agents/strategy-replay`. Nothing in this review was pushed; commit is local only.
