# Score Formula Mining and Forward Generalization

**Status: IMPLEMENTED, deployed, and collecting prospective labels (2026-10-15).**
This supplements `features/score-variants-forward-shadow/FEATURE_ARCHITECTURE.md`;
it does not replace the incumbent scorer or promote a candidate.

**Production state:** the owner-only one-time fit froze immutable set
`formula_mined_v1_aab358160c2e3787` (nine declarations). Complete-case candidates
exist for India h2/h5/h10; no US candidate was fitted because no US slice met the
complete-case entry-long requirement. The Learning page reports this as an empty
slice under a globally frozen search and disables repeat mining. Nightly
evaluation writes forward/hindsight rows, but the latest inspected forward
cohort still has zero qualifying post-declaration sessions. All candidate
verdicts therefore remain insufficient; no weight changes or trading consumers
are enabled.

## Decision and objective

Kairos may intentionally search historical observations for formulas that fit
the past unusually well. Such formulas are useful as **overfit candidates**: they
make it possible to see which dimensions/factors appear to explain the historical
sample and whether their apparent skill survives data not used to choose them.
An in-sample fit is never called predictive evidence. The product question is
whether a frozen candidate generalizes prospectively and improves a realistic
portfolio comparison, not whether an optimizer can find a high historical IC.

## Current data boundary (verified production read, 2026-10-15)

`decision_observations` starts 2026-07-06 US and 2026-07-07 India, with 88
distinct observation dates per market through 2026-10-15. Matured benchmark-neutral
labels then covered:

| Market | Horizon | Label sessions | Approx. independent windows |
|---|---:|---:|---:|
| US | 5 | 80 | 16.0 |
| India | 5 | 73 | 14.6 |
| US | 10 | 74 | 7.4 |
| India | 10 | 68 | 6.8 |
| US | 20 | 62 | 3.1 |
| India | 20 | 52 | 2.6 |

These are short, overlapping observations from one recent regime, not a decades-
long training history. Historical intake has India OHLCV/corporate-action data
from 2020 and SEC statement facts from 2024Q1–2026Q1, but no promotion-grade
point-in-time US security master/ticker mapping, delisted-name universe, or
complete historical app dimension snapshots. It cannot reconstruct the full
current five-dimension scorer back to 2010. The application’s actual dimension
score ledger is the usable source for the composite experiment; it begins in
July, not June. The UI must state this and must not label reconstructed price-only
signals as historical fundamental/sentiment scores.

## Experimental lanes

1. **Historical mining (deliberately contaminated for selection):** the first
   implementation searches a bounded 0.1-step simplex of nonnegative dimension
   weights independently per market and horizon, maximizing mean session-level
   Spearman rank IC. It fits only the shared complete-case, eligible-long
   `entry_candidate` cohort (never held-position re-scores); all candidates use
   the same date×symbol rows. It records the full-sample winner and the best
   formula omitting each available dimension. These figures and t-statistics are
   explicitly `in_sample_overfit`, never evidence. This is one frozen search;
   it cannot be rerun after inspecting forward results.
2. **Nested chronological diagnostic:** not implemented in this first pass.
   Add only after there is enough within-history depth to reserve truly later
   folds, with candidate generation/pruning confined to training folds. Purge
   any label whose outcome interval overlaps a validation boundary, in **market
   sessions**, not calendar-day arithmetic. Even then, these remain historical
   diagnostics because the process can be iterated after inspection.
3. **Prospective forward shadow:** freeze a mined formula, exact weights,
   availability policy, training cutoff, data/code fingerprints, candidate family,
   and declaration timestamp before counting any later observation. Compare it
   with the incumbent and fixed variants on identical date×symbol rows, per
   market and horizon. No earlier observation can become forward merely because
   a new formula was fitted later.
4. **Pruning experiments:** the initial immutable ablations are best fits with
   one available dimension constrained to zero. Each market, horizon, full-grid
   trial, and ablation is recorded. They are selected in-sample and therefore
   overfit too. Future pruning versions must be fitted only inside training folds
   or against a newly declared forward sample; never repeatedly re-fit against
   the same inspected shadow period.

## Conditional formula hierarchy (future gated research, not in this build)

The scoring process is plausibly conditional, but do not respond by fitting an
independent formula for every regime × sector × company. That creates a model
zoo and each small bucket will look convincing by chance. The long-run target is
partial pooling, with complexity increasing only as independent evidence grows:

1. **Market-local base:** one simple formula per market/horizon as the stable
   anchor (the present miner is an exploratory candidate generator, not a live
   base change).
2. **Sector deviations:** estimate small sector-specific adjustments that are
   shrunk toward the market base. Use the existing point-in-time sector mapping;
   merge sparse sectors rather than inventing an estimate. Promote only when
   each sector has enough distinct entry sessions, independent horizon windows,
   and later forward coverage.
3. **Regime interactions:** predeclare a small set of observable, as-of features
   (for example breadth, realized volatility, trend, and valid market-local
   macro state). Prefer smooth/shrunk interactions or a mixture of experts over
   brittle hard switches. Regime detection itself must be trained/frozen without
   outcomes from the scored period; include a neutral/uncertain state.
