# Public strategy library — shadow harness

> Status: **DRAFT — scope and brief. No code written. Not approved.**
> Date: 2026-09-01. Influence if approved: **none while shadow.** Any promotion to
> live is a separate money-path approval.
>
> Written to be actionable by Codex or any other agent without this conversation.

## What the owner asked for

1. Parse the strategies at <https://www.quantifiedstrategies.com/trading-strategies-free/>
2. Run them as shadows.
3. When they qualify, start using them.
4. Test whether **combinations** work better or worse.
5. Determine **which strategies suit which stocks/ETFs** — explicitly: "some
   strategies work for some stocks, ETFs and not others, so the app and you
   should be able to customize."
6. Survey other reputable suites / GitHub projects and test any not used before.

All six are buildable. Point 3 and point 5 are where this either becomes a real
instrument or a noise generator, and the difference is entirely statistical
discipline, not engineering.

## What is actually on the page (fetched 2026-09-01)

- **~200 strategies**, rules given in plain English, often with Pine Script or
  Python. Reported performance statistics are **frequently withheld or
  paywalled** — so the rules are usable, the claimed edges are not verifiable
  from the page.
- Categories, with examples:
  - **Mean reversion**: RSI(2) on SPY, 5-day low, NR7
  - **Trend**: 200-day MA, Golden Cross
  - **Seasonal/calendar**: Turnaround Tuesday, Turn of the Month, Santa Claus Rally
  - **Volatility**: Bollinger squeeze
  - **Overnight**: close-to-open
  - **Indicator**: MACD histogram, Stochastic
  - **Day trading**: outside day, intraday breaks
  - **Bonds**: TLT trend following

### Three filters that remove most of them before any statistics

1. **Intraday and overnight strategies are out by construction.** This system is
   EOD-only with a 2-20 market-day swing mandate. Close-to-open, outside day and
   every day-trading rule cannot be evaluated on the data we persist, and
   pretending otherwise would produce a number with no path to execution.
2. **Index-level calendar rules are market-wide, not cross-sectional.**
   Turnaround Tuesday, Turn of the Month and Santa Claus Rally produce the SAME
   signal for every symbol on a date. That is exactly the defect found in
   `macro_score` on 2026-09-01: a constant within a date contributes nothing to a
   cross-sectional ranking, and can only act as a timing/exposure overlay. They
   belong in a separate exposure track, never in the selection composite.
3. **Rules whose published edge is paywalled cannot be replicated, only
   re-derived.** That is fine, but it means we are testing OUR implementation of a
   described rule, not validating their result. Any write-up must say so.

Realistic survivors: **roughly 20-40** rules that are EOD, cross-sectional or
per-symbol, and fully specified.

## THE BINDING CONSTRAINT — read this before designing anything

This is not an engineering problem. The system currently cannot evaluate **one**
hypothesis, let alone hundreds.

Measured on this book, 2026-09-01:

| quantity | value |
|---|---|
| independent decision dates, h10 | **26** (US), 26 (India) |
| effective observations at h10 (`nDates / horizonDays`) | **2.6** |
| floor required for a verdict (`MIN_EFFECTIVE_OBSERVATIONS`) | **12** |
| dates needed for ONE h10 hypothesis | ~120 |
| US eligible-long h10 rank IC | **-0.0768** |
| India eligible-long h10 rank IC | **-0.0083** |

Now apply multiplicity. Šidák-adjusted `alpha = 1 - (1 - 0.05)^(1/m)`:

| what is searched | trials `m` | adjusted alpha | critical two-sided \|t\| |
|---|---:|---:|---:|
| 1 predeclared hypothesis | 1 | 0.05 | 1.96 |
| the ATR exit arm (already shipped) | 14 | 0.00366 | 2.91 |
| ~200 strategies | 200 | 2.6e-4 | 3.66 |
| 200 strategies x ~100 instruments | 20,000 | 2.6e-6 | **4.71** |
| all PAIRS of 200, per instrument | ~2.0e6 | 2.6e-8 | **5.57** |

**With 26 independent dates, power against a \|t\| threshold of 4.7 is
approximately zero.** Every "winner" that emerges from a 20,000-arm search on
this much data is overwhelmingly likely to be noise, and the search itself
guarantees some arm will look excellent.

This is not an argument against building the harness. It is an argument that
**the harness must accrue evidence for months before it is read**, and that its
default verdict must be `insufficient_evidence` — the same posture as
`features/atr-exit-stop`, which is expected to say exactly that until ~2027-Q1.

## Per-instrument customization — the owner's point 5, done honestly

The intuition is correct: mean reversion genuinely behaves differently on a
low-beta utility than on a leveraged semiconductor ETF. The naive implementation
is also the single most dangerous thing in this brief.

**Do NOT run an independent test per (strategy, instrument).** With ~113 US
symbols that is a 20,000-arm search, and per-symbol samples are tiny — most
symbols have well under 40 observations.

**Do this instead — hierarchical estimation with shrinkage:**

1. Estimate one **global** effect per strategy across the whole universe.
2. Estimate per-instrument deviations, then **shrink them toward the global
   estimate** in proportion to how little data each instrument has. A symbol with
   12 observations should barely move off the global mean; one with 300 can move
   further. (James-Stein / empirical-Bayes shrinkage; `pymc` or a closed-form
   normal-normal estimator both work.)
3. Prefer **instrument-CLASS** grouping over per-symbol wherever possible —
   sector, liquidity bucket, realised-volatility bucket, ETF vs single name.
   `lib/scoring/instrument-taxonomy.ts` already classifies instruments and is the
   natural grouping key. A per-class effect has an order of magnitude more data
   behind it than a per-symbol one and is far less likely to be noise.
