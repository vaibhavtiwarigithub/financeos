# External strategy discovery

> Status: **REVISION 2 — DRAFT, not implementation-ready. No code written.**
> Date: 2026-09-01. Influence if approved: **none.** Every stage is measure-only;
> paper activation and live activation are separate, later owner decisions.
>
> Independent review ruled **(c): a corrected Stage 0**, and found several claims
> in revision 1 wrong. All corrections below were verified against the code and
> production before being accepted. Review brief:
> `docs/audits/2026-09-01-external-strategy-discovery-codex-brief.md`.
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
| `lib/simulation/portfolio-simulator.ts` | **exists, but produces NO NAV path** | returns `endingCash`, `positions`, `fills`, `rejections`, `realizedPnl` only (`:59`). Sharpe, Sortino, drawdown, benchmark alpha and stress-day correlation all require a separate deterministic marking layer |
| `lib/validation/` (8 modules) | **real, but answers a different question** | validates alternative SCORING WEIGHTS against decision observations; it cannot evaluate an SPY moving average, RSI(2), NR7 or a rotation rule |
| `strategy_templates` / `strategy_sleeves` | real | 7 rows each |
| `backtest_experiments` | **real and exercised** | 18 rows: 13 alpha diagnostic, 3 OOS IC, 2 historical replay. The immutable experiment ledger works |
| `strategy_evaluations` | 0 rows — **but this is NOT the relevant gap** | written by `lib/evaluation/run-evaluation.ts:121`; it is the mandate-level whole-book Performance Truth ledger |
| **`validation_experiments`** | **0 rows — THIS is the proof gap** | written by `lib/validation/engine.ts:140`, the actual validation-engine output |
| `strategy_template_shadow_configs` | **not deployed** | `to_regclass` NULL; migration untracked |
| `features/strategy-portfolio-lab`, `features/portfolio-simulation` | untracked drafts | not in git |

**CORRECTION accepted.** Revision 1 claimed the empty `strategy_evaluations`
proved the validation pipeline had never run. Wrong — that table belongs to a
different subsystem. Producing a row in it would not prove external-strategy
validation. The relevant empty ledger is `validation_experiments`.

**Also corrected:** revision 1 cited the portfolio simulator as able to produce
the promised metrics. It cannot. Alpha Lab A6 gets its NAV path from its own
`runPortfolioCalendar` in `lib/analytics/alpha-diagnostics-portfolio.ts`, not
from the simulator. Any replay needs that marking layer built explicitly.

**Consequence for sequencing.** The problem is not merely that the pipeline is
unproven — it is that the cited components **answer different questions and are
not connected into an external-strategy evaluation path**. The validation engine
grades scoring weights, not price rules. The simulator produces fills, not a NAV
path. Neither gap is closed by "exercising" them.

Still: do not build a second backtester. Build the **missing seam** — a rule
compiler, a deterministic NAV/benchmark marker, and a sealed result written to
the experiment ledger that already works.

**The shadow migration must NOT be applied unchanged.** Its fingerprint covers
only market, kind and template IDs, omitting operator, weights, rule version and
trial family, so two different combinations can collide or be silently
rewritten. It also has no immutable-config trigger and no append-only lifecycle
ledger.

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

## 5. First trial family — ROLE SLOTS FIRST, names after a data audit

**CORRECTED.** Revision 1 named six strategies. Review found the family poorly
balanced: roughly **five of six are index / exposure / rotation rules**, with
only NR7 potentially supplying instrument selection. It also barely touches the
known "win big, lose small" exit gap — the one place this book has measured
evidence of a problem (73.7% of exits are the clock; `partial_target` returns a
mean +20.20% on 5 lots).

**Freeze ROLE SLOTS before naming anything:**

| slot | count | purpose |
|---|---:|---|
| entry rule | 2 | instrument selection |
| exit / holding rule | 2 | winner capture, loss limitation |
| exposure overlay | 1 | market timing, evaluated separately from selection |
| defensive allocator | 1 | drawdown reduction |

Names are chosen **after** the data audit below, not before.

### Data sufficiency must be proven first

Review measured the cached history: SPY / QQQ / IWM / GLD hold only ~280
sessions, so after a 200-day warm-up **SPY MA yields roughly 80 decision
sessions**. TLT and IEF hold ~35 sessions — unusable.

