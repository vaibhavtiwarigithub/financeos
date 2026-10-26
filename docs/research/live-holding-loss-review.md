# Live-holding losses: evidence, daily review and the implementation boundary

Date: October 25, 2026. Owner: Vaibhav. Scope: US and India live-holding research.

## Decision summary

Daily owned-position research is an existing approved requirement. Restore its
coverage and truthful health reporting now. Do not turn an academic result or a
political narrative into an automatic exit/averaging rule. The conditional policy
below is a proposal for Architect review, not an enabled trading strategy.

Purpose: help the owner distinguish a broken thesis, an ordinary pullback and a
recovering holding without anchoring on purchase price. Expected benefit is more
complete, auditable decisions; improved returns have not been established.

## What the research supports—and what it does not

| Evidence | Reasonable inference | Important limit |
| --- | --- | --- |
| Kaminski and Lo, *When Do Stop-Loss Rules Stop Losses?* | A stop rule's contribution depends on return dynamics and sampling horizon. | Index-futures evidence does not establish a universal stop percentage for individual stocks. |
| Daniel and Moskowitz, *Momentum Crashes* | Rebounds after high-volatility market declines can sharply reverse loser/winner rankings. | Long-short momentum crashes are not a blanket instruction to buy declining companies. |
| Moreira and Muir, *Volatility-Managed Portfolios* | Volatility can inform how much risk to carry. | Later broad tests find no systematic out-of-sample superiority across all strategies. Never infer a guaranteed improvement. |
| Dallas Fed analysis of economic-policy uncertainty | Policy uncertainty can affect valuation and risk; scenario context is relevant. | Political-party identity or a headline alone does not identify a profitable trade. |
| SEC stop-order bulletin | Stop-market execution can slip; stop-limit orders can remain unfilled. | A displayed level, software watcher or acknowledged trigger is not a guaranteed loss cap. |

Primary sources:

- https://dspace.mit.edu/entities/publication/bb69ca4b-0cdc-487f-831d-63b2e84fafee
- https://www.nber.org/papers/w20439
- https://www.nber.org/papers/w22208
- https://www.lehigh.edu/~xuy219/research/COWY.pdf
- https://www.dallasfed.org/research/economics/2019/1119
- https://www.newyorkfed.org/research/staff_reports/sr174.html
- https://www.matteoiacoviello.com/gpr.htm
- https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-15

## Existing daily infrastructure and verified repair

Reuse `fetchHoldings`, `fetchIndiaHoldings`, holdings-first `gatherSymbols`, the
existing research cron, immutable observations, research-journal details, and
the existing risk research-annotation join. Do not add another scoring service,
copy the exit-ladder math, or create a parallel holdings ledger.

Read-only production check: all **50 distinct US symbols** in the latest stored
live snapshots had a non-null holding-path score dated October 23, 2026 in US
market time. Snapshots were taken October 23; this is not confirmation of holdings
after that capture. Daily jobs exist for both markets. Closed-day catch-up does
not create a fresh executable-market signal.

Three bounded corrections:

1. A fulfilled Kite `{ok:false}` or malformed payload no longer clears the
   live-holdings failure warning. Warnings remain until a verified holdings read.
2. Only holding-path scores refresh held-symbol review priority. Candidate
   research cannot masquerade as a completed owned-position review.
3. US live snapshot extraction excludes simulated/India books while retaining
   Robinhood, Webull and Alpaca-live symbol coverage. Independent paper research
   remains supported through its own market-scoped source.

No new schedules, paid subscriptions, automatic inference tests, score/weight
changes, stop placements or broker orders are introduced. This does not guarantee
every holding completes every session under outages/budgets: failures and deferrals
must remain visible, and next natural runs must confirm the repaired behavior.

## Proposed conditional review policy—not implemented or validated

Review every currently held symbol, not just losers. Use the original cost basis
only for accounting, tax-lot context and describing the owner's loss. Assess
forward risk from the current executable value; never relabel a recovery-plan
reference price as true investment breakeven.

| Observed condition | Review question | Constraint |
| --- | --- | --- |
| Persistent relative weakness, worsening company evidence | Is the thesis broken or the position too large for its remaining risk? | Do not wait for a rebound merely to avoid realizing a loss. |
| Market/sector pullback with intact company evidence | Is a retained position justified within the account's risk budget? | A low price alone is not eligibility to add. |
| High-volatility decline followed by broad recovery | Is an indiscriminate stop causing whipsaw or missing a genuine reversal? | Require timestamped confirmation; no guaranteed rebound assumption. |
| Range-bound/noisy market | Would turnover and repeated stop-outs overwhelm the proposed benefit? | Evaluate realistic costs, gaps and missed recoveries. |
| Earnings, regulatory or geopolitical shock | What changed in cash flows, financing, supply chains or demand for this issuer? | Cite actual sources and publication times; missing evidence means unknown. |
| Leveraged/inverse fund | Is underlying-index direction, session policy, liquidity and compounding risk acceptable? | Do not apply company fundamentals or ordinary multi-day stock rules blindly. |

