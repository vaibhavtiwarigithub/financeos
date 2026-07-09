# ChatGPT Response — Edge/Factor Discovery + Scout Upgrade Review

Date: 2026-07-08  
Reviewer: ChatGPT / Codex  
Reviewed file: `features/edge-factor-discovery/FEATURE_ARCHITECTURE.md`

## Executive answer

Claude’s architecture is directionally right: Kairos should stop treating an LLM
news/theme scout as the alpha source. The proven path is a deterministic factor
factory:

```text
LLM proposes and explains.
Deterministic formulas compute signals.
Statistics validate signals.
Risk/execution engines size and enforce.
Owner approves live money.
```

But the original draft needed corrections. It was too strict about requiring full
IC proof before any paper exploration, and too aggressive about using regime as a
hard master on/off switch. The better design is:

```text
ThemeScout = attention/candidate discovery only
EdgeScout / FactorScout = deterministic alpha discovery and validation
ResearchAgent = evidence + thesis explanation
Validation Engine = promotion authority
PaperTrader = exploration and measured simulation
Live Gateway = deterministic owner-gated execution
```

I updated `FEATURE_ARCHITECTURE.md` inline with these corrections.

## What best practice says through 2026

The strongest current/proven methodology is not “let an AI find stocks.” It is a
controlled alpha research factory:

1. Start from economically explainable factors or tightly scoped hypotheses.
2. Build point-in-time data.
3. Compute deterministic features.
4. Test rank IC / IR / forward returns by horizon.
5. Correct for multiple testing and selection bias.
6. Model costs, turnover, liquidity, and delay.
7. Validate out-of-sample and across regimes.
8. Run in shadow/paper before live.
9. Track live decay and retire degraded signals.

This matches the lessons from AQR/Robeco/Man/Research Affiliates style factor
implementation and the more recent academic work on transaction costs, ML
strategy implementability, and look-ahead bias.

## Key corrections made to the architecture

| Area | Original issue | Corrected design |
|---|---|---|
| ThemeScout role | Could still read like ThemeScout evolves into alpha | ThemeScout remains attention discovery only |
| Edge discovery | LLM-originated themes were too central | New EdgeScout/FactorScout computes deterministic factors |
| Paper exploration | Full IC proof before paper was too restrictive | Candidate edges may enter tiny capped exploratory paper |
| Normal sizing/live | Needed stricter gate | Normal paper sizing/live eligibility require IC/WFO/OOS/cost gates |
| Regime filter | Hard master switch too early | Continuous size scaler first; hard block later only with evidence |
| Statistical gates | t-stat ≥ 2 too weak for new data-mined factors | Known priors may shadow/paper at ~2; new factors need t-stat > 3 or FDR/q-value control |
| Data leakage | Point-in-time controls underweighted | Added mandatory input audit: source/as_of/available_at/revision/adjustment |
| Long-only reality | Factor logic often assumes long-short | Validate long-only top bucket vs benchmark/cash after costs |
| India pipeline | Same factor set implied for both markets | India starts with price/volume/relative-strength/sector breadth; fundamentals later |

## Right way to upgrade Scout

Do not make the current `ThemeScout` heavier. Split it.

### 1. Keep ThemeScout lightweight

Current ThemeScout can continue:

```text
news + movers -> themes -> verified tickers -> watchlist
```

But it must be labeled:

```text
Discovery only. Not alpha. Not trade permission.
```

It should not directly influence score, sizing, or live eligibility.

### 2. Add EdgeScout / FactorScout

This is the real alpha-discovery agent.

Daily flow:

```text
Build universe
Compute deterministic factors
Store edge_signals
Store point-in-time input audit
Compute IC/IR/t-stat/turnover/costs
Classify edge lifecycle state
Emit factor_score in shadow
Compare against current analyst_score
Promote only after validation
```

### 3. Start with 8–10 edges, not 60+

Start small. Too many candidate factors creates false positives and overfitting.

| Edge | US | India | Initial role |
|---|---:|---:|---|
| 12-1 momentum | Yes | Yes | Core candidate |
| Relative strength vs sector/index | Yes | Yes | Core long-only ranker |
| 50/200DMA trend with slope | Yes | Yes | Trend/risk context |
| Volatility-adjusted momentum | Yes | Yes | Risk-adjusted ranker |
| Short-term reversal in uptrend | Yes | Yes | Exploratory |
| FCF / earnings yield | Yes | Later | Needs reliable PIT fundamentals |
| Quality/profitability | Yes | Later | Needs reliable PIT fundamentals |
| PEAD / earnings surprise | Yes | Later | Needs earnings data quality |
| Insider cluster buys | Yes | Limited/no | US Form 4 stronger |
| News/sentiment surprise | Context only | Context only | Never standalone first |

