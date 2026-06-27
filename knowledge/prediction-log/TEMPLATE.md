# Prediction Log Template

> Copy this file for every new prediction. Name it: YYYY-MM-DD-TICKER-direction.md
> LearnerAgent reads all files in this directory to calculate signal accuracy.

---

## Prediction: [TICKER] [UP/DOWN/SIDEWAYS] by [DATE]

**Created:** YYYY-MM-DD  
**Created by:** [AnalystAgent / User / ResearchAgent]  
**Regime at time of prediction:** [low_vol / high_vol / crisis]

---

### Hypothesis
*What are you predicting and why, in one sentence?*

---

### Signal Breakdown at Time of Prediction

| Signal | Value | Weight | Score |
|---|---|---|---|
| Momentum | | 0.20 | |
| Technicals (RSI/MACD) | | 0.15 | |
| News sentiment | | 0.20 | |
| Insider buying | | 0.15 | |
| Earnings revision | | 0.15 | |
| Social velocity | | 0.10 | |
| User thesis | | 0.05 | |
| **Composite** | | | **/100** |

---

### Trade Action (if taken)
- **Action:** Buy / Sell / Hold (no trade)
- **Entry price:** $
- **Position size:** $ (X% of account)
- **Target price:** $
- **Stop loss:** $
- **Timeframe:** X days

---

### Outcome (filled by LearnerAgent when resolved)

**Resolution date:** YYYY-MM-DD  
**Resolved price:** $  
**Direction correct:** Yes / No / Partial  
**P&L:** $ (X%)  
**Prediction correct:** Yes / No  

---

### What the Agent Learned

*LearnerAgent fills this section.*

**Which signals were right:**

**Which signals were wrong:**

**Regime context — did regime match signal weights:**

**Signal weight adjustment triggered:**
- Signal: [name] → weight change: [old] → [new]
- Reason:

**Update to knowledge base:**
- [ ] Updated signal correlation matrix
- [ ] Updated signal live Sharpe
- [ ] Updated event-pattern file (if macro event was involved)
