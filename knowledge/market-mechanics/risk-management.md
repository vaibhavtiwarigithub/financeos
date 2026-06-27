# Risk Management Principles

> Confidence: HIGH | Source: D.E. Shaw (fractional Kelly), Man AHL (vol targeting), LTCM (failure analysis)
> Last updated: 2026-06-01 | This file governs TraderAgent position sizing. Do not deviate.

---

## The One Rule Above All Others

**Survival > Returns.**

A strategy that returns 20% annually with a 30% max drawdown is worse than one returning 15% with a 10% max drawdown — because the first one will eventually hit a 60% drawdown year and you will stop the system at the worst possible moment, guaranteeing you realize the loss.

LTCM had the most mathematically correct strategy in history. They did not survive.

---

## Position Sizing: Volatility Targeting (Mandatory)

**Never use fixed position size. Always volatility-target.**

### Formula
```
position_size = (target_risk_pct × account_value) / (realized_vol_20d × sqrt(252))

Where:
  target_risk_pct = 0.01  (risk 1% of account per position)
  realized_vol_20d = 20-day rolling standard deviation of daily returns
  sqrt(252) = annualization factor
```

### Example
```
Account: $10,000
Target risk: 1% ($100)
NVDA 20-day daily vol: 0.025 (2.5% per day)
NVDA annualized vol: 0.025 × sqrt(252) = 0.397 (39.7%)
Position size = $100 / 0.397 = $251 (2.51% of account)
```

In low-vol regime (NVDA calm): position may be larger.
In high-vol regime (NVDA volatile): position automatically smaller.

**This is how Man AHL improved Sharpe by 10% — not better signals, just vol targeting.**

---

## Kelly Criterion — Use Fractional (25% Only)

### Full Kelly formula
```
f* = (p × b - q) / b

Where:
  p = probability of win
  q = probability of loss (1-p)
  b = win/loss ratio
```

### Why 25% of Kelly, not full Kelly
- Full Kelly maximizes long-run growth but produces catastrophic drawdowns.
- D.E. Shaw uses 25–50% of Kelly.
- At personal scale, your estimate of p is uncertain. Overestimating p by 5% with full Kelly = ruin.
- 25% Kelly sacrifices ~8% of maximum growth rate while cutting catastrophic drawdown risk by 75%.

### Practical rule
If your signal analysis suggests a 60% win rate with 1.5:1 win/loss ratio:
```
f* = (0.60 × 1.5 - 0.40) / 1.5 = 0.327 (32.7% of account)
Fractional Kelly (25%): 0.327 × 0.25 = 0.082 (8.2% of account)
```
With 5% max position cap → actual position = min(8.2%, 5%) = 5%.

---

## Hard Position Limits (Non-Negotiable)

These limits hold regardless of Kelly calculation or analyst score:

| Limit | Value | Reason |
|---|---|---|
| Max single position | 5% of agentic account | Single stock cannot destroy portfolio |
| Max single sector | 20% of agentic account | Sector shock cannot destroy portfolio |
| Max daily trades | 3 trades | Transaction costs, decision quality |
| Max drawdown trigger | 20% | Automatic trading pause, review required |
| Max single-day loss | 5% of account | Emergency circuit breaker |
| Min analyst score to trade | 70/100 | Only high-conviction signals |

---

## The LTCM Check (Required Before Every TraderAgent Action)

Answer these three questions. If any answer is uncertain or "I don't know" → do not trade.

1. **Correlated shock question:** "What single macro event could cause ALL my current positions to move against me simultaneously?"

2. **Survival question:** "If that event happened tomorrow and persisted for 6 months, how long does the agentic account survive at current position sizes?"

3. **Liquidity question:** "If I needed to exit all positions in 24 hours, what % of fair value would I recover?"

---

## Volatility Regime Position Multipliers

Applied on top of base position size:

| Regime | Position Multiplier | Reason |
|---|---|---|
| Low vol | 1.0x | Full size appropriate |
| High vol | 0.6x | Uncertainty elevated |
| Crisis | 0.2x | Preserve capital |

---

## Drawdown Response Protocol

| Drawdown Level | Action |
|---|---|
| -5% | Review: which positions are responsible? |
| -10% | Reduce all positions by 30% immediately |
| -15% | Reduce all positions by 60%, alert user, pause new trades |
| -20% | Full stop. Set trading_enabled = false. Requires manual review to resume |

---

## What NOT to Do (From Real Failures)

| Mistake | Why It Kills | Example |
|---|---|---|
| Lever up on a winning streak | Winning streak ≠ lower risk | LTCM 1997-1998 |
| Override the model when it's painful | Model calibrated on thousands of data points. Gut isn't. | RenTech held through 2007 crash and won |
| Assume current correlations are permanent | Gold vs 10Y: R²=0.81 on prices, 0.18 on returns | Every cross-asset model eventually |
| Ignore transaction costs in backtests | A "15% annual return" strategy with 50 trades/month may be 2% after costs | Most retail backtests |
| Add leverage to recover a drawdown | This is the fastest path to total loss | LTCM final weeks |
| Run only one strategy | Single strategy has regime risk | Man AHL 2013-2015 |
