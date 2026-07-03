# Earnings Event Patterns

> **Agents: Read before scoring any stock in the 5 days before or after earnings.**
> Source: academic literature (Livnat & Mendenhall, Bernard & Thomas), Goldman/JPM quantitative research.

Confidence: HIGH (well-replicated in academic literature)
Last updated: 2026-07-01
Evidence count: 0 live

---

## 1. Pre-Earnings Behavior (T-5 to T-1)

### Drift toward consensus

**If analyst consensus is bullish (≥ 65% Buy ratings):**
- Stock tends to drift +0.5% to +1.5% in week before earnings
- Volume increases 20–40% vs. 20-day average by T-2
- This drift is exploitable but fades in liquid large caps; stronger in small/mid cap

**If consensus is mixed or bearish:**
- Stock often drifts down -0.3% to -0.8% in week before
- Market makers widen spreads; options IV spikes most on T-3 to T-1

### Implied move (options market)

Earnings implied move = (ATM straddle price / stock price) × 100%

**Historical hit rate:**
- Stock moves EXCEED the implied move ~35% of the time
- Stock moves stay WITHIN the implied move ~65% of the time
- **Edge:** Selling straddles has edge statistically, but the 35% tail risk can be -2× to -3× the premium received — position sizing is critical

**Calibration:**
- Large caps (>$100B): implied move is usually 3–5%, actual move often 2–4% (implied overpriced)
- Mid caps ($10B–$100B): implied move is often accurate
- Small caps (<$10B): implied move underprices actual volatility ~45% of the time

---

## 2. Earnings Reaction (T+0, the announcement day)

### Beat on EPS + Beat on Revenue (Clean Beat)

**Typical immediate reaction (after-hours or next open):**
- Large cap: +2% to +4% (partially priced into drift)
- Mid cap: +3% to +6%
- Small cap: +4% to +10%

**What amplifies the move:**
- Guidance raised (strongest signal — forward-looking)
- Beat on gross margin (shows pricing power, not just cost-cutting)
- Management tone: specific, confident language → larger move
- Short interest > 15% → squeeze amplifies

**What mutes the move:**
- Large cap already near 52-week high (priced for perfection)
- Beat driven by one-time items (asset sales, tax reversals)
- Weak next-quarter guidance despite current-quarter beat
- Revenue beat but gross margin compressed → "revenue at any cost" = bearish longer-term

---

### Miss on EPS or Revenue (Miss)

**Large cap:**
- EPS miss: -3% to -6%
- Revenue miss: -4% to -8% (worse than EPS miss because revenue is harder to manage)
- Both miss: -6% to -12%

**Mid/small cap:**
- More severe: -6% to -15% on combined misses
- Guidance cut adds -3% to -5% on top

**Worst case triggers:**
- "Pull forward" language (pandemic-era demand borrowed from future)
- "Macro environment" guidance cuts (vague → fear of unknown downside)
- CEO/CFO resignation announced alongside miss → -5% additional

---

### Beat on EPS, Miss on Revenue ("Quality" miss)

- Stock reaction is mixed; usually flat to -1%
- If EPS beat is from buybacks (EPS up but shares down) → market ignores, often -1%
- If EPS beat is from margin expansion → market mildly positive

---

### In-line (as expected)

- Large cap: +0.5% to -0.5% (buy-the-rumor-sell-the-news common)
- Small/mid cap: -0.5% to -1.5% (market wanted more)
- **Pattern:** Stocks that rally hard into earnings on in-line results often gap back to pre-earnings price within 3–5 days

---

## 3. Post-Earnings Drift (SUE — Standardized Unexpected Earnings)

This is the most academically robust earnings pattern.

**The Post-Earnings Announcement Drift (PEAD):**
- First documented by Bernard & Thomas (1989)
- Still persists today, especially in small/mid cap
- A stock that beats by 2+ standard deviations tends to outperform by +3% to +7% over the following 60 days
- A stock that misses by 2+ standard deviations tends to underperform by -3% to -7% over the following 60 days

**Why it persists:**
- Analyst consensus updates slowly (anchored to prior estimates)
- Retail investors react on next-day headline, then lose interest
- Institutional funds take weeks to build/reduce positions at scale

