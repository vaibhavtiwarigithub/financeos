# Proven Signals Library

> **Agents: This is the curated signal menu. Each signal here has a documented edge.**
> Source confidence is marked. Do NOT use unproven signals without documenting them first.
> LearnerAgent updates `live_validated` counts as predictions resolve.

Confidence: BUILDING (sourced, not yet validated by our own live predictions)
Last updated: 2026-07-01
Live predictions validated: 0

---

## Signal Scoring Guide

Each signal below includes:
- **Direction:** Long / Short / Both
- **Edge:** Academic or empirical basis
- **Regime sensitivity:** Works in bull / bear / choppy / all
- **Decay:** How quickly the edge fades after signal fires
- **Kairos dimension:** Which score it feeds (fundamental / technical / sentiment / macro / insider)

---

## 1. Earnings Momentum (SUE > 1.5Ïƒ)

**What:** Stock beats consensus EPS by > 1.5 standard deviations of historical surprise.
**Direction:** Long
**Edge:** PEAD (Post-Earnings Announcement Drift) â€” Bernard & Thomas 1989. Persists in mid/small cap.
**Kairos dimension:** fundamental_score (+10 on clean beat with guidance raise)
**Regime sensitivity:** Works in bull and early bear; underperforms in deep bear/crisis (correlation 1.0 environments)
**Decay:** 30â€“60 days. Exit target T+45 or if technical breakdown.
**Contraindications:** EPS beat from buybacks only; gross margin compression; guidance cut.

---

## 2. Revenue Acceleration (QoQ and YoY both positive and accelerating)