A replay that silently runs on 35 sessions produces a number, and that number is
worthless. **Stage: acquire and seal sufficient licensed OHLCV and
corporate-action history before any strategy is named.**

Six, not two hundred, remains right: selecting the best historical curve from
hundreds is severe selection bias. See
[Deflated Sharpe Ratio](https://doi.org/10.2139/ssrn.2460551) and
[Harvey, Liu & Zhu](https://www.nber.org/papers/w20592).

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

**CORRECTED.** Revision 1 proposed `A`, `B`, `A+B`, `champion+A+B` and omitted
the two most important marginal comparisons. The required set is:

```
champion                     <- baseline
champion + A                 <- marginal value of A
champion + B                 <- marginal value of B
champion + A + B             <- the joint decision
```

Standalone `A`, `B` and `A+B` remain useful diagnostics but cannot answer
"does adding this help the book we already hold".

**Shapley caveat.** Exact attribution requires resimulating every necessary
subset. Path dependence does not invalidate Shapley, but capital reuse and fill
ordering make the characteristic function path-dependent, so **event ordering and
simultaneous-entry allocation must be frozen** before any subset is run.

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

- at most **one active FORWARD-SHADOW combination per market** — this must not
  prevent multiple immutable OFFLINE experiments, which are cheap and sealed
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

**CORRECTED — revision 1 was wrong as an implementation proposal.** Hierarchical
partial pooling is directionally right *eventually*, but it cannot be built on
the taxonomy as it stands. Start with **predeclared class-level estimates**; add
empirical-Bayes per-symbol deviations only after the classes and sample floors
exist.

**Required treatment:**

1. Estimate one **global** effect per strategy.
2. Estimate per-instrument deviations and **shrink toward the global estimate**
   in proportion to each instrument's sample size (James-Stein / empirical Bayes).
3. Prefer **instrument-CLASS** grouping — but **the existing taxonomy is not
   adequate for this**. `lib/scoring/instrument-taxonomy.ts:36` identifies ETFs,
   metals, banks, REITs and broad operating companies; it has **no liquidity
   bucket, no realised-volatility bucket, and no meaningful sector for most
   operating companies**. Those buckets must be built and predeclared first.
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
3. **It brushes a locked project decision.** `CLAUDE.md` pushes back on explicit
   "bull/bear mode" switching as "fragile and adds moving parts". Review's
   refinement, accepted: that prohibition is **relevant but not dispositive** —
   per-symbol state adaptation is materially different from one global market
   regime switch. It earns a measure-only premise test; it does not earn a
   switcher now.

### The premise test — CORRECTED

Revision 1 proposed a rank correlation of strategy affinity between adjacent
periods. Review found that **wrong as a primary test and currently
unanswerable**, and the author agrees on both counts:

- Rank persistence is at best a *diagnostic*. It does not test whether switching
  **makes money after costs**, which is the only question that matters.
- The data cannot support it. 26 distinct eligible-long h10 dates per market is
  ~**2.6 effective observations** under the system's own overlap heuristic.

**Primary test instead — nested walk-forward policy:**

1. In a training window, estimate the preferred strategy per symbol.
2. **Freeze the assignment.**
3. Trade it in the next window, out of sample.
4. Compare net-of-cost results against three honest baselines: the **champion**,
   the **best static strategy** for that symbol, and an **equal-weight ensemble**.

Transition persistence and top-two retention become secondary diagnostics, not
the verdict.

**Purge and embargo, specified:** purge every observation whose realized outcome
interval crosses the train/test boundary; embargo by the longest permitted
holding/outcome horizon — currently **20 market sessions**.

> **Do NOT reuse `walkForwardFolds`.** `lib/learning/dataset.ts:107` documents
> itself as market-horizon purged but computes `purgeCutoffMs = testStart -
> horizonDays * DAY` with `DAY = 86400_000` (`:120`) — **calendar milliseconds**.
> A nominal "10-day" purge is therefore about 6-7 trading sessions, so labels
> leak across the boundary. This is a live defect in existing learning code, not
> just a constraint on this feature, and is flagged separately for repair.

**Timing:** this test is **not answerable today**. It needs its own accrual
period. Proposing a test that cannot report is its own failure mode, so it is
scheduled last and gated on independent history existing.

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

## 10. Blocking gaps found by review (C7)

Each must be closed or explicitly accepted before the stage that depends on it:

- **PIT universe excludes ETFs and refuses India.** `lib/edges/pit-universe.ts:259`.
  Every fixed-ETF strategy therefore needs a **separate point-in-time
  instrument/data contract**.
- **`price_cache` has no immutable provider/basis/version provenance**, so
  adjusted history can be restated after splits or dividends and a "sealed"
  replay silently changes. Sealed replay needs versioned price provenance.
- **No NAV path** from the simulator (section 2). Sharpe, Sortino, drawdown,
  benchmark alpha and stress-day correlation need a deterministic marking layer.
- **Same-session fill ordering is lexical**, which privileges one strategy when
  capital is scarce. Parallel sleeves need **reserved budgets or pro-rata
  arbitration**, frozen before any subset runs.
- **Trial-family counting can reset.** Verified in production:
  `trial_family_id = 'local-nse-technical-v1'` has 2 experiments each recording
  `trials_considered = 1`, and **13 of 18 rows carry no `trial_family_id` at
  all**. An immutable, atomically-incremented trial ledger is required before any
  multiple-testing claim means anything.
- **Retirement is mutable state** in the proposed shadow table. It needs an
  **append-only event history** with reason, evidence snapshot and actor.
- **Source adaptations are new specifications.** "Turnaround Tuesday, adapted to
  next-open" is a tested variant and **must increment the trial count**.
- **India stays blocked** until its PIT membership, corporate-action and
  benchmark contracts are independently complete.
- **The first family must test exits**, not only entries and exposure.

## 11. Sequencing — Stage 0R (review ruling: option (c))

1. **Stage 0R — reconcile the foundation.** Track the approved documents, map each
   ledger to its real purpose, and **revise, not deploy**, the shadow migration.
2. **Immutable trial-family ledger.** Atomically count every rule, parameter
   variant, adaptation, combination and rerun, across sessions.
3. **Prove the orchestration seam.** Compile ONE frozen rule into events, run the
   existing simulator plus a new deterministic NAV/benchmark marker, and persist
   a sealed result in `backtest_experiments`. **Include a negative-control
   strategy** — if a deliberately worthless rule scores well, the seam is wrong.
4. **Prove data sufficiency.** Acquire and seal enough licensed OHLCV and
   corporate-action history **before** naming candidates.
5. **Metadata-only catalogue**, preferably after written crawling permission.
6. **Freeze the role-balanced family**, including exit/holding strategies.
7. **Historical replay + the full champion-relative combination matrix.**
8. **One forward-shadow combination per market.**
9. **Revisit switching** only after enough independent history exists.

**Explicitly NOT to be built yet:** the per-symbol switcher, the per-symbol
empirical-Bayes model, any arbitrary combination optimiser, a production crawler,
or the current shadow migration.

Approval sought for **steps 1-3 only.**

## 11b. Stage 0R steps 1-3: what shipped, and what the seam found

Completed 2026-09-01. Every defect below was invisible to unit tests and was
found only by running on 1,280 real VOO bars — which is the entire argument for
step 3 existing before any strategy is judged.

| # | defect | fix |
|---|---|---|
| 1 | exits carried no `quantity`; `portfolio-simulator.ts:136` rejects those as `invalid_exit`. **1 fill, 96 rejections** | compiler tracks entry quantity and carries it |
| 2 | `seamVerdict` returned `pass: true` on that run — it inspected only the controls, never the rejection rate | fails above a 10% rejection rate |
| 3 | `cashAllocation` pinned to INITIAL cash while real cash drifted; at 100% allocation one losing round trip made every later entry unaffordable. **93 of 97 rejected** | compiler tracks its own cash as the simulator does |
| 4 | `alwaysInControl` used `positionSizePct: 0.1` regardless of universe size, so on one symbol it ran at **8.7% utilisation** and showed -81.58pp against the benchmark it exists to track | sized `1 / universe.length` |

Defect 4 was surfaced by the gate added for defect 2 — the tightened verdict
immediately failed a run the lenient one had passed.

Final verified run: `pass: true`, **zero rejections** across all three specs
(97/97 and 233/233 fills). Controls behave: never-trades returns exactly 0.00%
with 0.00% drawdown; always-in reaches 91% utilisation and lands -18.39pp against
the index it holds, which is the drag of exiting every 10 sessions and re-entering
next open.

The rule itself: 200-session VOO trend returns **+46.73% against buy-and-hold's
+87.26%** over ~5 years — it underperforms by 40pp while cutting drawdown from
25.50% to 13.27%. Believable for a trend filter in a rising market. It is a
full-sample replay with no costs, no walk-forward and no multiple-testing
adjustment, so under the promotion policy it cannot advance past `replay only`.

### Sealing is REFUSED, and that is the schema working

`backtest_experiments` already enforces a full manifest for `historical_replay`
(`backtest_experiments_historical_replay_manifest_required`), including
**`validation_mode = 'purged_temporal_oos'`**. This seam runs a full-sample
replay with no OOS split, so writing that value would misstate how the number
was produced. `POST` therefore returns `409 sealing_requires_purged_oos` rather
than forcing a full-sample result into a slot reserved for purged ones.

Two things this exposed for later:

- The contract also requires `edge_id`, `formula_version`,
  `universe_policy_version`, and a `validation_spec` at schemaVersion
  `kairos.historical-replay.v1`. Sealing is a real piece of work, not a field map.
- `backtest_experiments.trials_considered` means *variants in this experiment*
  and is capped at `variant_budget` (max 20). That is **not** the same quantity as
  the trial family's running total in `trial_family_ledger`, which is the
  multiple-testing denominator and grows without bound. The two must not be
  conflated when sealing is implemented.

### The trial ledger earned its place immediately

Changing `alwaysInControl` from `positionSizePct 0.1` to `1 / universe.length`
produced a NEW fingerprint and registered as **trial 4**, alongside the original
at trial 3. A fix to a control is itself a new specification. Without the ledger
that change would have been invisible and the denominator would have stayed at 3.

---

## 12. Honest assessment

**Recommendation: go, at Stage 0R.** The concept is worth pursuing; the
architecture was not implementation-ready, and revision 1 got four things wrong
that mattered:

1. Pointed Stage 0 at `strategy_evaluations`, which belongs to a different
   subsystem — the real gap is `validation_experiments`.
2. Treated the portfolio simulator as able to produce Sharpe/drawdown/alpha. It
   returns fills and realized P&L; there is no NAV path.
3. Proposed four combination portfolios that omitted `champion+A` and
   `champion+B`, the two most informative marginals.
4. Proposed a per-symbol shrinkage model on a taxonomy that has no liquidity,
   volatility or sector buckets to shrink toward.

A fifth correction is a live defect in existing code, not this feature:
`walkForwardFolds` purges in calendar milliseconds while documenting itself as
market-horizon purged, so a "10-day" purge is 6-7 sessions and labels leak.

Three cautions stand:

- **The foundation is not just unproven, it is unconnected.** The validation
  engine grades scoring weights; nothing in the repo can currently replay a price
  rule end to end.
- **Data may be the binding constraint before statistics are.** ~80 usable SPY
  decision sessions after warm-up, ~35 for TLT/IEF.
- **The risk is a good-looking result, not a bad strategy.** Five claims from this
  book were retracted in the past week, every one from reading a number drawn
  from the wrong population or an unrun path. A negative control in step 3 is
  cheap insurance against the seam itself being wrong.

## 13. Follow-up: Strategy Evidence Scorecard (separate architecture)

Review also proposed a **Strategy Evidence Scorecard** — a third tab on the
Strategies page (`Fit Scores · Algo Library · Live Evidence`) showing, per
strategy and per combination: benchmark-relative alpha, **payoff ratio**, profit
factor, winning weeks (not streaks), evidence count and stage (replay / shadow /
paper / live), and a governed status from
`insufficient_evidence | collecting | promising | working | degrading | failed | retired`.

Deliberately **not** a win-rate leaderboard, which would reward exactly the
pathology this book already shows: many small wins and one large loss.

`StrategyGovernancePanel.tsx:33` already surfaces signal count, win rate, average
return, Sharpe, drawdown and alpha, and `lib/analytics/performance-metrics.ts:105`
already computes expectancy and profit factor. Missing: strategy-level weekly
return history, payoff ratio per run, benchmark-relative weekly consistency,
evidence-stage separation, governed status, and combination rows.

Status thresholds are financially load-bearing and **must be frozen in
architecture before any strategy is graded against them**. This needs its own
approved document; it is not covered by this one.
