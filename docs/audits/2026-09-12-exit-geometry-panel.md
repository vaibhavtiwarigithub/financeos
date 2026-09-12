# 2026-09-12 Exit-geometry panel backtest

Read-only. No score, weight, exit, sizing or live setting changed.

## Why this exists

The ATR-stop hypothesis had been gated on a weekly shadow reading matured
decision labels, which at US h20 held **0.7 of the 12** effective
non-overlapping observations it requires. Exit geometry is a pure PRICE
question, so it never needed those labels: `price_cache` holds 317 symbols with
OHLC and `lib/trading/exit-path-sim.ts` already replays bars.

Feeding the existing simulator from the price panel instead of the label ledger
moves the sample from 0.7 effective observations to **1,085 non-overlapping
entries across 89 US / 59 India entry dates** — available today.

Score-dependent questions (entry selection, the score-exit trigger) still cannot
be replayed: point-in-time fundamentals and sentiment were never captured before
2026-07-06, so reconstructing them would be look-ahead. This covers only the
price-only half.

## Method

- Entries sampled every 63 sessions per symbol, so forward windows never overlap
  within a symbol.
- `t_clust` averages within each entry DATE first, then tests across dates —
  because many symbols share a date and move together. Naive per-entry t
  overstates significance; both are reported.
- `simulateExit`'s pessimistic intra-bar rule is used unchanged: when one bar
  breaches the stop and reaches the target, the stop is assumed first.
- Max hold 60 sessions stands in for "no time stop"; the `time` share is the
  fraction that hit that cap.
- US and India reported separately, never pooled.

## Results

### US (768 unconditional entries, 89 dates)

| arm | mean% | med% | t_clust | worst% | exit mix |
|---|---:|---:|---:|---:|---|
| full-exit 7%/8% no trail proxy | 1.93 | 8.00 | 7.57 | -7.0 | target 55% stop 36% time 9% |
| full-exit 7%/8% + 7% trail proxy | 1.94 | 0.29 | 9.09 | -7.0 | trail 52% target 42% time 5% stop 0% |
| **7% stop, no target, 7% trail** | **2.51** | 0.22 | 7.03 | **-7.0** | trail 87% time 13% |
| full-exit 7%/16% + 7% trail proxy | 2.19 | 0.22 | 7.05 | -7.0 | trail 74% target 16% time 10% |
| 2.8 ATR stop / 8% target | 2.24 | 8.00 | 7.97 | **-30.0** | target 63% stop 28% time 9% |
| 2.8 ATR stop+trail / 8% | 1.93 | 8.00 | 8.12 | -28.1 | target 55% trail 41% time 3% |
| 2.8 ATR stop+trail, no target | 2.43 | -0.50 | 4.33 | -28.1 | trail 79% time 21% |

### India (317 entries, 59 dates)

| arm | mean% | t_clust | worst% |
|---|---:|---:|---:|
| full-exit 7%/8% no trail proxy | -0.31 | -0.52 | -7.0 |
| full-exit 7%/8% + 7% trail proxy | 0.29 | 0.43 | -6.9 |
| 7% stop, no target, trail | 0.23 | 0.70 | -6.9 |
| 7%/16% + 7% trail | 0.38 | 0.81 | -6.9 |
| 2.8 ATR stop+trail, no target | 0.84 | 1.20 | -20.3 |

**Nothing in India reaches significance** (all |t_clust| <= 1.2). No India
conclusion is drawn.

## Findings

1. **The full-liquidation proxy suggests an 8% cap can truncate random-entry
   paths, but it does not model the deployed ladder.** The prior claim that
   "every target-bearing arm has a median of exactly 8%" was false: the
   full-exit 8% + trail row has a 0.29% median. More importantly, Kairos banks
   only part of a splittable position at target, moves the runner stop to
   breakeven-or-better, and continues holding the remainder. Calling the
   full-exit arm "deployed" overstated what this panel established.

2. **The ATR stop is not free.** 2.8 ATR does reduce stop-outs as H1 predicted
   (36% -> 28%), and raises the mean, but the worst case degrades from **-7.0%
   to -30.0%**. H1 measured only the mean. On this panel the fixed 7% stop is
   the better tail contract, and the mean advantage disappears once the target is
   removed from both (2.51% fixed vs 2.43% ATR).

3. **The proxy trail changes path and variance, not mean return.** Mean return
   is 1.93% without it and 1.94% with it. The reported t-statistics test each
   arm against zero, not the paired difference between arms; therefore the
   7.57 to 9.09 change is not evidence that adding the trail improves returns.

## Limits on these results

- **Survivorship.** The universe is currently cached symbols; delisted names are
  absent. This flatters every arm, and flatters no-target arms MORE because they
  hold longer.
- **Unconditional entries.** Entries are every 63rd session, not
  strategy-selected. This measures the GEOMETRY under random entry, not the
  strategy. An entry edge could change the ranking.
- **60-session cap.** 13% of the no-target arm hit the cap, so a true no-time-
  stop policy would hold some of those longer than measured.
- These are descriptive panel results, not a promotion decision. A live target
  change remains a money-path formula change under Architecture-First Mode and
  needs a frozen counterfactual on real decisions before it ships.

## Correction recorded 2026-09-12

The first version mislabeled a 100%-at-target simulator arm as deployed behavior,
made a median claim contradicted by its own table, and compared per-arm t-stats
instead of the paired policy delta. The actual-entry, partial-ladder replay in
`2026-09-12-actual-entry-ladder-replay.md` supersedes the target conclusion.

## Reproduce

    set -a && . ./.env.local && set +a
    npx tsx@4 scripts/exit-geometry-panel.ts