4. **Industry and company:** industry groups can be tested after sector pooling
   if point-in-time classification and sample floors support them. Do not fit
   free-standing weights for individual companies from this thin app history.
   Company-specific business quality belongs in company-level fundamentals;
   stock-specific prediction adjustments need their own mechanism and far more
   independent histories across regimes.

Macro's constant value cannot rank names on a date, but it can condition a
time-series or sector model. Those are different questions and need separate
outcomes (cross-sectional rank IC vs. portfolio/time-series return). The current
ledger does not provide enough dimensional history to switch formulas by regime
or industry now. The app's recent record is not decades of economic cycles.

## Input and formula contract

- Candidate inputs are only dimension scores already stored in
  `decision_observations` with a true availability-mask entry. Neutral defaults
  do not become evidence. The miner uses the shared eligible-long entry
  predicate (including direction and decision intent) and complete-case
  intersection across dimensions available for the market/horizon; all
  candidates share those rows and the live-composite baseline is paired.
- Macro is excluded from cross-sectional rank formulas because it is market-wide
  on a date and cannot rank names. It may be studied separately as a market
  exposure/timing overlay, not silently folded into selection weights.
- Start with composite dimension weights only. This is **not** a claim that
  underlying technical or fundamental sub-indicator formulas have been fitted;
  their historical as-of inputs are not fully present in the score ledger.
- Candidate formulas remain deterministic and bounded. No LLM-generated formula
  executes. No unconstrained search over arbitrary code/expressions.

## Evaluation and reporting

Report, per market and horizon:

- exact formula and inputs, data cutoffs, missingness/coverage, sample and
  independent-window counts, trial-family count and fingerprints;
- in-sample fit (explicitly `overfit / descriptive`) and forward shadow as
  separate rows/sections; chronological validation is not yet available;
- paired rank IC and uncertainty, top/bottom bucket excess and spread;
- where a realistic replay contract is available, net benchmark-relative
  portfolio return, drawdown, turnover, costs, cash and fill/capacity effects.

For the pre-existing fixed-weight shadow, distinguish its population from the
miner: `variant_set_v1` is an all-scored association diagnostic and includes
daily re-scores of existing holdings, so it is not evidence about new-entry
selection. The mined formulas use the declared entry-candidate-long cohort.
Both use the same rows for candidate and baseline within a cell. Session-level
t-statistics use Bartlett-kernel Newey–West standard errors (lag bounded by
`horizon - 1`) because forward labels overlap. The candidate-minus-baseline
top-minus-bottom spread is also computed as a per-session paired delta and
persisted with its HAC t-stat; the migration is additive and historical rows
remain NULL. `sessions / horizon` is shown only as a rough non-overlap count,
not a measured effective sample size. The score-variant screen never emits an
adoption verdict. A forward score association, even with a large t-stat, is not
a paired portfolio return result.

Rank IC measures association among the tested research cohort; it does not prove
the constrained portfolio earns alpha. Formula-level promotion remains blocked
until prospective results pass predeclared evidence and multiplicity controls,
are stable across independent periods/markets where the feature is available,
and a paired portfolio replay supports net benefit. There is no scheduled
re-optimization or automatic winner selection. A fortnightly review is a status
checkpoint, not a new independent sample and not permission to peek-adjust the
candidate.

## Safety / exclusions

- Measure-only: no reads from any scorer, eligibility gate, sizing, portfolio
  construction, rotation, position/exit logic, PaperTrader, or broker path.
- No score/weight/threshold/strategy/portfolio setting changes, paper fills,
  live orders, or automatic promotion.
- No claim of “best formula since 2010” unless complete, licensed, point-in-time
  feature, universe, label and corporate-action data actually cover that period.
- No use of the June–October historical sample as a fresh prospective test. The
  pre-existing `variant_set_v1` is already declared; its pre-declaration rows
  remain hindsight even if the new mining method can fit them.

## Required implementation gates

1. Failing-closed fit tests, including missing dimensions, fixed-cohort pairing,
   deterministic repeatability, and negative controls. Fold/purge tests are a
   gate for the future nested diagnostic, not claimed complete now.
2. Immutable candidate/fit provenance and complete trial accounting.
3. Owner-only candidate generation; scheduled evaluation only after declaration.
4. Learning page separates overfit/hindsight from forward evidence and exposes
   global frozen-set provenance even when a selected market/horizon has no fitted
   candidate; the one-time fit action is disabled after the immutable set exists.
   Small samples mean `insufficient_evidence`, never pass.
5. Verified migration, route authorization, and no money-path imports/callers.
6. Full relevant test suite, typecheck, production build, and deployment/migration
   verification before calling the app implementation live.

## Separate algorithm tournament

This feature does not claim that the existing alternate-weight shadow tests
distinct trading algorithms. The external strategy program remains a separately
gated workstream under `features/external-strategy-discovery/FEATURE_ARCHITECTURE.md`:
first revalidate its current data/readiness contracts, then test a small
predeclared family (entry, exit/holding, exposure, defensive roles) through
point-in-time replay, realistic costs, negative controls, and an immutable trial
ledger. No broad internet-strategy sweep or paper activation is included here.
