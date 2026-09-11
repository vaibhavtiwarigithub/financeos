# Technical IC Stage 0 — independent reproduction

Date: 2026-09-11  
Influence: read-only; no score, weight, eligibility, sizing, exit, paper, live,
broker or order path changed.

## Verdict

The US technical score is descriptively negative at medium horizons, but the
handoff materially overstated confidence and did not establish an entry-selection
root cause.

Its separate traded-vs-control result has the same overlap defect. The 15 paired
daily starts are about 1.5 effective h10 windows, not 15 independent dates.
Applying the repository's `sqrt(nEffective/nSessions)` scaling changes the
reported t from -3.26 to about -1.03. Pairing cancels common market movement,
not serial dependence.

The production replay used all paginated `observation_labels`, joined to their
immutable decision observations, filtered to `entry_eligible=true`,
`direction='long'`, technical available, and required at least five symbols per
session. Reproduction command:

```powershell
node --experimental-strip-types --env-file=.env.local scripts/technical-ic-stage0.ts --summary
```

| market | h2 IC / adjusted t | h5 | h10 | h20 |
|---|---:|---:|---:|---:|
| US | -0.004 / -0.06 | -0.130 / -1.55 | -0.199 / -1.56 | -0.276 / -1.51 |
| India | -0.002 / -0.02 | +0.039 / +0.31 | +0.177 / +0.97 | +0.097 / +0.42 |

At US h10, the conventional daily-session t is -4.94, but the 29 daily starts
contain only `29/10 = 2.9` effective non-overlapping windows. Treating all 29 as
independent is why the prior result appeared decisive. The app's predeclared
minimum is 12 effective observations, so every h5/h10/h20 result is currently
`insufficient_evidence`.

## Sub-feature result

US h10 rank IC: RSI -0.219, price-vs-EMA20 -0.085, price-vs-EMA50 -0.256,
20-day trend -0.187, and volume-vs-20-day average -0.014. The pattern is
consistent with medium-horizon momentum mean reversion; it does not prove that
interpretation.

## Population defect in the causal claim

The h10 US cohort contains 1,134 holding-source rows out of 1,374 (82.5%). The
holding slice is negative (-0.176); watchlist is +0.046 but only 120 rows across
10 qualifying sessions. These are repeatedly rescored positions after entry,
not a clean entry candidate population. Therefore “technical weight causes
PaperTrader to select the worst names” does not follow from this IC result.

## Accepted fix

`paper_trades.highest_price` was NULL on all 213 closed production rows because the
exit RPC preserved stop/target but deleted the position without copying its
high-water mark. Migration `20260911153405_capture_closed_trade_high_water.sql`
fixes full and partial exits atomically and refuses to apply if the stored
function shape has drifted. A rolled-back production transaction passed against
the real RPC; a follow-up query proved the production function was unchanged and
zero test rows persisted. Historical rows remain NULL and are not reconstructed.

The migration is not applied because the linked migration history contains
remote versions absent from this checkout. Do not use migration repair or force
push; reconcile the source migration history first.

## Decision

- Do not flip the technical sign or alter weights.
- Keep US autonomous live disabled.
- Treat the -3.45pp traded-vs-control gap as descriptive until it accumulates
  non-overlapping entry cohorts; it is not currently a significant estimate.
- Do not add a new indefinite-hold exit rule from a 1–2% descriptive tail.
- Before Stage 1, build an entry-time-only, non-holding cohort and accumulate at
  least 12 effective observations at the promoted horizon.