A future daily review packet should reuse the existing frozen research evidence:
broker/account and quantity; actual cost basis; current price and timestamp;
instrument family; holding-path scores and formula versions; trend, relative
strength, volatility and volume; dated company/catalyst evidence; macro and
sector context; existing stops/open sell orders; and explicit missing fields.

Regime context must be derived from observed, timestamped inputs: market trend
and breadth, volatility, rates, inflation/growth, credit/liquidity and sector
conditions where available. Macro releases have lags and revisions. Historical
comparisons must use data actually available then, not revised hindsight values.
Political events become sourced exposure scenarios, not partisan trading rules.

### Economic and political context checklist

The following are proposed review questions inferred from the research, not
validated Kairos return predictors or rules to switch on automatically:

- **Unexpected tightening / worsening credit:** examine refinancing needs,
  balance-sheet resilience and sensitivity to discount rates before calling a
  decline an opportunity. An anticipated rate decision is not the same shock
  as an unexpected decision.
- **Disinflation/easing with improving breadth:** test whether company evidence
  and relative strength actually improve. Easing during a deteriorating recession
  is not sufficient evidence to buy.
- **High-volatility panic and subsequent rebound:** compare trend-break risk
  against reversal/whipsaw risk. Maintain loss/exposure constraints rather than
  assuming either permanent collapse or guaranteed recovery.
- **Inflation or supply shock:** distinguish producers from input-cost consumers,
  and inspect the issuer's real exposure. A generic energy/commodity label is
  insufficient to infer the direction or size of a benefit.
- **Election, tariff, sanction or regulatory event:** use dated enacted/proposed
  policy evidence, affected revenues/costs and uncertainty scenarios. Do not
  trade on party identity or treat a proposal as enacted law.

The New York Fed study concerns unanticipated US monetary-policy changes;
geopolitical-risk research concerns risk exposure and economic effects. Neither
establishes a universal stock-level entry/exit threshold, nor transfers a US
result to India without separate validation.

Potential output states: insufficient evidence, thesis review, risk reduction
review, monitored recovery, or independently eligible re-entry/add review. These
are proposal labels, not present API fields or execution instructions.

## Proposed stop/ladder contract

An account-approved maximum additional loss determines allowable remaining risk.
For a long holding, a proposed invalidation stop must be below a fresh reference
price and compatible with volatility/market structure. If quantity times stop
distance exceeds the budget, evaluate reducing quantity; do not silently widen
the budget or loosen an existing stop. Gap losses can exceed this estimate.

Conditional rebound reductions require declared fractions and levels, cumulative
quantities capped by actual remaining holdings, broker-aware fractional rules,
and no repeat sale after a partial fill. Trail only upward. Existing protective
orders must be reconciled before any competing sell or cancel/replace. A broken
thesis must not be held indefinitely waiting for a recovery ladder.

Keep these choices separate from the shared execution core. Applying a new
reference price to an old losing lot must not fabricate a new entry, erase P&L,
inherit an incompatible high-water mark, or force the old cost-basis breakeven
runner rule onto a recovery position below that price.

## Validation and rollout required before trading changes

- Architect reviews this conditional policy and its precise data/output contract.
- Record account-by-account authority, allowed instruments, capital/exposure and
  loss limits, existing-holding treatment, and activation duration where required.
  Primary Robinhood remains excluded from execution.
- Verify current holdings, quantity, cost basis, corporate actions and existing
  broker stops. Missing live snapshots are not an empty portfolio.
- Compare frozen hold/current-policy/proposed-policy outcomes on matched cohorts
  with realistic costs and conservative gap/fill assumptions. Include missed
  recoveries and opportunity cost as well as drawdown; IC alone is insufficient.
- Separate US/India, instrument families and horizons. Avoid stock-specific
  overfitting and repeated tuning on inspected test data. Register a bounded
  candidate set and verify forward performance before promotion.
- Prove per-broker protective lifecycle, idempotency, partial fills, cancellation,
  restart recovery, health escalation and the existing kill switches before
  enabling any new order-capable path. No live order is a verification shortcut.

## Honest completion status

Daily source/priority/health corrections are implemented and tested separately.
Regime-adaptive loss ladders, universal broker-hosted stops and automatic dip
buying are **not** implemented by these repairs and are not claimed proven.
Full deployment/readback evidence belongs in WORK_LOG at release handoff.

Verification: focused holding/annotation tests **66 passed**; the updated source
contract and holding tests also passed. Final full suite **4,433 passed, eight
skipped, zero failed** across 533 passing files and one skipped file. TypeScript,
secret scans and diff checks passed. The first full run had one source-text
assertion tied to the prior function arity; it now requires the holding-only
argument explicitly, and the subsequent full run passed. No tests used live
broker orders or additional production model inference.

The existing daily watchdog now checks market-local held-symbol research coverage,
not merely job completion, with its daily schedule unchanged. This is monitoring
and bounded repair authority, not an additional inference/research dispatch loop.
