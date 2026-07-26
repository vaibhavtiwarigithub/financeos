# Market-Local Risk Configuration

> Status: **DRAFT - NOT APPROVED FOR IMPLEMENTATION**
> Trigger: 2026-07-26 configuration audit

## Decision Needed

US and India should have independently configurable execution risk limits. Their
genomes already evolve independently, but the owner sizing ceiling is still read from
the global `strategy_config.position_size_pct`. That is an unsafe hybrid: a change
intended for one currency/book silently changes the other market's maximum new-paper
position size.

Do not choose different numeric values speculatively. The correct immediate change is
ownership and provenance, not an India-specific risk opinion without sufficient
market-local outcomes.

## Current State

- `trading_mandates` is per-market and currently controls score threshold, default
  stop loss, target, holding horizon, open-name cap, and signal freshness.
- Production US and India mandate rows currently both use `60 / 7% / 20% / 10 names`.
  Equal values are valid defaults; they are not evidence that the settings should be
  permanently shared.
- PaperTrader reads `strategy_config.position_size_pct` as the flat-size fallback and
  as the cap on either market's champion genome. This is global.
- Existing positions persist their entry stop/target and mandate snapshot. Changing a
  mandate is gate-only for new entries unless its explicit existing-positions policy
  is approved and executed.
- The US ETF allocation cap is a US instrument-class policy. It must not be copied to
  India; a future India fund/ETF sleeve needs a separately classified INR policy.

## Scope

1. Add `max_position_pct` to `trading_mandates`, constrained to 1-30 and seeded from
   the owner-approved current global ceiling for each market.
2. Make PaperTrader load this strict market-local value before sizing. It becomes the
   flat fallback and the upper cap for that market's genome/Kelly result.
3. Stamp the resolved cap and mandate version into each paper fill's existing mandate
   snapshot/decision journal record.
4. Keep `strategy_config.position_size_pct` as a deprecated UI-preset/template only
   until settings migration is complete; it must not be an execution fallback once
   market mandates are required.
5. Expose US and India controls separately in Settings with an explicit statement
   that edits affect future entries only.

## Non-Goals

- No retroactive resize, forced exit, stop rewrite, or cross-market normalization.
- No automatic genome parameter divergence or learner-authorized money-limit change.
- No India ETF policy inferred from US ETF tickers.
- No live-order behavior change; this is first a paper-path configuration correction.

## Safety Requirements

- Missing/malformed market mandate or max-position value fails closed for new paper
  entries; it never falls back to the other market or global value.
- US and India pools, currencies, position counts, NAV, and caps remain isolated.
- A champion genome may size down but never above that market's owner cap.
- Settings writes are owner-authenticated, versioned, audited, and do not alter
  existing position snapshots.
- Database migration includes a CHECK constraint, RLS verification, and a default-free
  backfill that explicitly seeds both current market rows.

## Acceptance Criteria

- A US cap edit cannot change an India simulated order, and vice versa.
- A missing India cap blocks only India new entries with an auditable reason.
- Existing positions preserve their stored entry plan after a settings edit.
- Tests cover flat and Kelly sizing, both markets, missing configuration, snapshot
  provenance, and no cross-currency aggregation.
- `docs/arch/03-agents.md`, `04-database-schema.md`, `08-risk-and-safety.md`, the
  System Map, migration tracker, typecheck, tests, build, and production schema/RLS
  verification are updated before ship.

## Build Order

1. Approve initial US and India max-position values.
2. Add migration and strict mandate type/loader support.
3. Change PaperTrader sizing and immutable fill provenance.
4. Add separate Settings controls and tests.
5. Verify production schema, then observe paper entries before considering live reuse.