**Agent action:** After a clean beat, hold for 30–45 days if technical signals remain positive. Do not exit on the first 5% gain if the SUE score is high.

---

## 4. Earnings Season Context

### "Whisper Number" vs. Official Estimate

Actual earnings beats are measured against the whisper number (implied by options market), not the official consensus. A stock can beat the official EPS estimate but trade down if the whisper was higher.

**Heuristic:**
- Pre-earnings IV spike of >40% implies whisper meaningfully above consensus
- If consensus beat is < 5%, check how much IV was pricing in — if IV implied a 6% move and stock gaps 3%, it's still a "miss"

---

### Early vs. Late Reporters

**Early in earnings season (1st week):**
- Bellwether reports (JPM, WFC, Delta, FAST, etc.) set tone for the sector
- A surprise beat from JPM often lifts all banks for 1–3 days
- Negative pre-announcements from bellwethers can wipe 2–5% from sector ETFs

**Late reporters:**
- By week 3–4, market has already adjusted expectations
- Late reporters have lower surprise reactions (market has more information)
- Exception: consumer/retail late reporters (WMT, TGT, COST) still move markets significantly

---

## 5. Sector-Specific Patterns

### Technology

- Revenue growth is valued more than EPS for high-multiple tech
- Cloud metrics (ARR, NRR, RPO) matter more than GAAP earnings
- Gross margin > 70% is table stakes; anything below is scrutinized
- Strong beat + guidance raise + buy-back announcement = +8% to +15% in growth environment

### Financials (Banks)

- Net Interest Margin (NIM): most important metric
- Provision for loan losses: surprise increases are very bearish (-4% to -8%)
- Credit quality (NPL ratio, charge-offs) is the leading indicator
- Trading revenue surprises are usually discounted (volatile)

### Energy

- EPS surprises matter less than oil price correlation
- FCF yield and buyback/dividend announcements drive stock performance
- Capex cuts viewed positively in current macro (returns focus)

### Retail/Consumer

- Same-store sales (comp growth) is the key metric
- Inventory growth > revenue growth = bearish margin signal
- Gross margin contraction > 100bps is a serious red flag
- Digital (e-commerce) mix and penetration increasingly important

### Healthcare/Biotech

- Different rules: trial data events dominate over financial earnings
- FDA decisions near earnings can overwhelm the financial surprise
- For large pharma: pipeline diversification and loss of exclusivity (LoE) risk > quarterly EPS

---

## 6. Red Flags in Earnings Quality

**Agents: Lower fundamental_score by 5–10 points if any of these appear:**

1. **Accounts receivable growing faster than revenue** (pulling forward revenue)
2. **Deferred revenue declining** (fewer customers paying upfront)
3. **Inventory buildup without revenue growth** (demand is softening)
4. **Operating cash flow < net income** (earnings not converting to cash)
5. **R&D expenses declining as % of revenue** (cutting seed corn)
6. **Customer concentration > 20% from one customer** (fragile revenue)
7. **Goodwill write-downs** (prior acquisitions destroyed value)
8. **Non-GAAP adjustments > 15% of GAAP** (management gaming)

---

## 7. Agent Instructions

**Before earnings (T-5 to T-1):**
- Flag in signal: `"earnings_within_5_days": true`
- Reduce analyst_score by 3–5 points (signal quality degrades near event)
- Check implied move vs. historical average move for the stock
- If RSI > 70 going into earnings: high buy expectation = risk of "sell the news"

**On earnings day (T+0):**
- Do NOT generate a signal until at least 30 minutes after open following the announcement
- Wait for initial gap to stabilize (first 30 min is noise)
- Check: did the stock beat the implied move or not?
- If beat + positive guidance + volume > 2× average: upgrade fundamental_score +5, insider_score +3 (management buying)

**Post-earnings (T+1 to T+30):**
- If stock gapped up ≥ 5% on clean beat: technical momentum valid, trend-follow
- If stock gave back > 50% of the gap in T+1 to T+3: signal is likely false positive — exit or reduce
- PEAD strategy: 30-day hold target for clean beats with positive guidance, stop at -7%

**Never trade earnings blind:**
- If you have no context on what the expected reaction should be, abstain and log it
- "I don't know what the whisper number is" is a valid reason to skip
