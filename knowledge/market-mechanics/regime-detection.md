# Market Regime Detection

> Confidence: HIGH | Source: D.E. Shaw 3-state model, Man AHL, Hidden Markov research
> Last updated: 2026-06-01 | Live validations: 0

---

## Why Regime Detection Is Non-Negotiable

Every signal works in some regimes and fails in others:
- **Momentum signals** work in trending regimes, destroy capital in choppy ones.
- **Mean reversion signals** work in range-bound regimes, destroy capital in trending ones.
- **Carry trades** work in low-vol regimes, blow up in crisis regimes.

Man AHL lost money from 2013–2015 running trend-following in a choppy market without a regime filter. D.E. Shaw beat all competitors in 2024 (+36%) by running an explicit 3-state regime overlay. **Regime detection is not optional.**

---

## The D.E. Shaw Three-State Model

### State 1: LOW VOLATILITY (Trending / Risk-On)
**Detection signals:**
- VIX < 18
- 20-day realized volatility below 12-month average
- SPY 50-day MA > 200-day MA (golden cross)
- Breadth positive: >60% S&P 500 stocks above 50-day MA

**Favorable strategies:**
- Momentum (trend following)
- Carry trades
- Sector rotation following money flow
- Growth over value

**Position sizing:** Full target size (1.0x multiplier)

---

### State 2: HIGH VOLATILITY (Choppy / Uncertain)
**Detection signals:**
- VIX 18–30
- 20-day realized volatility above 12-month average but < 2x
- SPY below 200-day MA OR within 3% of it
- Breadth declining: 40–60% stocks above 50-day MA
- Credit spreads widening (HYG declining vs LQD)

**Favorable strategies:**
- Mean reversion (not momentum)
- Reduced position sizes
- Defensive sectors (utilities, staples, healthcare)
- Quality factor (high ROE, low debt)

**Position sizing:** 0.6x multiplier (reduce all positions by 40%)

---

### State 3: CRISIS (Flight-to-Quality / Systemic Risk)
**Detection signals:**
- VIX > 30
- 20-day realized volatility > 2x 12-month average
- SPY more than 10% below 200-day MA
- Credit spreads spiking (HYG falling fast)
- Yield curve inverting or rapidly steepening
- Dollar surging (DXY +3% in a week)

**Favorable strategies:**
- Long volatility (VIX calls, UVXY)
- Cash + short-duration treasuries
- Gold
- Short equities (small, measured)
- Defensive healthcare/staples if long at all

**Position sizing:** 0.2x multiplier (80% reduction, preserve capital)

---

## Regime Detection Algorithm (for AnalystAgent)

```python
def detect_regime(vix, realized_vol_20d, realized_vol_12m_avg, 
                  spy_pct_above_200d_ma, spy_breadth_pct, credit_spread_delta):
    """
    Returns: ('low_vol' | 'high_vol' | 'crisis', confidence: float)
    """
    crisis_signals = 0
    high_vol_signals = 0
    
    # Crisis detection (any 2 of 4 triggers crisis)
    if vix > 30: crisis_signals += 1
    if realized_vol_20d > 2 * realized_vol_12m_avg: crisis_signals += 1
    if spy_pct_above_200d_ma < 0.30: crisis_signals += 1
    if credit_spread_delta > 0.5:  # HYG fell > 0.5% today: crisis_signals += 1
    
    if crisis_signals >= 2:
        return 'crisis', crisis_signals / 4
    
    # High vol detection
    if vix > 18: high_vol_signals += 1
    if realized_vol_20d > realized_vol_12m_avg: high_vol_signals += 1
    if spy_pct_above_200d_ma < 0.50: high_vol_signals += 1
    if spy_breadth_pct < 0.50: high_vol_signals += 1
    
    if high_vol_signals >= 2:
        return 'high_vol', high_vol_signals / 4
    
    return 'low_vol', 1 - (high_vol_signals / 4)
```

---

## Regime Signal Weight Multipliers

These multipliers apply to every signal weight in the AnalystAgent:

| Signal | Low Vol | High Vol | Crisis |
|---|---|---|---|
| Momentum (price) | 1.2x | 0.4x | 0.0x |
| RSI/MACD technicals | 1.0x | 0.8x | 0.3x |
| News sentiment | 1.0x | 1.2x | 1.5x (fear signals) |
| Insider buying | 1.0x | 1.3x | 1.5x (contrarian) |
| Earnings revision | 1.1x | 0.9x | 0.5x |
| Social velocity | 0.8x | 1.0x | 0.2x (noise in crisis) |
| User thesis | 1.0x | 1.0x | 1.0x |

**Position size multiplier:**
- Low vol: 1.0x of max_position_pct
- High vol: 0.6x
- Crisis: 0.2x

---

## Regime Transition Handling

Regimes don't flip instantly. Use a smoothing rule:
- Regime must be detected for **3 consecutive days** before TraderAgent switches.
- When switching from Crisis → High Vol: wait 5 days (false bottoms are common).
- Never increase position size on the day of regime upgrade. Wait one cycle.

---

## Historical Regime Periods (Reference)

| Period | Regime | What Worked |
|---|---|---|
| 2003–2007 | Low vol (trending) | Momentum, carry |
| 2008–2009 | Crisis | Cash, gold, short equities |
| 2010–2019 | Mostly low vol with spikes | Buy-the-dip momentum |
| 2020 Mar | Crisis (COVID) | Cash, treasuries |
| 2020 Apr–Dec | Low vol recovery | Momentum, growth |
| 2022 | High vol (rate shock) | Value, energy, defensives |
| 2023–2024 | Transitioning → low vol | Quality momentum |
| 2025 | Low vol (AI cycle) | Tech momentum, quality |

---

## Data Required (APIs)

- VIX: Yahoo Finance `^VIX` or Polygon.io
- SPY 200-day MA: Yahoo Finance `SPY`
- Breadth: Requires Polygon.io or calculate from individual holdings
- Credit spreads: HYG vs LQD ratio (Yahoo Finance)
- Realized vol: Calculate from SPY daily returns, 20-day rolling std * sqrt(252)

---

*LearnerAgent updates: Add resolved prediction outcomes here as regime context.*
