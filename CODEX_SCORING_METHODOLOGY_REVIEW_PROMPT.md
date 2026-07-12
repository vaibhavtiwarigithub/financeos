# Codex Review — Signal Scoring Methodology (US + India Pipelines)

You are a senior quantitative analyst and systems architect. You know systematic trading, alpha research, and production ML pipelines well. You have no prior context on this system — everything relevant is below.

Your job: **audit the scoring methodology, identify what is wrong or weak, and propose the best-practice architecture** for a retail swing-trading AI that wants to find genuinely good stocks, not just score high on a flawed rubric. Be concrete. Propose specific changes, not vague "improve this."

---

## System Overview

**Kairos** is an AI-driven personal trading system for a single user. Goals:
- US swing trades: 2–20 market-day hold
- India swing trades: same horizon, NSE/BSE equities
- $10k USD NAV, max 10% per position = max 10 concurrent US positions
- 3 new screener candidates/day (not 5) — low churn
- Long-only for new positions. SELL signals for held positions only.
- Paper trading today, live trading soon with Robinhood (US) and Zerodha Kite (India)

---

## Current Scoring Architecture

### Step 1: Symbol gathering
- US: Robinhood held positions + curated watchlist + FinancialDatasets screener (`screen_stocks`)
- India: Zerodha Kite held positions + watchlist + NSE/Yahoo screener

### Step 2: Data fetch (parallel, per symbol)

| Source | Data | Notes |
|---|---|---|
| FMP (FinancialDatasets) → AV fallback | Fundamentals: PE ratio, profit margin, ROE, EPS, revenue growth YOY | FMP preferred (250/day budget). AV fallback (25/day). India uses Yahoo Finance |
| Alpha Vantage RSI / EMA | RSI(14) daily, EMA(20/50) daily | Used to compute `technical_score` |
| US candles: Massive → EODHD → Twelve Data → AV | OHLCV for local RSI/EMA computation | Cascading fallback |
| India candles: Upstox → Yahoo | OHLCV | |
| StockTwits + AV NEWS_SENTIMENT | Social bullish/bearish %, news sentiment | US stocks only |
| SEC EDGAR Form 4 → AV INSIDER_TRANSACTIONS | Recent insider buy/sell in 90 days | US individual stocks only (not ETFs, not ADRs, not India) |
| `macro_regime` table | MacroSentinel weekly regime (GREEN/YELLOW/ORANGE/RED) + danger score 0-100 | Written by MacroSentinel agent weekly |

### Step 3: Deterministic score computation (`lib/data/scores.ts`)

5 dimensions computed from raw data, each 0-100:

#### `fundamental_score`
```
Start at 50.
+ PE < 15: +20, PE 15-25: +10, PE 25-40: -5, PE 40-60: -15, PE > 60: -25
+ profit_margin > 20%: +20, > 10%: +10, < 0: -20
+ ROE > 20%: +15, > 10%: +8, < 0: -10
+ EPS > 0: +5, < 0: -10
+ revenue_growth_yoy > 20%: +15, > 10%: +8, < 0: -10
Clamp to [0, 100].
ETF baseline: 55 (no company fundamentals).
No data: 55 (same ETF baseline — undifferentiated from ETFs).
```
**Known issues**: Only 5 fields. No FCF yield, no debt/equity, no forward P/E, no earnings surprise quality, no sector-relative P/E. A PE=30 tech stock and a PE=30 utility are scored identically.

#### `technical_score`
Computed from candle OHLCV. RSI(14) + price vs EMA(20 or 50):
```
RSI > 70: score + (RSI - 50) * ~1.5 (momentum boost)
RSI < 30: low score (oversold territory)
Price above EMA: bullish modifier
Requires ≥ 15 candles; returns 50 if insufficient.
```
**Known issues**: RSI + single EMA only. No volume confirmation, no MACD, no Bollinger bands, no relative strength vs sector or market index, no price pattern (higher highs/lows), no volatility-adjusted momentum. RSI can mislead in trending markets (RSI 75 in a bull run vs RSI 75 near a blow-off top — treated identically).

#### `sentiment_score`
```
Source priority: sentiment_score field → stocktwits_bullish_pct vs stocktwits_bearish_pct → av_news_sentiment → label fallback
StockTwits: (bullish% / (bullish% + bearish%)) * 100
AV news: (-1..+1) → (value + 1) * 50
```
**Known issues**: StockTwits is retail noise, highly gameable, and often correlated with recent price movement rather than predictive of future price. AV news sentiment is 3-day lag. No institutional sentiment, no options-implied sentiment, no dark pool data, no short interest trends.

#### `macro_score`
```
Source: macro_regime table (latest row with known regime)
MacroSentinel produces danger_score 0-100 weekly.
macro_score = 100 - danger_score
regime = "unknown" → score 50, dimension excluded from weighting
```
**Known issues**: 
- Single global macro score applied to all symbols equally. A macro score of 30 (risk-on) applies identically to a defensive utility stock and a high-beta semiconductor. No sector-specific macro sensitivity.
- Weekly cadence — 7-day lag between macro shifts and score updates.
- MacroSentinel failing (producing "unknown") has happened repeatedly (latest: 2026-07-06), knocking macro out for the entire following week.
- danger_score→macro_score inversion is crude: "low danger = bullish" ignores that a very low danger score during an obvious bubble is still dangerous.