4. Report the **shrunken** estimate as the headline. Report the raw per-symbol
   estimate only alongside its sample size, clearly marked as unstable.

The honest version of "customize per stock" is: *learn a strategy-by-class
effect, and let per-symbol deviate only where the data earns it.*

## Combinations — the owner's point 4

Test combinations **only** as a predeclared, small, theory-motivated set. Not the
full pairwise grid.

Reasonable: one trend rule + one mean-reversion rule (they are known to be
negatively correlated, so the combination has a prior); a regime filter (200-day
MA) applied to a mean-reversion entry. That is a handful of arms with a stated
reason, not 19,900 arms.

Record the combination arms in the registry BEFORE running, and count them in the
trial total. A combination discovered by scanning the grid must be labelled as
such and carries the grid's multiplicity, not a single test's.

## Proposed build — three stages, only stage 1 is proposed now

### Stage 1 — registry + parser (buildable now)

- `strategy_library` table: `id`, `source_url`, `name`, `category`,
  `rule_spec` (jsonb), `horizon_days`, `applies_to` (`cross_sectional` |
  `per_symbol` | `market_timing`), `eligible` (bool), `exclusion_reason`,
  `added_at`, `predeclared_at`.
- A parser producing `rule_spec` from the page. **Firecrawl is configured but
  failed to connect in this session (`CONNECT_TIMEOUT`); use WebFetch or a plain
  HTTP fetch.** The page is static HTML; JS rendering is not required.
- **Every rule is entered by hand-review before it becomes `eligible`.** An
  LLM-parsed rule that nobody read is a rule nobody understands, and this system
  has already been burned by acting on plausible-looking specifications that were
  never executed (`buildStockPrompt`, deleted 2026-09-01).
- Freeze `predeclared_at` per strategy. Anything added after the evaluation window
  opens is a new trial, not a free one.

### Stage 2 — shadow evaluation harness (after stage 1 review)

- Reuse the existing evidence contract rather than inventing a second one:
  `lib/learning/entry-cohort.ts` (eligible-long only),
  `effectiveObservations`, `MIN_EFFECTIVE_OBSERVATIONS = 12`,
  `MIN_REVIEW_DATES = 60`, and the Šidák helper now in
  `lib/trading/exit-stop-shadow.ts`.
- Date-clustered, paired against the live champion on the SAME observations —
  the pattern `archetype-ic` already uses.
- Write to `strategy_shadow_runs`, storing `trials_considered` and `sidak_alpha`
  on every row, as `exit_stop_shadow_runs` does.
- Default verdict `insufficient_evidence`. Expected to stay there for months.

### Stage 3 — promotion (NOT proposed; requires separate approval)

Gates, all of which must hold, per market:

1. `nEffective >= 12` and `nDates >= 60`.
2. Šidák-adjusted significance at the **full** trial count, including every arm
   ever run, not just the survivors.
3. Positive out-of-sample on a forward window declared before it was seen.
4. Holds at more than one horizon, or the divergence is explained.
5. Mechanism confirmed — the strategy's stated reason for working is visible in
   the data, not just the return.

Failing any gate leaves the arm in shadow. There is no partial promotion.

## Existing suites worth adopting (survey, 2026-09-01)

We should not write a backtester. Several mature ones exist.

| project | what it is | fit here |
|---|---|---|
| [VectorBT](https://github.com/polakowo/vectorbt) | NumPy/Numba vectorised; built for thousands of parameter combinations | **Best fit for the sweep.** Fast enough that the compute cost of 20k arms is trivial — which is precisely why the discipline above matters more than the speed |
| [Backtesting.py](https://github.com/kernc/backtesting.py) | lightweight, mature, intuitive | Good for single-strategy verification and sanity checks |
| [Zipline-Reloaded](https://github.com/stefan-jansen/zipline-reloaded) | Quantopian descendant, pipeline API | Strong for **factor/cross-sectional** work, which is our actual shape; steep learning curve |
| [Backtrader](https://github.com/mementum/backtrader) | event-driven, huge community | Mature but the upstream is quiet; a fork is more active |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Rust-native, production event-driven engine | Overkill for EOD swing shadows |
| [pandas-ta](https://github.com/twopirllc/pandas-ta) | 130+ indicators, 60+ candlestick patterns | **Adopt.** Removes the need to hand-implement RSI/MACD/Bollinger and the bugs that come with it |
| [awesome-systematic-trading](https://github.com/paperswithbacktest/awesome-systematic-trading) | curated index of libraries and papers | Use as the source for stage-1 backlog beyond this one site |
| [awesome-quant](https://github.com/wilsonfreitas/awesome-quant) | broader curated list | Same |

**Recommended: `pandas-ta` for indicators + `VectorBT` for the sweep**, both
offline and measure-only. Neither touches the live path. A Python worker already
exists in this repo (`scripts/python/`).

**Caution worth stating:** VectorBT makes it effortless to run a million
backtests. The binding constraint is statistical, not computational, and a tool
that removes the compute cost removes the only friction that was accidentally
protecting us.

## Honest assessment

**Build stage 1.** A registry of predeclared, hand-reviewed rules with frozen
timestamps is useful regardless of what the evaluation later says, and the data
accrues whether or not anyone is watching.

**Do not expect a usable answer this year.** At the current rate (~26 h10 dates
per seven weeks) a single-hypothesis verdict arrives around 2027-Q1. A
200-strategy search needs materially more than that, and a per-symbol search of
that size may never be answerable on one book's traffic — which is the real
argument for class-level grouping over per-symbol.

**The biggest risk is not a bad strategy. It is a good-looking one.** This book
has produced four retracted claims in the past week, every one from reading a
number that came from the wrong population or an unrun code path. A 200-arm
search on 26 dates will manufacture beautiful numbers. The harness's job is to
refuse them.
