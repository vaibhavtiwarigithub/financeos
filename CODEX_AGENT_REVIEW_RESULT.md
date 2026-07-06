# Codex Architecture Review — ResearchAgent & LearnerAgent

**Review date:** 2026-07-06  
**Verdict:** Kairos is a governed, adaptive scoring system—not yet a self-evolving quant system. Deterministic scoring, immutable challengers, market-scoped champions, and human promotion are sound control-plane choices. The learning plane is not statistically trustworthy enough to establish that a proposed change improves expected out-of-sample performance.

## Ranked recommendations

### 1. [PRIORITY: P0] Build a point-in-time learning dataset with an explicit label contract

**Problem:** The learner does not have a valid observation-to-outcome dataset. In `app/api/agents/learner/route.ts`, both `query_signals_with_outcomes` and `query_score_correlation` join signals and closed trades through a `Map` keyed only by `symbol`. Repeated signals or trades in the lookback overwrite one another, and no constraint links a score timestamp to the trade opened from that score. The label is policy-dependent `paper_trades.pnl_pct`, while historical decisions use `price_1m_after`/`outcome_score`; neither is aligned consistently to the declared 2–20 day strategy horizon. Only filled longs receive paper outcomes.

**Why it caps performance/evolution:** The learner cannot distinguish feature edge from entry selection, position size, exit policy, market beta, regime, or accidental symbol matching. It also learns only from candidates the current policy selected, causing selection/collider bias and preventing evaluation of rejected opportunities. Overlapping swing returns are not independent observations. Any apparent improvement can therefore be noise or leakage rather than learning.

**Recommendation:** Create an immutable `decision_observations`/feature-snapshot dataset for **every scored candidate**, including rejected candidates, with: decision timestamp; market; strategy/code/data version; raw point-in-time features; transformed features; data vintages; data-availability mask; score; entry eligibility; action; fill; and exit-policy version. Generate separate labels after maturity at fixed horizons (for example 2d/5d/10d/20d forward total return, benchmark/sector-neutral return, maximum adverse/favorable excursion) and keep realized policy P&L as a separate execution-policy label. Use corporate-action-adjusted prices, realistic spread/slippage/fees, and never expose a label to training before its horizon matures. Purge overlapping samples and embargo folds around validation boundaries.

**Effort:** L

### 2. [PRIORITY: P0] Remove Pearson/LLM weight nudging from the optimizer role

**Problem:** `query_score_correlation` computes univariate Pearson correlation between one bounded, threshold-generated dimension score and realized P&L, with a computational minimum of three pairs; mutation uses an LLM-reported `n_trades` and self-assigned confidence. Pearson assumes a stable linear relationship, is highly outlier-sensitive at small N, ignores multicollinearity among the five scores, and treats overlapping, heteroskedastic trades as IID. The LLM then chooses a numeric weight delta.

**Why it caps performance/evolution:** A dimension may appear predictive because it is correlated with another dimension, sector exposure, market direction, or the current selection rule. `pnl_pct` also mixes alpha with holding time and exits. LLM confidence is not a calibrated statistical quantity, and stochastic prose reasoning is neither a reproducible optimizer nor protection against multiple testing. The current ±0.05 limit is simultaneously too large for N=10 inference and too slow when genuine evidence exists.

**Recommendation:** Keep the LLM as a hypothesis/feature-proposal and explanation layer only. Move numeric fitting to a deterministic validation service. Start with regularized multivariate models appropriate to the target: ridge/elastic-net for excess return, logistic regression for sign probability, and rank-IC/Spearman for cross-sectional ranking. Include sector, market beta, volatility, data-availability, and regime controls. Estimate uncertainty with block/bootstrap or time-series-aware methods. Use Bayesian optimization only for bounded hyperparameters inside nested walk-forward validation; do not use it to optimize on the final holdout. Store the exact dataset hash, seed, objective, constraints, coefficients, and confidence intervals in each experiment.

**Effort:** L

### 3. [PRIORITY: P0] Make out-of-sample validation mandatory before promotion

**Problem:** A learner proposal becomes a `strategy_versions` challenger, but `app/api/strategies/versions/route.ts` allows an authenticated human to promote it directly. Promotion does not require a completed eligibility experiment or superiority to the current champion. The TypeScript backtest explicitly admits it is in-sample and informational; the required Python point-in-time Validation Engine remains unimplemented.

