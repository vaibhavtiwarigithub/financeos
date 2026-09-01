# Deterministic Portfolio Simulation

Status: Approved by owner for isolated implementation on 2026-08-10

## Decision

Kairos will add a deterministic, market-local portfolio simulator for evaluating
research and exit hypotheses. It is an analytical engine only: it cannot read or
write live/paper portfolio state, scores, strategies, signals, proposals, orders,
or broker records.

## Why this exists

The existing historical replay and exit-path shadows correctly measure individual
decision paths, but they cannot rank rules with different holding periods. A rule
that exits earlier frees cash sooner; a per-trade comparison cannot observe the
subsequent redeployment of that cash. The simulator closes that measurement gap.

## Invariants

1. One run has exactly one market and native currency: `us/USD` or `india/INR`.
2. Every input event carries an execution session and a known-at timestamp. The
   caller is responsible for supplying only point-in-time-safe inputs.
3. Cash, fills, costs, position caps, fractional-share policy, and benchmark are
   explicit inputs. No hidden global configuration is read.
4. A rejected, unavailable, malformed, stale, or out-of-order event is an
   abstention recorded in the result, never a fabricated fill.
5. Equal timestamp events are ordered deterministically: exits, then entries,
   then lexical symbol/order key. This permits same-session redeployment without
   double-spending cash.
6. The simulator applies only deterministic input instructions. It does not
   calculate a score, choose an instrument, invoke an LLM, or generate an order.
7. Results are immutable experiment artifacts when persistence is later added;
   the initial core is pure TypeScript with fixture tests.

## Scope

P0 builds a pure simulation core and fixtures. It supports long-only entry and
exit events, entry costs, exit costs, explicit quantity or cash allocation,
market-local cash, whole/fractional share rules, an open-name cap, and daily NAV.
It returns every accepted/rejected event, cash history, holdings, realized P&L,
and a run fingerprint supplied by the caller.

P0 intentionally excludes live data acquisition, intraday assumptions, tax-lot
selection, borrowing, options, leverage, automatic strategy selection, and
database persistence. Those require separate data/execution architectures.

## Integration boundary

The first consumer will be a future owner-triggered historical experiment using
sealed input packets. Exit shadows, challenger validation, and benchmark analysis
may consume results only as diagnostics. A separate approved evaluation must still
decide whether a rule is useful; a simulation result cannot change any policy.

## Acceptance criteria

- US and India runs cannot be combined or cross-funded.
- An exit can release capital for a later same-session entry exactly once.
- Cash never becomes negative; every rejection has a reason.
- Fractional quantity is rejected when the market policy disallows it.
- Costs and realized P&L reconcile from immutable simulated fills.
- Re-running identical inputs produces byte-identical results.
- No import path from simulator reaches a provider, Supabase, scorer, agent,
  PaperTrader, live execution gateway, or broker adapter.

