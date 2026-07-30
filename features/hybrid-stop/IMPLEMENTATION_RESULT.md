# Hybrid Protective Stops: P1 Implementation Result

Date: 2026-07-30
Status: Implemented and intentionally non-executable at a broker.

## What P1 Adds

- A deterministic, account-local `position_id` for managed live positions.
- Read-only full-coverage evaluation against the existing `protective_orders`
  ledger. A row counts only when it is the sole exact match, active, unexpired,
  broker-identified, and covers the full reconstructed quantity.
- A fail-closed autonomous-entry interlock. New autonomous live BUYs require:
  1. `protective_orders_enabled=true`;
  2. a future broker-specific placement/reconciliation worker; and
  3. full coverage for every current managed live position.

## What P1 Does Not Do

- It does not call, place, alter, cancel, or read back a broker order.
- It does not change paper trading, manual live trading, the existing synthetic
  live-exit monitor, scoring, learning, or allocation.
- It does not activate Webull, Robinhood, Kite GTT, or any feature flag.

The placement-worker constant is false in source code. Therefore a database or
Settings change cannot accidentally create autonomous positions without a
broker-resident protection implementation.

## P2 Prerequisites

P2 is a separate approved broker-by-broker change. It requires an account and
instrument-specific capability proof, sandbox/manual canary, idempotent
place/read-after-write/reconcile lifecycle, cancel-before-competing-sell protocol,
and a failure-injection test suite. Robinhood has no verified stop-order adapter;
Kite GTT has limit-child gap risk; Webull remains disabled pending its own sandbox.
