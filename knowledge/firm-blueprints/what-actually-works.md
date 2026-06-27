# What Actually Works — Lessons from Elite Quant Funds

> Sourced from: Renaissance Technologies, Two Sigma, D.E. Shaw, WorldQuant, Man AHL, Rebellion Research, Numerai, LTCM failure analysis.
> Confidence: HIGH (all claims verified against multiple sources)
> Last updated: 2026-06-01

---

## The One Insight That Changes Everything

**Renaissance Technologies wins at a 50.75% hit rate. Their edge is NOT prediction accuracy — it's disciplined repetition of tiny edges at scale.**

Implication for FinanceOS: Stop trying to find the "correct" trade. Find signals with a slight positive expectancy and apply them consistently with proper risk management.

---

## What Each Firm Proved Works

### Renaissance Technologies — Statistical Rigor at Scale

**Core philosophy:** "I don't know WHY prices move. I only need to know WHAT precedes movements."

**What worked:**
- 99%+ signal rejection rate. Only signals with p < 0.01 advance.
- One unified model (not competing strategies) — prevents signals from working against each other.
- 50.75% win rate + 0.5% per-trade capture + 150,000-300,000 trades/day = 66% gross annual return.
- Simple regression often outperformed complex ML. Complexity overfits.
- Never overrode the model under emotional pressure (August 2007: lost 20% in 3 days, held discipline → ended 2007 up 85.9%).