### 4. Do not replace `analyst_score` immediately

Add separate fields/observations first:

```text
factor_score
factor_score_version
factor_edges_used
factor_data_confidence
```

Then compare:

```text
current score vs factor_score vs blended score
```

Only cut over after evidence.

## Minimum gates before an edge can matter

### Candidate / measure-only

- Formula compiles.
- Inputs exist.
- Economic rationale exists.
- No money impact.

### Shadow

- Point-in-time data proven.
- Enough historical observations.
- Forward-return labels available.
- No fills.

### Exploratory paper

- Early IC direction positive.
- Data confidence acceptable.
- Tiny capped allocation only.
- Excluded from live eligibility.

### Active paper

- Rank IC positive and stable.
- IR acceptable.
- Net-of-cost IC positive.
- Turnover/liquidity acceptable.
- Correlation to active edges < 0.8.
- Long-only top bucket beats benchmark/cash after costs.

### Live eligible

- Walk-forward/OOS pass.
- Monte Carlo/stress pass.
- Decay monitor clean.
- Owner approval required.

## What changed in the source doc

I updated:

- author/reviewer line;
- TL;DR language;
- Section 0A with the corrected methodology;
- design goals;
- promotion lifecycle;
- data model;
- rollout phases;
- references;
- reviewer changelog.

## Source-backed research notes

Relevant current/proven references used:

- [AQR — Understanding Factor Investing](https://funds.aqr.com/Insights/Strategies/Understanding-Factor-Investing): factor investing targets measurable traits like value, momentum, and quality.
- [Robeco — Guide to factor investing](https://www.robeco.com/docm/docu-robeco-guide-to-factor-investing-global.pdf): factors should have proven, persistent, risk-adjusted return characteristics.
- [CFA Institute — Complete Guide to Factor-Based Investing](https://rpc.cfainstitute.org/research/financial-analysts-journal/2017/your-complete-guide-to-factor-based-investing): useful factors should be persistent, pervasive, robust, investable, and intuitive.
- [Man Group — Factor Investing](https://www.man.com/insights/factor-investing): academic factors are not off-the-shelf recipes; transaction costs, crowding, risk management, and ongoing development matter.
- [Harvey, Liu & Zhu — ...and the Cross-Section of Expected Returns](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2249314): newly discovered factors need higher multiple-testing hurdles, commonly summarized as t-ratio > 3.
- [Bailey & López de Prado — Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf): selection bias and multiple testing inflate backtest Sharpe.
- [Benhenda — Look-Ahead-Bench, 2026](https://arxiv.org/pdf/2601.13770): point-in-time finance LLM workflows must be tested for look-ahead bias and decay across market regimes.
- [Azevedo, Hoegner & Velikov — Expected Returns on Machine-Learning Strategies](https://afajof.org/management/viewp.php?n=75544): ML/anomaly strategies can work after costs, but must account for transaction costs, post-publication decay, and stale historical data.
- [Baldi-Lanfranchi — Transaction-cost-aware Factors](https://afajof.org/management/viewp.php?n=135184): factor construction should explicitly optimize exposure versus rebalancing cost.
- [Research Affiliates — Transaction Costs of Factor-Investing Strategies](https://www.researchaffiliates.com/insights/journal-papers/718-transaction-costs-of-factor-investing-strategies): turnover and liquidity demand can materially erode factor returns.
- [Springer — Cost mitigation of factor investing in emerging equity markets](https://link.springer.com/article/10.1057/s41260-024-00353-4): emerging-market factor investing is especially sensitive to transaction costs.

## Final recommendation

Build this, but phase it:

1. Keep ThemeScout simple.
2. Build EdgeScout measure-only.
3. Add point-in-time audited edge signals.
4. Add IC dashboard.
5. Run factor_score in shadow.
6. Allow tiny exploratory paper.
7. Promote only validated edges to active paper.
8. Make live eligibility require WFO/OOS/MC, cost-adjusted long-only alpha, and owner approval.

This is the credible path toward a self-improving agentic trading platform. The
LLM should help discover and explain; the statistical system must decide what
earns capital.