**Why it caps performance/evolution:** Human approval is valuable governance but is not evidence. Without a locked evaluation protocol, repeated challenger generation and visual inspection create researcher degrees of freedom and selection overfitting. A worse challenger can become the production scoring policy merely because its narrative is persuasive.

**Recommendation:** Enforce a server-side state machine: `draft → offline_testing → shadow_paper → eligible → approved`. Promotion must fail closed unless the challenger has a signed Validation Engine result on a frozen dataset. Use rolling or anchored walk-forward folds with purge/embargo, followed by an untouched final holdout. Compare challenger and champion on identical opportunity sets and periods using paired return differences. Gates should include net expectancy/alpha, confidence interval or posterior probability of improvement, Sharpe/Sortino, drawdown, turnover, calibration, exposure stability, performance across regimes, and a minimum effective—not raw—sample size. Correct for the number of challengers tried. Human approval should remain the final live-capital gate, not substitute for validation.

**Effort:** L

### 4. [PRIORITY: P0] Separate alpha, portfolio construction, and execution learning

**Problem:** The current outcome is realized trade P&L from a coupled policy: score threshold, long-only entry, fixed percentage sizing, target, stop, trailing stop, score exit, and holding time. LearnerAgent attributes that composite outcome back to top-level signal weights.

**Why it caps performance/evolution:** A sound alpha signal can be penalized by a poor exit or sizing rule; a weak signal can look good because of market beta or favorable risk policy. Optimizing all effects against one P&L label gives incorrect credit assignment and makes failures impossible to localize.

**Recommendation:** Define three versioned modules with separate objectives: (1) alpha/ranking model predicts fixed-horizon benchmark-neutral returns or probabilities; (2) portfolio constructor converts forecasts and uncertainty into positions under volatility, sector, liquidity, concentration, and drawdown constraints; (3) execution/exit policy minimizes implementation shortfall and controls realized risk. Evaluate each independently before evaluating the composed strategy. Store module versions on every signal and trade.

**Effort:** L

### 5. [PRIORITY: P1] Expand the strategy genome beyond five weights, with typed and bounded evolution

**Problem:** ResearchAgent can consume only five promoted top-level weights. Fundamental and other sub-scores use fixed hand-coded transforms and thresholds; entry threshold, universe filters, horizon, exits, and position sizing are outside LearnerAgent's learnable surface. Although `strategy_versions` has `entry_rules`, `exit_rules`, universe, and horizon fields, LearnerAgent does not optimize or validate them.

**Why it caps performance/evolution:** Reweighting five fixed dials can only remix existing assumptions. It cannot discover that RSI behaves nonlinearly, that a feature has decayed, that a universe filter is harmful, or that a different horizon/exit is needed. The system therefore has a hard representational ceiling and should not be described as genuinely self-evolving.

**Recommendation:** Introduce a typed, immutable strategy manifest containing: feature definitions and transforms; missing-data policy; interactions; entry/ranking threshold; market/universe/liquidity filters; prediction horizon; exit family; sizing/volatility target; exposure limits; and regime router. Give each field an approved search domain and dependency rules. Evolve one layer at a time under nested validation rather than searching the entire combinatorial space. Hash the manifest and bind it to signals, experiments, and trades.

**Effort:** L

### 6. [PRIORITY: P1] Add a governed feature-discovery and retirement pipeline

**Problem:** The LLM can write hypotheses but cannot convert them into versioned candidate features with point-in-time computation, validation, or decay monitoring. The five dimensions are permanent even when their underlying data are absent or stale; neutral fallback scores can become systematic signals through weighting.

**Why it caps performance/evolution:** Edge compounds through discovery, validation, combination, and retirement of features—not permanent remixing of a fixed scorecard. Without lineage and decay tests, additions invite leakage while dead features remain in production.

**Recommendation:** Let the LLM propose a machine-readable feature specification: economic rationale, formula, inputs, availability lag, expected sign, horizon, applicable universe/regime, and falsification test. A deterministic feature compiler/registry should reject unavailable-at-decision-time inputs, replay the feature point-in-time, test incremental value against the current model, measure stability and correlation with existing features, and quarantine it until validation passes. Monitor rolling IC, calibration, coverage, and drift; automatically demote decayed features to shadow status. Never let generated code or prose enter the champion directly.

**Effort:** L

### 7. [PRIORITY: P1] Run champion and challengers concurrently in shadow, with controlled exploration