**What:** Revenue growth rate increasing for 2+ consecutive quarters.
**Direction:** Long
**Edge:** Revenue surprises are harder to manage than EPS (can't buy back your way to revenue growth). Consistent acceleration signals real demand.
**Kairos dimension:** fundamental_score (+7)
**Regime sensitivity:** Works best in bull/neutral. In bear markets, revenue growth is dismissed if margins compress.
**Decay:** 60â€“90 days.
**Source:** O'Shaughnessy "What Works on Wall Street" â€” revenue acceleration is top quintile momentum predictor.

---

## 3. Technical Momentum â€” Price vs. 50-day MA (Trend Following)

**What:** Stock price > 50-day moving average AND 50dMA slope positive (rising).
**Direction:** Long
**Edge:** Classic trend-following. Works at 54â€“56% win rate with asymmetric R:R when combined with position sizing.
**Kairos dimension:** technical_score (+15 when both conditions met, +7 if only price > MA)
**Regime sensitivity:** Bull/trending only. In choppy markets, generates 30% more false signals.
**Decay:** 10â€“20 days (re-check weekly).
**Contraindications:** Overbought RSI (> 80) + price at resistance = reduce score.

---

## 4. RSI Mean Reversion (RSI < 30 in uptrend)

**What:** Stock with RSI < 30 (oversold) while the broader market (SPY) is above its 50-day MA.
**Direction:** Long (counter-trend, short-term)
**Edge:** ~64% hit rate for 5â€“10% bounce within 10 trading days. Works because oversold conditions in bull markets are often driven by fear/tax-loss, not fundamental deterioration.
**Kairos dimension:** technical_score (+12)
**Regime sensitivity:** Bull/neutral ONLY. In bear markets, RSI < 30 often precedes RSI < 20.
**Decay:** 10 days. This is a short-term bounce signal, not a trend signal.
**Critical check:** Oversold because of broader selloff (recovers) vs. stock-specific problem (doesn't recover). Check if industry peers also fell â€” if only this stock fell, it's a red flag.

---

## 5. Insider Buying Cluster (Multiple insiders buy within 30 days)

**What:** 2+ distinct insiders (director/officer) buying stock (open-market purchases, not option exercises) within 30 days.
**Direction:** Long
**Edge:** Academic research (Seyhun 1992, Lakonishok & Lee 2001) shows insider buys have ~56% forward 12-month outperformance vs. market. Cluster buys (multiple insiders) have higher hit rate ~62%.
**Kairos dimension:** insider_score (+20 for cluster, +10 for single meaningful buy)
**Regime sensitivity:** All regimes. Works especially well in bear markets when insiders have better information advantage.
**Decay:** 90â€“180 days (insiders are long-horizon actors).
**Critical check:** Open-market PURCHASE only. Stock option EXERCISES are not bullish signals. Sales are weakly bearish (liquidity reasons common) â€” ignore isolated sells.

---

## 6. Analyst Revision Momentum (Estimate Revisions Up)

**What:** Consensus EPS estimate revised upward by â‰¥ 2% in the past 30 days, with â‰¥ 2 analysts revising.
**Direction:** Long
**Edge:** Analysts anchor on prior estimates and revise slowly. Upward revisions cluster and continue revising up. "Earnings estimate revisions" is the single highest-alpha factor on Bloomberg screening.
**Kairos dimension:** fundamental_score (+8)
**Regime sensitivity:** Bull/neutral. In bear, rate of revision matters â€” deceleration is bearish even if positive.
**Decay:** 30â€“60 days.

---

## 7. Relative Strength vs. Sector (52-week high proximity)

**What:** Stock within 10% of 52-week high while its sector ETF is flat or declining.
**Direction:** Long
**Edge:** "Relative strength" â€” stock holding up in adversity signals underlying demand or fundamental differentiation. Academic: Jegadeesh & Titman momentum factor.
**Kairos dimension:** technical_score (+10)
**Regime sensitivity:** All regimes. Strongest signal in choppy/bear environments.
**Decay:** 60 days.

---

## 8. High Short Interest + Positive Catalyst (Short Squeeze Setup)

**What:** Short interest > 15% of float + upcoming positive catalyst (earnings, FDA, contract announcement).
**Direction:** Long (high-risk, short-duration)
**Edge:** Short sellers must buy to cover, amplifying the move. GME/AMC are extremes but the pattern works at lower intensity for 6â€“15% short interest too.
**Kairos dimension:** technical_score (+5 for high SI alone; sentiment_score (+8) when combined with social volume spike)
**Regime sensitivity:** All, but requires specific catalyst. Do NOT use in absence of a real catalyst â€” will reverse.
**Decay:** 1â€“5 days (squeeze either happens or doesn't quickly).
**Risk:** Short sellers may add on the way up, delaying or preventing the squeeze.

---

## 9. FCF Yield > 8% (Value Signal)

**What:** Free cash flow yield (FCF / market cap) above 8%, screened against sector peers.
**Direction:** Long (value-oriented, longer hold)
**Edge:** FCF yield is the most reliable valuation signal for mature companies. P/E can be manipulated; FCF is harder to fake. High FCF yield + buybacks = strong shareholder return.
**Kairos dimension:** fundamental_score (+12)
**Regime sensitivity:** Value works in ALL regimes over 12+ month horizon. Short-term, value lags in momentum/bull markets.
**Decay:** 90â€“180 days (valuation-based signal).

---

## 10. Volume Breakout Above Resistance

**What:** Stock breaks through a price level that acted as resistance â‰¥ 3 times, on volume > 1.5Ã— 20-day average.
**Direction:** Long
**Edge:** Resistance â†’ support flip. Large volume confirms institutional participation (not retail fluke).
**Kairos dimension:** technical_score (+15 when confirmed with volume; +7 without volume confirmation)
**Regime sensitivity:** Bull/neutral. In bear, breakouts fail more often (60% failure rate in confirmed downtrend).
**Decay:** 15â€“30 days.

---

## Anti-signals (Lower score when present)

| Signal | Dimension | Adjustment |
|---|---|---|
| Revenue growth but margin compression > 100bps | fundamental | -8 |
| RSI > 80 + near 52-week high | technical | -10 |
| Insider sales cluster (2+ insiders selling simultaneously) | insider | -12 |
| Options market pricing 2Ã— normal move (uncertainty) | sentiment | -6 |
| Sector downgrade cycle (2+ analysts downgrade sector in 7 days) | fundamental | -7 |
| Earnings within 3 days (pre-event uncertainty) | technical | -5 |
| Stock < 50dMA and 50dMA declining | technical | -15 |
| Short interest < 2% (no squeeze potential; fully crowded long) | sentiment | -3 |

---

## Signal Correlation Matrix (Estimated)

High positive correlation means adding both signals doesn't give you more information:

| Signal A | Signal B | Estimated Correlation |
|---|---|---|
| EPS beat | Revenue acceleration | 0.65 (often co-occur) |
| Price > 50dMA | 52-week high proximity | 0.72 |
| Insider buying | FCF yield > 8% | 0.35 (moderate) |
| RSI < 30 | Short squeeze setup | 0.20 (low) |
| Analyst revisions up | EPS beat | 0.58 |

**Rule: Do NOT add two signals with > 0.8 correlation.** They are the same signal twice.

---

## Agent Instructions

1. Use this as your lookup table when computing `fundamental_score`, `technical_score`, `insider_score`, `sentiment_score`.

2. Never exceed Â±20 points from any single signal. Apply them additively but cap at 0 and 100.

3. When LearnerAgent identifies a new pattern from closed trades, propose it here with evidence_count and hit_rate before adding to the scoring engine.

4. Decay matters: a signal that fires but the trade is entered 5 days later has lower expected value. Penalize late entries.
