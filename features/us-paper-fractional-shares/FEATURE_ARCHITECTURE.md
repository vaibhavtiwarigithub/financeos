# US Paper Fractional Shares

> Status: **APPROVED FOR IMPLEMENTATION**
> Owner approval: 2026-07-26
> Scope: US paper book only

## Problem

The US paper pool holds cash that can fund qualified positions, but PaperTrader rounds
all quantity down to a whole share. A valid US allocation below one share becomes an
`insufficient_cash_for_1_share` rejection even though US fractional execution is
available. Production on 2026-07-26 had $5,178.58 cash and multiple such skips.

## Decision

Allow US paper entries, rotations, and target partials to use quantities rounded down
to six decimal places. India remains whole-share because this app has not established
fractional NSE execution semantics. `qty` and all relevant paper RPC arguments are
already `numeric`, so no schema migration is needed.

The US paper mandate increases from 10 to 15 alpha names. It is a per-market setting;
it does not modify India, existing positions, stops, targets, score thresholds, or
live-order limits.

## Rules

- US entry quantity: `floor(maxSpend / price, 6 decimals)`; must be finite and > 0.
- India entry quantity: unchanged `floor(maxSpend / price)`; must be >= 1.
- US partial target: sell half rounded down to six decimals only when both the sell
  and remaining legs are positive. Otherwise close the full position.
- All cash, notional, caps, name/sector limits, rotation gates, and transactional RPC
  checks run unchanged and continue to receive the exact numeric quantity.
- No live broker call or live quantity behavior changes.

## Acceptance

- A $100 US allocation can buy a fractional share priced above $100.
- An equivalent India allocation remains rejected if it cannot buy one share.
- US partial profit-taking preserves quantity and cash conservation.
- Decimal quantities pass the existing fill/exit/rotation RPC contracts.
- Tests cover rounding, no dust/NaN, US-vs-India isolation, and partial exits.
