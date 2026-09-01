# External strategy discovery

> Status: **DRAFT — for owner approval. No code written. Nothing activated.**
> Date: 2026-09-01. Influence if approved: **none.** Every stage is measure-only;
> paper activation and live activation are separate, later owner decisions.
>
> Supersedes `features/strategy-library-shadow/FEATURE_ARCHITECTURE.md` (2026-09-01),
> which proposed the same idea without the legal boundary, without the
> combination design, and while assuming a foundation that does not fully exist.

## Purpose

Turn a public catalogue of published trading strategies into a controlled
research funnel that answers a portfolio question, not a return question:

> **What role does this strategy play, and does adding it improve the portfolio
> we already have?**

Explicitly NOT "crawl 200 strategies and activate the winners."

---

## 1. Legal and ethical boundary — binding

The catalogue's [`robots.txt`](https://www.quantifiedstrategies.com/robots.txt)
permits crawling, but its
[copyright policy](https://www.quantifiedstrategies.com/copyright/) **prohibits
copying or reproducing content**, while allowing fair-use reference with
attribution.

Therefore, as a hard constraint on any implementation:

- **Store only public metadata**: title, URL, category, publication/update date.
- **Store only independently written rule specifications**, in our own words,
  with source attribution. A rule is an idea; the article is their property.
- **Never store** article text, charts, images, paid rules, or their code.
- **Exclude** `/shop`, `/member`, `/amember`, paid downloads and gated content.
- **Rate-limit politely**, and prefer requesting written permission before
  automating hundreds of article fetches.
- Firecrawl (or any crawler) is a **local research-ingestion tool, never a
  production dependency**. Firecrawl was unavailable in both the Claude and
  Codex sessions of 2026-09-01 (`CONNECT_TIMEOUT`); the pages are static HTML so
  a plain fetch suffices.

Catalogue size measured 2026-09-01: **408 unique internal links, ~356 candidate
content pages, 70+ categories.**

---

## 2. What the foundation ACTUALLY is (verified, not assumed)

An earlier draft of this proposal described these as an existing foundation. They
were checked against production on 2026-09-01:

| component | state | evidence |
|---|---|---|
| `lib/simulation/portfolio-simulator.ts` | **real, tested** | used by Alpha Lab A6 |
| `lib/validation/` (engine, genome, calibration, feature-compiler) | **real** | 8 modules |
| `strategy_templates` | **real** | 7 rows |
| `strategy_sleeves` | **real** | 7 rows |
| `backtest_experiments` | **real** | 18 rows |
| `strategy_evaluations` | **EMPTY** | **0 rows — the validation pipeline has never written an evaluation** |
| `strategy_template_shadow_configs` | **NOT DEPLOYED** | `to_regclass` returns null; the migration file is untracked and was never applied |
| `features/strategy-portfolio-lab` | **untracked draft** | not in git |
| `features/portfolio-simulation` | **untracked draft** | not in git |

**Consequence for sequencing.** Extending these is still the right call — we must
not build a second backtester or a second shadow engine. But two of them are
drafts, one table was never deployed, and the validation pipeline has never
produced a single evaluation. **Stage 0 below exists to close that gap first.**
Building discovery on top of an unproven pipeline would mean debugging two new
things at once.

---

## 3. The funnel

```
public catalogue (metadata only)
  -> reproducibility filter
  -> frozen deterministic rule specification
  -> point-in-time replay
  -> cost / stress / walk-forward OOS gates
  -> at most 3 forward shadows per market
  -> owner-reviewed paper sleeve
  -> tightly capped live trial (separate approval)
```

The app may recommend `continue`, `retire`, `prefer A`, `prefer A+B`, `pause`, or
`submit for owner review`. **It may never activate a strategy on its own.**

---

## 4. Reproducibility filter — what is excluded and why

Excluded by construction, before any statistics:

- **Intraday and exact-close systems.** This book is EOD with a 2-20 market-day
  swing mandate. A close-entry-on-the-same-close rule is also a look-ahead: the
  catalogue's own Turnaround Tuesday article acknowledges this. Where a rule needs
  closing information to act, replay must use **next-open** execution.
- **Futures, forex, crypto, CFDs, options, leveraged products.** Out of mandate.
- **Short-selling and market-neutral pairs.** The mandate is long-only for new
  positions.
- **Paid or incompletely specified rules.** We would be testing a guess.
- **Rules needing data we do not have** point-in-time: sentiment history, market
  breadth, index-constituent history.
- **India translations of US effects** without an independently stated India
  hypothesis. A US seasonal effect is not evidence about NSE.

Also classified separately, not excluded:

- **Index-level calendar rules** (Turnaround Tuesday, Turn of the Month, Santa
  Claus Rally) produce the SAME signal for every symbol on a date. They carry
  **zero cross-sectional rank information** — the identical defect measured in
  `macro_score` on 2026-09-01, where the value was constant across 49 of 49 US
  dates. They must be evaluated as **market-timing / exposure overlays**, never
  mixed into a selection composite.

---

## 5. First trial family — six US strategies

Frozen before replay. US only; India does not begin until the US
ingestion/replay contract is proven.

| candidate | family | treatment |
|---|---|---|
| SPY 200-day MA | trend | replay unchanged |
| RSI(2) on SPY | mean reversion | replay with a frozen RSI definition |
| Turnaround Tuesday | calendar / reversal | **rewrite execution as next-open** |
| NR7 | volatility contraction | daily replay |
| Turn of the month | seasonality | calendar-safe replay |
| Monthly asset rotation | rotation | portfolio simulation |

Six, not two hundred, because selecting the best historical curve from hundreds
is severe selection bias. See
[Deflated Sharpe Ratio](https://doi.org/10.2139/ssrn.2460551) and
[Harvey, Liu & Zhu](https://www.nber.org/papers/w20592) — significance
requirements must rise with the number of attempted specifications.

---

## 6. What every replay must measure

**Performance:** net benchmark excess return; CAGR and total return; Sharpe,
Sortino, max drawdown; profit factor and average win / average loss; MFE/MAE and
winner-capture ratio; turnover, exposure, capital utilisation; worst month and
tail loss.

**Integrity — the part that decides whether any of the above means anything:**

- point-in-time universe and adjusted prices (`lib/edges/pit-universe.ts` exists
  and fails closed; use it rather than the survivorship-biased curated list)
- signal `known_at` versus executable session
- **next-bar fills wherever closing information is required**
- spread, slippage, commissions
- delisting and corporate-action handling
- walk-forward OOS folds with purge and embargo
- **parameter perturbation instead of best-parameter selection**
- trial-family count and multiple-testing adjustment
- comparison against buy-and-hold AND against the current Kairos champion

**Portfolio value:** correlation with existing strategies; incremental benchmark
alpha; whether it improves drawdown or merely duplicates existing exposure;
whether earlier exits genuinely redeploy capital better.

---

## 7. Combination discovery

Extends the predeclared-combination design already sketched in
`features/strategy-portfolio-lab`. **Not an unconstrained optimiser.**

For strategies A and B, simulate four portfolios:

```
A alone
B alone
A + B
current champion + A + B     <- the real decision
```

The fourth is what matters. A combination that looks excellent standalone may add
nothing because it duplicates exposure the champion already has.

### Three permitted forms

1. **Parallel sleeves** — independent trading, separate risk budgets. For
   strategies differing in return, holding period or regime.
2. **Confirmation** — enter only when both agree. Reduces false positives, but
   also reduces trade count and delays entry.
3. **Regime routing** — A under a predeclared regime, B under another. Permitted
   **only** when the routing rule is frozen before replay. The app may not search
   retrospectively for the regime split that flatters the curve.

No optimised free weights initially. Equal-risk, or explicitly declared fixed
weights.

### Complementarity report

Return correlation over the full period **and specifically on losing days and
high-volatility days** — low average correlation is insufficient, because
correlations rise under stress. Plus: signal overlap and duplicate-position rate;
common-loss frequency; horizon and capital-use overlap; incremental excess
return, Sharpe and Sortino; change in max drawdown and expected shortfall; change
in payoff ratio and profit factor; turnover and cost increase; share of
combination profit from its largest few trades; regime-by-regime contribution;
and whether one strategy merely dilutes a stronger one.

### Exact attribution

With combinations capped at three strategies, every subset is at most **eight
simulations**, so marginal contribution is deterministic:

```
portfolio with strategy - portfolio without strategy = marginal contribution
```

Shapley-style attribution for return, drawdown reduction and cost is therefore
exact, not estimated. This surfaces cases such as: A produces the return while B
cuts drawdown; B looks profitable only because A frees capital; A and B are the
same exposure renamed; C helps in calm markets and causes nearly every joint tail
loss.

`lib/simulation/portfolio-simulator.ts` is the engine for these subsets.

### Hypothesis-guided proposal, not brute force

Combinations are proposed from **portfolio coverage gaps**, not from historical
return ranking: mean reversion + trend; short horizon + long horizon; equity +
defensive rotation; high-win-rate/small-win + low-win-rate/large-winner; return
sleeve + drawdown hedge; US strategy + separately governed India strategy with no
cross-currency pooling.

An acceptable proposal states an economic reason first — "RSI mean reversion
struggles in persistent declines; the 200-day trend rule avoids much of that
regime; test them regime-routed" — and freezes the pair and operator before
looking at results.

### Overfitting controls

Six strategies give 15 pairs, 20 triples and several operators; testing all and
picking the best nearly guarantees a lucky winner. See
[Harvey & Liu, *Evaluating Trading Strategies*](https://people.duke.edu/~charvey/Research/Published_Papers/P116_Evaluating_trading_strategies.pdf)
and [Bailey, Borwein & López de Prado](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2739335).

- at most **one active combination challenger per market**
- at most **three** constituents
- combination, operator and weights **declared before replay**
- **every attempted combination increments the trial-family count**
- failed combinations stay on the record
- no tuning against the sealed OOS period
- forward shadow required after replay
- new combinations proposed from coverage gaps, never from return ranking

---

## 8. Per-instrument customisation

The owner's requirement — "some strategies work for some stocks and ETFs and not
others" — is correct as intuition and is the most dangerous item here if
implemented naively. An independent test per (strategy, instrument) over ~113 US
symbols is a 20,000-arm search on per-symbol samples mostly under 40
observations.

**Required treatment:**

1. Estimate one **global** effect per strategy.
2. Estimate per-instrument deviations and **shrink toward the global estimate**
   in proportion to each instrument's sample size (James-Stein / empirical Bayes).
3. Prefer **instrument-CLASS** grouping — sector, liquidity bucket, realised-vol
   bucket, ETF vs single name — using the existing
   `lib/scoring/instrument-taxonomy.ts`. A class effect has an order of magnitude
   more data behind it.
4. Report the shrunken estimate as the headline; raw per-symbol only alongside its
   sample size and marked unstable.

---

## 8b. Per-symbol strategy SWITCHING over time — test the premise first

The owner's follow-up: *"each symbol can move around from one strategy to
another... symbols behave differently and follow a strategy certain times. Can we
monitor that and switch strategy to trade based on this?"*

### The intuition is real

A name genuinely can trend for months, then chop for months. Momentum and
mean-reversion regimes are a documented feature of equity returns, and a symbol's
character does change with its business, its volatility and its ownership.

### Why this is nonetheless the most dangerous request in this document

1. **It is the largest search space here by far.** Section 8's per-symbol slice is
   already ~20,000 arms. Adding "and it changes over time" multiplies that by the
   number of candidate switch points. Every additional degree of freedom makes a
   flattering history easier to find and a real effect harder to distinguish.
2. **Retrospective switch detection is trivially easy and almost always noise.**
   Given any price series and any two strategies, one can always find the split
   dates that make the combination look excellent. That procedure has no
   out-of-sample content.
3. **It runs into a locked project decision.** `CLAUDE.md` states: *"Push back if
   user asks for explicit 'bull/bear mode' switching. The scoring naturally
   adapts — explicit regime detection is fragile and adds moving parts,"* and
   lists "explicit market regime detection logic" under the push-back mandate.
   Per-symbol switching is that same machinery at finer granularity, so it is
   more fragile, not less.

### The premise is cheap to falsify — do that before building anything

A switcher can only work if **strategy affinity persists**. If the strategy that
suited a symbol last quarter tells you nothing about which suits it next quarter,
no switching rule can work, however well engineered.

That is directly measurable, and it costs one replay rather than a subsystem:

1. For each symbol with sufficient history, rank the six trial-family strategies
   by performance in period *t*.
2. Rank them again in period *t+1*, out of sample.
3. Compute the **rank correlation of strategy affinity between consecutive
   periods**, pooled across symbols, date-clustered.
4. Compare against a **label-permuted null** — shuffle the period-*t+1* rankings
   across symbols and re-measure. The Alpha Lab already has this placebo
   machinery (`alpha-diagnostics-counterfactual.ts`, seeded permutation with a
   `(b+1)/(m+1)` estimator).

**Decision rule, predeclared:**

- **Persistence indistinguishable from the permuted null → stop.** Do not build a
  switcher. Report the finding and close the question. This is the likely outcome
  and it is a genuinely valuable answer, because it retires a plausible idea
  cheaply.
- **Persistence materially above the null → proceed**, but only to a *static*
  per-class assignment first (section 8's shrinkage approach), and only then to a
  switcher with predeclared, economically-motivated switch triggers — realised
  volatility regime, trend/chop classification — never dates chosen by looking at
  the outcome.

### If it ever does get built

- Switch triggers frozen before replay, expressed as observable state, never as
  dates.
- A minimum dwell time per assignment, so the system cannot thrash.
- Switching counted in the trial family: *k* strategies × *r* regimes is *k×r*
  arms, not *k*.
- Compared against the honest baselines — best single static strategy for that
  symbol, and the champion — not against the worst constituent.
- Transaction costs of switching charged in full; a switcher that changes stance
  often can lose to a static rule purely on turnover.

**Recommendation: run the persistence test in stage 3, decide from its result,
and build nothing before it reports.**

---

## 9. Promotion policy

A candidate advances only when **all** hold:

1. survives frozen historical replay after realistic costs
2. persists across periods and reasonable parameter perturbations
3. adds portfolio-level value rather than duplicating the champion
4. passes the multiple-testing-adjusted gate at the **full** trial count
5. forward-shadow fills match modelled execution
6. produces enough independent forward observations
7. **owner explicitly approves paper activation**
8. a later, separately approved live trial starts under a small risk cap

A strategy designated as a **hedge** may carry modest or negative standalone
return, but must reduce downside enough to justify its carrying cost. It may not
be quietly graded against easier return-strategy criteria.

---

## 10. Sequencing

**Stage 0 — prove the existing pipeline first.** Land the two untracked feature
drafts, apply and verify `strategy_template_shadow_configs`, and get
`strategy_evaluations` to produce its first non-zero row. Discovery built on an
unproven pipeline means debugging two new things at once.

**Stage 1 — metadata-only catalogue.** `external_strategy_catalog`: title, URL,
category, dates, `applies_to`, `eligible`, `exclusion_reason`, `predeclared_at`.
Hand-reviewed; no article content stored.

**Stage 2 — frozen rule specs** for the six-strategy family, written
independently, with attribution.

**Stage 3 — point-in-time replay** through the existing simulator, with the full
integrity checklist.

**Stage 4 — combination discovery**, one challenger per market.

**Stage 5 — forward shadow.** Default verdict `insufficient_evidence`.

**Stage 6 — owner-approved paper sleeve.** Separate decision.

**Stage 7 — capped live trial.** Separate decision, existing risk and broker gates.

Stages 0-2 are what this document asks approval for. Nothing beyond stage 2
should be built until stage 0 has produced evidence the pipeline works.

---

## 11. Honest assessment

**Recommendation: go, starting at stage 0.**

The reshaping from "test 200 strategies" to "run a controlled funnel that asks a
portfolio question" is the right correction, and the combination design is the
part most likely to produce something genuinely useful — because *does this add
to what we already hold* is a question the current system cannot answer at all.

Three cautions, stated plainly:

- **The foundation is thinner than it looks.** `strategy_evaluations` has never
  produced a row. That is stage 0's entire justification.
- **Timelines are long.** The book currently has 26 independent h10 dates
  against a floor of 12 effective observations; one predeclared hypothesis needs
  roughly 120 dates. Historical replay is not subject to that limit, but the
  forward-shadow confirmation in stage 5 is.
- **The risk is not a bad strategy; it is a good-looking one.** Four claims from
  this book were retracted in the past week, each from reading a number drawn
  from the wrong population or an unrun code path. A funnel whose default answer
  is "not yet" is the point, not a limitation of it.