**Problem:** The platform produces signals only under the champion. A challenger is a stored weight snapshot, not an independently evaluated policy receiving the same contemporaneous opportunities. There is no exploration allocation, contextual bandit, or shadow A/B loop.

**Why it caps performance/evolution:** Offline backtests alone cannot expose data-provider behavior, latency, live feature availability, or changing market structure. Conversely, experimenting with live capital before those are known is unsafe. With no parallel observation, governance can become inert and there is no clean paired evidence for promotion.

**Recommendation:** Fan out each daily point-in-time observation to the champion plus a small bounded set of challengers. Record hypothetical decisions and fills for every policy, but allocate real/paper book authority only to the champion initially. Compare paired shadow outcomes on the same symbols and timestamps. After enough reliable data, use a risk-capped contextual bandit only in paper/shadow to allocate exploration; prohibit unconstrained exploration in live trading. Promote sequentially only when posterior evidence and risk gates are satisfied, with automatic rollback on drift or drawdown.

**Effort:** M

### 8. [PRIORITY: P1] Replace “regime adaptation emerges” with explicit conditional robustness

**Problem:** The locked design rejects explicit regime routing, while the scoring model uses one global set of weights per market. A macro score is merely one additive input; this cannot represent interactions such as momentum working in low-volatility expansions but failing in high-volatility reversals.

**Why it caps performance/evolution:** Market relationships are non-stationary. A single global linear mixture averages incompatible environments and can erase conditional edge. The historical decision tool's coarse regime narratives do not make the production policy regime-conditioned.

**Recommendation:** Do not start with brittle discretionary bull/bear switches. Build observable, point-in-time regime features (trend, realized volatility, breadth, rates/liquidity, correlation dispersion) and test conditional performance. Prefer a regularized mixture-of-experts or partial-pooling model so sparse regimes shrink toward the global model. Require minimum regime sample sizes and stability across alternative regime definitions. The risk layer may reduce exposure under uncertainty; it should not fabricate confidence from a hard label.

**Effort:** L

### 9. [PRIORITY: P1] Quarantine the user's historical trades from alpha optimization

**Problem:** LearnerAgent is explicitly instructed to use roughly ten years of enriched personal decisions as evidence for weight changes. Those trades were produced by changing goals, information sets, discretionary behavior, accounts, holding periods, and execution policies. The current `outcome_score` based on future one-month price is not the same estimand as the agent's 2–20 day long swing strategy.

**Why it caps performance/evolution:** This is observational behavioral data, not a clean training set for market alpha. It contains policy drift, confounding, missing rejected opportunities, and potentially duplicated dependent decisions. Mixing it with paper evidence can cause the agent to imitate undisciplined historical behavior or infer market laws from personal habits.

**Recommendation:** Use real trade history for the Mentor/behavioral model: identify disposition effect, concentration, timing, and rule adherence. Do not permit it to satisfy mutation sample sizes or directly update alpha weights. It may generate hypotheses, but every hypothesis must be re-tested on independent market-wide point-in-time data. If retained in modeling, add provenance and policy-era segmentation, use hierarchical priors with strong shrinkage, and report it separately from strategy evidence.

**Effort:** M

### 10. [PRIORITY: P1] Replace raw-count and LLM-confidence governance with evidence-calibrated gates

**Problem:** The phase gate and per-change gate accept N≥10, while the auto-guard pauses after three low-win-rate runs and `min_confidence` is supplied by the LLM. Win rate ignores payoff asymmetry; raw N ignores overlapping positions and common-factor dependence. The guard can stop experimentation after poor champion performance—the moment exploration may be most valuable.

**Why it caps performance/evolution:** The system is not truly conservative: ten correlated trades can authorize a material weight change. At the same time, human-only promotion and global mutation pauses can make useful evolution stall. Safety and learning cadence are coupled incorrectly.

**Recommendation:** Compute effective sample size from clustered/overlapping exposures; require a minimum effect size and uncertainty bound, not a prose confidence. Replace win-rate guardrails with risk-adjusted champion health checks: drawdown, tail loss, calibration drift, data-quality degradation, and net expectancy. A guard should freeze live promotion or reduce exposure while allowing offline and shadow research to continue. Use sequential testing or Bayesian posterior thresholds with explicit priors and false-discovery budgets.

**Effort:** M

### 11. [PRIORITY: P2] Preserve the deterministic/LLM split, but strengthen scientific traceability

