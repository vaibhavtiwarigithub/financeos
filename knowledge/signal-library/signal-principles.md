# Signal Principles — How to Evaluate, Combine, and Track Signals

> Source: WorldQuant alpha factory model, Renaissance Technologies, Two Sigma
> Confidence: HIGH | Last updated: 2026-06-01

---

## What Is a Signal?

A signal is any measurable input that has a statistically validated positive expectancy for predicting future price direction. A signal is NOT:
- A feeling or intuition
- A pattern seen once or twice
- A narrative ("tech is going up because AI")
- An LLM's opinion without statistical backing

**LLMs generate signal hypotheses. Statistics validate them. Only validated signals trade.**

---

## Signal Acceptance Criteria (WorldQuant Standard)

Before ANY signal enters the AnalystAgent's scoring model, it must pass:

| Criterion | Threshold | Why |
|---|---|---|
| Information Coefficient (IC) | IC > 0.03 (consistent, not just aggregate) | Measures rank-order prediction accuracy |
| IC consistency | IC positive in >55% of months tested | Prevents "works in aggregate, fails in practice" |
| Out-of-sample Sharpe | > 1.5 (on held-out data, never looked at before) | Guards against overfitting |
| Multi-regime validation | Positive in at least 4 of 5 distinct market periods | No single-regime signals |
| Correlation with existing signals | < 0.80 | No redundant signals — zero marginal value |
| Backtest period | Minimum 5 years, ideally 10+ | Long enough to see multiple regimes |
| Transaction cost model | Included in all backtests | Most signals fail when costs are applied |

**If signal fails any criterion → rejected regardless of backtested performance.**

---

## Signal Correlation Matrix (Keep Updated)

The most important table in the knowledge base. Never add a signal correlated > 0.8 with an existing one.

| Signal A | Signal B | Correlation | Notes |
|---|---|---|---|
| Momentum (price) | RSI | 0.65 | Moderate — keep both |
| News sentiment | Social velocity | 0.71 | Moderate — keep both |
| Insider buying | Earnings revision | 0.42 | Low — good diversification |
| *Add new signals here* | | | |

---

## Signal Decay Tracking (Two Sigma Model)

Every signal has a "live performance" metric tracked from deployment date separately from backtest.

Expected decay: edge erodes within **12–24 months** as competitors discover the same signal.

### Decay monitoring rule:
```
If live_sharpe < 0.5 × backtest_sharpe for 60+ consecutive days:
  → Flag signal for review
  → Reduce weight by 30%

If live_sharpe < 0 for 90+ consecutive days:
  → Deactivate signal
  → LearnerAgent documents what changed
```

---

## Signal Combination Method (Linear Ensemble)

**Do not optimize signal weights against recent performance.** Optimized weights overfit.

Default: Equal weight all validated signals. Let LearnerAgent adjust weights based on regime-specific performance over time.

```
composite_score = Σ (signal_i × weight_i × regime_multiplier_i)

Normalized to 0–100 scale.
Score < 50 = bearish
Score 50–70 = neutral
Score > 70 = potential buy signal (subject to other filters)
```

---

## The Multiple Comparison Problem (Critical)

If you test 20 signals for statistical significance at p < 0.05:
- Expected false positives by chance alone: **1** (5% × 20)
- You will find a "significant" signal that is actually noise

**Rule:** Apply Bonferroni correction.
```
Adjusted p-value threshold = 0.05 / number_of_signals_tested

Testing 20 signals → p < 0.0025 required
Testing 100 signals → p < 0.0005 required
```

Only accept signals meeting the adjusted threshold.

---

## Current Signal Library Status

| Signal | Status | Backtest Sharpe | Live Sharpe | Added | Days Live |
|---|---|---|---|---|---|
| Price momentum | 🔲 Pending validation | — | — | — | — |
| RSI divergence | 🔲 Pending validation | — | — | — | — |
| News sentiment | 🔲 Pending validation | — | — | — | — |
| Insider buying (Form 4) | 🔲 Pending validation | — | — | — | — |
| Earnings revision | 🔲 Pending validation | — | — | — | — |
| Social mention velocity | 🔲 Pending validation | — | — | — | — |
| User thesis alignment | 🔲 Manual — no validation needed | — | — | — | — |

*LearnerAgent updates this table as signals accumulate live performance data.*

---

## Signals Known to Work (Research-Validated, Not Yet Personally Tested)

### Post-Earnings Drift (PEAD)
- After a large earnings beat, stocks continue drifting UP for 60 days on average.
- After a large earnings miss, stocks continue drifting DOWN for 60 days.
- IC: ~0.05–0.08 in academic literature. Works across multiple regimes.
- Why it works: institutional investors take weeks to reposition after earnings.
- **Decay risk:** Very well-known signal. May be crowded in large-caps.

### Insider Buying Signal
- When C-suite executives buy own stock with own money (Form 4 SEC filing) → 6-month forward returns are elevated.
- Works best: Small/mid-caps, clusters of multiple insiders buying simultaneously.
- Does NOT work: Routine option exercise (not genuine buying signal).
- IC: ~0.04–0.06. Less crowded than price signals.

### Short Interest Squeeze Setup
- When short interest > 20% of float AND price breaks 52-week high → powerful upside squeeze.
- Correlation with other signals: Low (< 0.3). Good diversifier.
- Warning: High transaction cost signal. Works in low-vol regimes, dangerous in crisis.

### Momentum (12-1 Month)
- 12-month price return excluding last month predicts next 1-month return.
- One of the most replicated findings in academic finance (works in 40 countries).
- **Crashes in market reversals** (2009 March, 2020 April). Must gate with regime filter.

---

## What Does NOT Work (Validated Failures)

| "Signal" | Why It Fails |
|---|---|
| P/E ratio as timing signal | P/E has been "too high" for 20 years. No predictive value for short-term. |
| Analyst price targets | Analysts systematically lag, not lead. Contrarian use only. |
| Volume alone | Volume spikes are noise. Must combine with price action. |
| MACD alone | Generates too many false signals in choppy markets. Regime-gate required. |
| Social sentiment without regime filter | Retail sentiment is right in trending markets, catastrophically wrong at extremes. |
| Prediction from financial news narratives | Narratives are backward-looking. Markets already priced the news. |