**What failed:**
- Human discretionary overrides (Leonard Baum bonds, 1984: 40% loss).
- Scaling to outside capital (RIEF returned 17-19% less annually than Medallion — strategies don't scale).

**Key number:** Win rate of 50.75% is barely above a coin flip. The edge is in discipline, diversification, and repetition.

---

### D.E. Shaw — The Three-State Regime Model

**Core philosophy:** Different strategies work in different regimes. Never run regime-blind.

**What worked:**
- Explicit 3-state regime classification:
  - **Low volatility state** → Carry trades, sell options, increase leverage
  - **High volatility state** → Reduce exposure, buy downside protection
  - **Crisis state** → Flight-to-quality, long volatility
- Statistical arbitrage via cointegration (pairs trading with Kalman filter hedge ratio adjustment).
- 10+ uncorrelated P&L engines = diversification across strategies, not just assets.
- 2024: $11.1 billion investor profits (highest among major multi-strategy managers).

**Lesson for FinanceOS:** Before every AnalystAgent cycle, classify regime. Signal weights shift based on regime state.

---

### WorldQuant — The Alpha Factory Model

**Core philosophy:** Volume of signals beats depth of any single signal.

**What worked:**
- 4 million+ individual alpha signals combined via linear ensemble.
- Signal acceptance criteria:
  - IC (Information Coefficient) > threshold
  - Consistent IC over time (not just aggregate)
  - Performs across at least 5–10 years + multiple regimes
  - Sharpe > 1.5 in out-of-sample
  - **Correlation with existing signals < 0.8** (most important rejection criterion)
- Signal edge decays in 12–24 months. Must constantly replenish.

**Lesson for FinanceOS:** Measure correlation between every new signal and existing signal library before adding it. Track decay from deployment.

---

### Man AHL — Trend Following + Regime Filter

**Core philosophy:** Markets trend because of human psychology. Follow trends, but know when trends aren't happening.

**What worked:**
- Double EWMA at multiple speeds simultaneously (fast for early detection, slow for noise reduction).
- Volatility targeting = the single most impactful risk improvement. Scales leverage inversely to volatility. Improves Sharpe ~10% and reduces negative skewness.
- Market expansion (entering under-crowded venues) extended edge longer than signal refinement.

**What failed:**
- Pure trend following without regime filter (2013–2015: CTAs lost money in choppy low-vol markets).
- Strategy requires knowing WHEN trend following conditions are unfavorable and scaling down.

**Lesson for FinanceOS:** All momentum signals should be gated by a trend-favorability score. Choppy regime → reduce momentum signal weight by 50-70%.

---

### Numerai — Ensemble Over Optimization

**Core philosophy:** Diverse ensemble of independent models > one optimized model.

**What worked:**
- 1,200+ independent ML model submissions combined into Meta Model.
- NMR staking creates skin-in-the-game: submitters stake crypto, lose it if model underperforms.
- 2024: 25.45% net return, $550M AUM.
- Correlation minimization between submissions is the primary quality criterion.

**Lesson for FinanceOS:** When in doubt between two signals, ask "what is their correlation?" Not "which is more accurate?"

---

### Rebellion Research — Predict Styles, Not Stocks

**Core philosophy:** Predicting whether a STYLE (value, growth, momentum) outperforms is more stable than predicting individual stocks.

**What worked:**
- Modified Bayesian learner (not standard neural nets — 4 years of failure with standard NNs).
- 30–40 factors per stock decision.
- Style rotation prediction as primary signal.

**What failed:**
- 4 years of standard neural network approaches before pivoting.
- Lesson: Method matters as much as data. LLMs ≠ edge without validation.

---

## LTCM — The Definitive Failure Manual

**What happened:** Nobel laureate mathematicians with flawless models lost $4.6 billion in 4 months (1998).

**The six specific failure modes — hardcode these as system constraints:**

1. **Leverage without survival buffer.**
   - LTCM: 250:1 leverage at peak. One adverse move = wipeout.
   - Rule: Max 3:1 effective leverage. Fractional Kelly = 25% of theoretical max.

2. **Gaussian tail assumption.**
   - Their model said 5-sigma events were essentially impossible. Russia defaulted.
   - Rule: Financial returns have fat tails. Never use VAR without stress-testing beyond 3 sigma.

3. **Liquidity risk not modeled.**
   - Assumed they could always exit. During crisis: no buyers at any price.
   - Rule: For every position, ask "how long would it take to exit at 50% of fair value?"

4. **Crowded trade risk.**
   - Everyone copied their strategy. When they needed to exit, everyone exited simultaneously.
   - Rule: If a strategy is widely known, its edge is decaying. Track strategy crowding.

5. **Short convexity payoff.**
   - Convergence trades = small steady wins until catastrophic loss.
   - Rule: Know your payoff profile. Strategies with negative skewness need smaller sizing.

6. **No regime-change stress test.**
   - Model calibrated on post-WWII history. Did not include "G8 sovereign defaults."
   - Rule: Before deploying, identify the scenario that breaks the model. Stress test it.

---

## The Hierarchy of What Actually Works

```
Tier 1 (Proven, universally applicable):
  ✓ Regime detection before signal application
  ✓ Volatility-targeted position sizing
  ✓ Fractional Kelly (25% of optimal)
  ✓ Uncorrelated signal ensemble
  ✓ Systematic signal decay tracking
  ✓ Walk-forward validation (never re-examine held-out data)

Tier 2 (Works at scale, adapt for personal use):
  ✓ Multiple independent signals combined linearly
  ✓ Style prediction (value/growth/momentum regime) over stock prediction
  ✓ Factor neutralization (hedge out market beta)

Tier 3 (Aspirational — build toward):
  ✓ Alternative data (satellite, credit card, job postings)
  ✓ Market expansion into under-crowded venues
  ✓ Crowdsourced signal diversity (Numerai model)

Never:
  ✗ Single concentrated bet regardless of conviction
  ✗ Fixed position size regardless of volatility
  ✗ Override the model based on feelings during drawdown
  ✗ Deploy signal without multi-regime backtest
  ✗ Assume liquidity exists when you need it most
```

---

## Performance Benchmarks (What "Good" Looks Like)

| Metric | Minimum Acceptable | Target | Elite (RenTech level) |
|---|---|---|---|
| Sharpe ratio | 0.8 | 1.5 | > 2.0 |
| Win rate | 48% | 55% | 50.75% at scale |
| Max drawdown | < 20% | < 12% | < 5% |
| Annual return (net) | 8% | 20% | 39%+ |
| Prediction accuracy (30d) | 52% | 60% | N/A (different metric) |

**For FinanceOS starting point:** Target Sharpe > 1.0, max drawdown < 15%, prediction accuracy > 55% over 30 days. Failure trigger: accuracy < 45% OR drawdown > 20%.