**Problem:** The LLM is correctly excluded from fabricating numeric market inputs, but its hypotheses, tool-call sequence, confidence claims, and proposed mutations are not tied to a fully reproducible experiment artifact. Langfuse-style tracing explains what the agent said, not whether the inference was statistically valid.

**Why it caps performance/evolution:** A sophisticated narrative can conceal weak evidence. Without replayable artifacts, reviewers cannot reproduce why a challenger was generated or detect prompt/model changes that altered the research process.

**Recommendation:** Keep deterministic scoring and advisory thesis generation. Do not feed thesis prose directly into conviction. Store prompt/model/tool versions, observation IDs, SQL/query parameters, dataset hash, hypothesis ID, preregistered test, optimizer configuration, result, and rejection reason. Require the LLM to cite observation/experiment IDs rather than summarize uncited evidence. The hand-rolled loop is acceptable at current scale; migrate orchestration only if durable resumability, branching experiments, or human checkpoints become difficult—not for branding.

**Effort:** M

### 12. [PRIORITY: P2] Define a promotion objective that matches the product's risk mandate

**Problem:** Existing gates combine trade count, win rate, Sharpe, expectancy, and drawdown, but do not define a primary estimand, transaction-cost model, exposure budget, statistical superiority rule, or acceptable degradation trade-offs. Optimizing multiple visible metrics invites metric shopping.

**Why it caps performance/evolution:** “Better” remains subjective. Challenger selection can drift toward whichever metric looks favorable, and improvements may be explained by higher beta, concentration, turnover, or hidden tail risk.

**Recommendation:** Predeclare a primary objective such as benchmark-neutral expected log growth or net risk-adjusted return under fixed exposure constraints. Set secondary non-inferiority gates for drawdown, turnover, liquidity, concentration, calibration, and tail loss. Evaluate all candidates with the same cost and capital assumptions. Version the objective and require architecture approval to change it.

**Effort:** S

## Direct answers to the hard questions

- **Is Pearson weight nudging sound credit assignment?** No. In this implementation it is a noisy marginal association on a selected, policy-generated, temporally dependent sample. It is not causal attribution and is not adequate for mutation decisions.
- **Is an LLM the right numeric optimizer?** No. Use the LLM to propose falsifiable hypotheses and candidate feature specifications. Use deterministic statistical models and walk-forward validation for weights and parameters.
- **Does the system truly evolve today?** No. It adaptively reweights five fixed engineered dimensions. That is useful, but it cannot discover or retire features or evolve the universe, horizon, entry, exit, sizing, or risk policy.
- **Should promotion require walk-forward and shadow evidence?** Yes. Human approval is a strength only after objective evidence gates; by itself it is a bottleneck and a source of narrative selection bias.
- **Should it explore?** Yes, but first through parallel shadow policies and paper-only bounded exploration. Live capital should remain champion-only until evidence and rollback controls are mature.
- **Is “regime emerges from scoring” sufficient?** No. A single additive macro score does not model regime-dependent feature interactions. Use soft, observable, regularized conditioning rather than discretionary hard switches.
- **Will ten years of personal trades improve alpha?** Not directly. Treat them as behavioral evidence and hypothesis generation; validate all market claims independently.
- **Is governance too conservative?** It is conservative in the wrong places and permissive in others. Direct human promotion and N=10 are too permissive statistically; blocking all mutation/exploration after weak runs is too restrictive scientifically. Separate live-capital gates from continuous shadow research.

## Single biggest blocker

**Kairos lacks a point-in-time, policy-aware, out-of-sample evaluation system that can tell whether a strategy change caused a reproducible improvement.** Until that exists, weight changes—whether chosen by an LLM, grid search, or Bayesian optimizer—are optimization against an unreliable label and cannot credibly compound edge.

## Three-step roadmap for the learning/evolution core

1. **Establish scientific ground truth.** Build the immutable decision-time feature ledger for all candidates, fixed-horizon and policy labels, point-in-time data lineage, realistic costs, and purged/embargoed walk-forward datasets. Keep historical personal trades out of the alpha training set.
2. **Build the deterministic Validation Engine.** Fit regularized multivariate alpha models, compare champion/challenger on paired opportunity sets, use nested walk-forward plus a locked holdout, record reproducible experiment artifacts, and make eligibility evidence a database-enforced prerequisite to promotion.
3. **Enable controlled evolution.** Introduce a typed strategy genome and feature registry, run challengers continuously in shadow, add regularized regime conditioning and bounded paper exploration, then permit gradual live allocation only after sequential superiority and risk gates with automatic rollback.

