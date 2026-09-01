# India secondary-benchmark fallback

> Status: **DRAFT — scope only, awaiting owner approval. No code written.**
> Date: 2026-09-01. Influence if approved: **none on the money path.** Writes only
> `benchmark_price_observations`, which feeds the comparison chart and the
> scorecard. No scorer, sizing, exit, order or broker path reads it.

## The problem, stated precisely

India secondary benchmarks have exactly one price source: Yahoo. Measured
2026-09-01, all three ETFs are missing the **2026-08-31** session while the India
primary `^NSEI` has it:

| benchmark | provider | missing sessions |
|---|---|---|
| NIFTY 50 (`^NSEI`) | yahoo | 0 |
| BANKBEES | yahoo | **2026-08-31** |
| ITBEES | yahoo | **2026-08-31** |
| JUNIORBEES | yahoo | **2026-08-31** |

The book has a NAV for 2026-08-31, so the comparison chart drops that session
from every India ETF comparison.

## Why the US fix does NOT cover this

`pickFreshestProvider` (shipped 2026-09-01, `lib/data/benchmark-ingest.ts`)
chooses **one provider's whole series** by which reaches furthest forward. That
solves the US failure, which was *tail staleness* — XLK stuck eight days behind.

India's failure is a different shape: an **interior hole**. Yahoo is the freshest
source (it has 09-01), so freshest-wins keeps Yahoo and the 08-31 gap survives.
Adding a second India provider under the current mechanism would change nothing.

**This needs a per-date merge, not a per-provider choice.** Stating that plainly
because it is the whole reason this is a separate piece of work rather than a
config line.

## What already exists (no new integration required)

- `fetchUpstoxCandles(symbol, days)` — `lib/data/upstox.ts:78`, working today.
- All three ETFs resolve in the cached instrument master:
  `BANKBEES -> NSE_EQ|INF204KB15I9`, `ITBEES -> NSE_EQ|INF204KB15V2`,
  `JUNIORBEES -> NSE_EQ|INF732E01045` (verified in `upstox_instruments`,
  2,714 rows, refreshed 2026-08-28).
- Upstox already backs the India **primary**: `paper_performance.bench_source`
  shows `upstox+yahoo` (32 rows) and `upstox(yahoo_disagreed)` (7 rows).
- The cross-check and disagreement vocabulary already exist for the primary.

So this is wiring an adapter that is already in production, to symbols it can
already price.

## Two constraints that shape the design

**1. Upstox never returns the current session.** `/v3/historical-candle` lags by
one session by design — this is why `confirmBenchmarkSessions` and deferred
confirmation exist for the primary. Upstox is therefore a **settled-bar backfill
source**, not a freshness source. That is exactly the right shape for filling
yesterday's hole, and exactly the wrong shape for a freshest-wins contest.

**2. The Upstox token is environment-based and intermittent.**
`lib/data/upstox.ts:20` reads `process.env.UPSTOX_ACCESS_TOKEN`; there is no
vault entry. Production evidence of intermittency: 2 of 42 India primary rows
fell back to `yahoo(unconfirmed)` (2026-08-28 and 2026-09-01) when Upstox was
unavailable. The design must treat Upstox as **sometimes absent**, never as a
guaranteed second opinion.

## Proposed design

Extend secondary-benchmark ingestion for India only:

1. Fetch Yahoo as today (primary source, keeps the current session).
2. Fetch Upstox for the same symbol.
3. **Merge per date.** Yahoo wins any date it has. Upstox fills dates Yahoo is
   missing. Each row keeps its own `provider`, which the table already stores per
   row, so a merged series is fully attributable.
4. Where BOTH have a date, compare. If they disagree beyond a tolerance, keep
   Yahoo's value and mark the row `source_status` accordingly — reusing the
   existing disagreement vocabulary rather than inventing a second one. Do not
   silently prefer either.
5. If Upstox is unavailable (no token, throttled, empty), behave exactly as today
   and let the existing `benchmark-stale` alert speak.

The merge helper is pure and belongs beside `pickFreshestProvider` in
`lib/data/benchmark-ingest.ts`, unit-tested with the real 08-31 shape.

## What this deliberately does NOT do

- No change to the India **primary** benchmark path. It already has Upstox, a
  cross-check and deferred confirmation; touching it risks a money-path-adjacent
  series for no stated benefit.
- No US change. Freshest-wins is correct there and is now verified.
- No new provider, no new dependency, no new table, no migration.
- No attempt to make Upstox a freshness source. It structurally cannot be.

## Open questions for you

1. **Is it worth it?** These are *display comparators*. The cost of the gap is
   one missing session on a chart line, now visibly flagged rather than silent.
   The honest case for doing it is completeness of the comparison series; the
   honest case against is that nothing downstream consumes it and the same effort
   could go to a money-path item.
2. **Disagreement tolerance.** The primary uses an explicit percentage. Reuse the
   same number, or set one per ETF? I would reuse it and revisit only if it fires.
3. **Token durability.** Upstox tokens are short-lived. If refresh is manual, this
   fallback degrades to "works when someone refreshed the token", which is worth
   knowing before building rather than discovering later.

## Estimate

Small: one merge helper plus tests, one branch in `upsertProviderObservations`,
no schema change. The risk is not size — it is that a merged multi-provider
series is harder to reason about than a single-source one, and the thing it fixes
is currently one missing point on a comparison chart.

**My recommendation: defer.** The gap is now visible rather than silent, which
was the actual defect. I would rather spend the next unit of work on something
the book reads.
