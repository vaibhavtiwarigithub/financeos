# Actual-entry ladder replay and exit-panel correction — 2026-09-12

Read-only production evidence replay. The only runtime correction in this pass
is implementation integrity: paper and live now call the same approved ladder
core, and a bar's earlier low cannot be tested against a trail created by that
bar's later close. No target, stop distance, score threshold, position size,
live-enable setting, broker state or order was changed.

## Why the preceding panel could not authorize a target change

The broad price-panel result was useful as a hypothesis generator, but its
headline overstated what it measured:

1. Its so-called "deployed" target arm liquidated **100%** at +8%. Kairos banks
   roughly half, raises the runner stop to breakeven-or-better and continues
   managing the remainder. `exit-path-sim.ts` itself calls its output a mandate
   proxy and explicitly says it cannot reconstruct partial targets or score
   exits.
2. It triggered targets from the daily **high**. The scheduled paper monitor
   triggers a target from its observed price/close; only the US stop check uses
   the session low.
3. It tested each arm's mean return against zero. The decision statistic is the
   paired return difference between two policies on the same entry paths.
4. The claim that every target-bearing arm had an 8% median contradicted its own
   table: the 8% + trail row had a **0.29%** median.
5. Calling 1.93% versus 1.94% a validation of the trail was unsupported. The
   reported t-stat change measured each arm against zero, not the trail's paired
   incremental return.

Those claims are corrected in `2026-09-12-exit-geometry-panel.md`; the broad
panel is now labelled as a full-liquidation geometry proxy.

## Actual-entry method

- Population: clean, non-excluded, alpha-role `paper_trades` BUY fills.
- Unit: one entry **event**, not one current lot. Partial exits clone a residual
  BUY lot with the same `paper_event_id`; those rows are collapsed and their
  quantities summed, preventing a partial winner from counting twice.
- Entry: actual fill price and market-local execution date.
- Exit evidence begins on the next session, avoiding use of the entry day's
  pre-fill high/low.
- The shared `decideExitLadder` core simulates a partial target, runner stop and
  trail. US stop checks may use the session low; India uses close-only because
  that is the evidence its current monitor has.
- Surviving quantity is marked at each measurement horizon. The horizon is not
  represented as a time-stop exit.
- Candidate differences are paired entry-by-entry against partial@8%, then
  clustered by entry date. Both equal-entry and entry-notional-weighted means
  are reported.
- Mechanical ladder only: historical score exits cannot be reconstructed beyond
  the point-in-time signals actually captured, so this is not labelled a full
  deployed-policy replay.

## Results

### US

| horizon | matched events / dates | partial@8 mean (notional) | partial@16 delta (notional) | no-target delta (notional) | clustered t(delta) |
|---|---:|---:|---:|---:|---:|
| 10 sessions | 54 / 19 | -0.52% (-1.27%) | +0.02pp (-0.01pp) | +0.02pp (-0.01pp) | -0.39 |
| 20 sessions | 45 / 13 | -0.27% (-1.40%) | **-0.30pp (-0.31pp)** | **-0.30pp (-0.31pp)** | -1.69 |
| 40 sessions | 4 / 3 | -2.90% (-4.27%) | 0.00pp | 0.00pp | unavailable |
| 60 sessions | **0** | unavailable | unavailable | unavailable | unavailable |

The strategy-selected US entries do **not** reproduce the unconditional panel's
+0.57pp no-target result. At 20 sessions the direction is worse, not better,
and does not clear a decision gate. Keep the 8% partial target unchanged.

### India

| horizon | matched events / dates | partial@8 mean (notional) | partial@16 delta (notional) | no-target delta (notional) | clustered t(delta) |
|---|---:|---:|---:|---:|---:|
| 10 sessions | 44 / 22 | +1.76% (+0.81%) | +0.29pp (+0.14pp) | +0.09pp (-0.19pp) | 1.27 / 0.11 |
| 20 sessions | 25 / 13 | +2.62% (+1.45%) | **+1.06pp (+0.49pp)** | **+1.02pp (+0.49pp)** | 2.36 / 2.38 |
| 40 sessions | 6 / 4 | +1.67% (-0.28%) | +1.01pp (+0.62pp) | -0.17pp (-0.11pp) | 0.65 / -0.36 |
| 60 sessions | **0** | unavailable | unavailable | unavailable | unavailable |

The India h20 result is promising but not promotable: only 25 events across 13
dates qualify, 58 of 132 clean India entry events have no `price_cache` series,
the median paired delta is 0, and the longer h40 read does not persist. The large
coverage hole can select which symbols enter the result. Keep the India target
unchanged and fix/capture coverage before treating h20 as causal evidence.

## Implementation defect found and fixed

The parity architecture said paper and live called one shared ladder function,
but production code did not: live called `decideExitLadder`; paper repeated its
own arithmetic. Both implementations also allowed a same-observation ordering
error in the daily-low case: they could raise a trail from today's close and
then test today's earlier low against that newly raised stop.

The ladder core now tests the current observation against the **previously
persisted** high-water/trail first, and ratchets from the current close only for
the next observation. Paper now calls that same core. A source-contract test
requires both monitors to retain the shared call, and path tests fail if the
same-bar look-ahead returns.

## Decision

- **US:** reject target removal/raising on current evidence.
- **India:** keep 16% and no-target as measure-only candidates; repair price
  coverage and require a larger matched-date sample plus persistence at a longer
  horizon.
- **Both markets:** no 60-session actual-entry conclusion is currently possible;
  there are zero fully observed 60-session entries. The prior statement that the
  actual-entry no-time-stop question needed "no new waiting" was wrong.

Reproduce:

    npx --yes tsx@4 --env-file=.env.local scripts/exit-geometry-actual-entries.ts