#### `insider_score`
```
Source: SEC EDGAR Form 4 → AV INSIDER_TRANSACTIONS fallback
Requires ≥ 3 transactions in past 90 days with calculable buy/sell value.
buyRatio = buyValue / (buyValue + sellValue)
100% buying → score ~90, 100% selling → score ~10, balanced → 50
Skipped for: ETFs, ADRs (foreign companies), India stocks.
Score 50, available: false if: no data / < 3 transactions / no value.
```
**Known issues**:
- Excluded for most signals in practice (ETFs ~40% of screener, ADRs ~20%, and individual US stocks with < 3 recent transactions ~30%). Effectively only fires for ~10% of signals.
- 15% weight assigned to a dimension that almost always returns "unavailable" — weight gets redistributed to other dims via renormalization, creating unpredictable effective weight profiles.
- 90-day window and 3-transaction minimum is strict. Many legitimate small/mid-cap stocks have infrequent insider activity.

### Step 4: Weighted analyst score

```typescript
// Weights (balanced risk profile, default):
fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10

// Dimensions marked available:
included = {
  fundamental: !isEtf && hasMinFundamentalFields(overview),
  technical: candleCount >= 15,
  sentiment: socialResult.has_data,
  macro: regime !== "unknown",
  insider: insiderResult.available,  // almost always false
}

// If ≥ 2 dims included: renormalize weights across included only.
// If < 2 dims: use fixed weights (no renorm) → score is thin evidence, abstain.
```

**Known issues**:
- Flat linear weighting with no interaction effects. A 100/100/50/50/50 signal scores identically to a 70/70/70/70/70 signal (both give ~73 analyst_score with balanced weights) despite very different risk profiles.
- Renormalization can create extreme effective weights: if only fundamental + technical are available (2/5 dims), they split 55%/45% — technical becomes as influential as fundamental despite fundamental being the dominant alpha source for value.
- No penalty for contradictory signals (e.g. high fundamental + very low technical = chasing a falling knife).

### Step 5: LLM thesis

LLM receives pre-computed scores + raw evidence summary. Outputs ONLY:
- `direction`: "long" / "neutral" / "short" (short only for held positions)
- `summary`: 2-3 sentence narrative
- `key_risks`: []
- `catalysts`: []

LLM is NOT allowed to override or generate scores. Direction determination is LLM opinion based on the score context.

**Known issues**:
- High quantitative scores often produce "neutral" direction because the LLM lacks confidence or sees contradictory signals in the narrative. Today's run: TEM=96, AVGO=91, IVV=89 — all "neutral" despite being above any reasonable entry threshold.
- Direction is a binary LLM opinion, not derived from the quantitative score. This creates a disconnect: a score of 96 does not automatically trigger "long."
- The LLM has no track record feedback: it doesn't know how prior "long" calls with score 80-90 performed.
- `deepseek-v4-flash` / `deepseek-v4-pro` used for this step — cost-optimized but may not have the reasoning quality needed to integrate 5 quantitative dimensions into a confident directional call.

### Step 6: Signal storage

Written to `agent_signals` with: `symbol`, `direction`, `analyst_score`, `conviction`, 5 dimension scores, `market`, `status: pending`.

---

## India Pipeline Differences

India symbols use fewer dimensions due to data availability:

| Dimension | US | India |
|---|---|---|
| Fundamental | FMP → AV → Yahoo | Yahoo only (sparser: PE, EPS sometimes missing) |
| Technical | Massive → AV cascade | Upstox → Yahoo candles |
| Sentiment | StockTwits + AV news | **Not available** — skipped |
| Macro | MacroSentinel (global) | Same global `macro_regime` — no India-specific macro |
| Insider | SEC EDGAR → AV | **Not available** — NSE/BSE filings not integrated |
| Analyst | Finnhub | **Not available** |

India typically has only 2 usable dimensions: fundamental + technical. Macro is the 3rd if MacroSentinel produces a known regime. India signals are often thin-evidence (2/5 dims) meaning the LLM abstains more frequently.

**Known India issues**:
- Global macro (US Fed / VIX / yield curve) applied to Indian equities. Indian markets have a separate regime driven by RBI policy, INR/USD, FII/DII flows, SEBI rules — none of which MacroSentinel captures.
- No NSE sectoral index relative strength (e.g. Nifty IT vs Nifty 50).
- Yahoo Finance India data quality degrades for small/mid-caps: missing PE, ROE, margin fields → fundamental_score defaults to 55.
- NSE F&O data (India options) is available via Kite but not integrated.
- No StockTwits India equivalent (Telegram group sentiment, Moneycontrol discussion — all unintegrated).

---

## Observed Problems in Production

1. **Macro score 50 for all signals when MacroSentinel fails** — now fixed with fallback to previous valid row, but underlying fragility remains: one bad MacroSentinel run locks macro out all week.

2. **Insider score 50 for all signals** — ETFs (no insiders), ADRs (exempt from Form 4), and stocks with < 3 transactions all return 50/unavailable. Effectively macro + insider = 0 differentiation on most runs.

3. **ETFs score high on analyst_score** — EUAD (98), DXJ (93), IVV (89), SCHD (87) appear as top signals. These are index ETFs that track momentum factors well but are not the "good stocks" the user wants. Should ETFs be a separate bucket with separate logic?

4. **Neutral direction despite high scores** — TEM (96, neutral), AVGO (91, neutral), IVV (89, neutral). 40-50% of top signals are "neutral," causing paper_trader to skip them. If the quantitative score is 96, why is the LLM saying "neutral"? The scoring and direction systems are misaligned.

5. **fundamental_score: 55 for many stocks** — LNG, TEM, AVGO, SPOT all showed 55, meaning fundamental data fetch failed (FMP/AV rate limit or wrong symbol format). The 55 baseline is indistinguishable from ETF baseline.

6. **No relative strength** — a stock with RSI=65 in a bear market and RSI=65 in a bull market get the same technical score. No beta-adjusted, sector-relative, or market-relative momentum.

7. **Linear scoring ignores signal interactions** — strong sentiment + weak fundamental + weak technical could still score 65. A real analyst would discount this heavily (retail hype without fundamental backing).

8. **No volume signal** — price moving on low volume is less meaningful than high-volume breakout. Volume not included anywhere.

---

## Questions for Review

**Architecture questions:**

1. Is a 5-dimension linear weighted score the right primary scoring model for 2-20 day swing trades? What is the academically/practically sound alternative? (Factor models? Rank-based IC weighting? ML scoring?)

2. Should ETFs and equities use completely separate scoring pipelines? What should the ETF scoring look like?

3. Should `direction` (long/neutral/short) be derived mechanically from the `analyst_score` threshold, or should the LLM retain discretion? What is the right architecture for direction determination?

4. Should macro be applied globally or per-sector/per-symbol? What is the right granularity and cadence?

5. Is insider signal worth including given its near-zero coverage? What's a better alternative that fires more often?

**Signal quality questions:**

6. What specific additional factors (computable from freely/cheaply available data) would most improve 2-20 day swing trade alpha? Rank by expected information coefficient.

7. Sentiment from StockTwits is retail noise. What's a better sentiment signal for swing trades?

8. The technical score only uses RSI + EMA. What technical factors should be added, and what is the minimum set that is actually predictive for swing trades (not just everything from TA textbooks)?

9. How should the scoring handle high score + contradictory sub-signals (e.g. bullish sentiment, bearish fundamentals)? Should there be a "contradiction penalty"?

10. What is the right way to handle "no data" dimensions? The current 55 neutral baseline is problematic — how should missing fundamental data be handled?

**India-specific questions:**

11. With only fundamental + technical reliably available for India equities, is the current scoring approach reasonable? What is the best possible scoring with: Yahoo Finance fundamentals (sparse), candle data (Upstox), no sentiment/insider/analyst?

12. What India-specific signals should replace or supplement the US-centric ones (insider Form 4, StockTwits, SEC EDGAR)? Consider: FII/DII flows, NSE sectoral indices, Zerodha F&O OI data, NSE bulk/block deals.

13. Is global MacroSentinel (US-centric: Fed, VIX, yield curve) appropriate for Indian equities? What macro indicators should a separate India MacroSentinel track?

**LLM role questions:**

14. The LLM is currently used only for: (a) thesis narrative, (b) direction determination. Given that direction is often wrong (neutral despite high scores), should the LLM be given MORE quantitative responsibility (e.g. synthesize additional signals it retrieves) or LESS (make direction fully mechanical)?

15. Is the current research flow (deterministic scores → LLM thesis) the right architecture? What would you change about this two-phase approach?

---

## Constraints and Priorities

- Free or low-cost data sources preferred (AV 25/day, FMP 250/day, SEC EDGAR unlimited, Finnhub free tier, StockTwits free)
- No Python ML pipeline — scoring runs in TypeScript/Next.js on Vercel serverless, 60s max execution per symbol
- Screener target: 3 candidates/day (low churn), not a comprehensive scan
- Goal is to find **genuinely good 2-20 day swing trades**: momentum setups with fundamental backing or value setups with technical inflection, not ETF price-followers or retail noise-driven signals
- The user is not a quant — the system must explain its reasoning simply ("NVDA: strong momentum, bullish sentiment, PE 28 reasonable, enter long")

---

## What a 10/10 Answer Looks Like

Concrete, specific proposals for:
1. Revised scoring formula or model (with exact factors, weights or weighting mechanism)
2. Direction determination architecture (mechanical vs LLM vs hybrid)
3. India-specific scoring approach
4. What to do about insider/macro dimension fragility
5. What to add / remove from the current 5-dimension model
6. ETF handling
7. Additional data signals worth integrating (specific APIs, endpoints, cost)

Do NOT give generic "add more data" or "use ML" advice without being specific about what data, what model, what the implementation looks like, and whether it fits the constraints above.
