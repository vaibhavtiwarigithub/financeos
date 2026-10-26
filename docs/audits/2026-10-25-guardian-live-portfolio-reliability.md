# Guardian and live-portfolio reliability

## Scope and existing owners

Repairs reuse the existing US Guardian plan endpoint/panel, India Kite coverage
route and pure GTT matcher, live portfolio sync handlers and System Health funnel.
They restore approved read-only visibility; no new tables, routes, schedules,
models, subscriptions, trading formulas or order permissions were introduced.

## Findings and repairs

- A US plan-read HTTP error could render “no plans.” It now renders unknown,
  exposes a read-only retry and reports a failed database read in health.
- A lost/malformed action response now reloads state before another owner action;
  the application does not automatically dispatch another action.
- India malformed holdings could throw or become empty. Invalid GTT data became
  an empty book. Both stay explicitly unavailable/unknown and report health.
- Same-name GTT matching ignored NSE/BSE identity. Invalid OCO quantities could
  be filtered away, and a target-only SELL could look like stop coverage.
  Matching now preserves exchange, checks every leg and trigger index, and
  requires a downside SELL trigger relative to the broker-reported holding price.
- Broker sync now rejects unsuccessful HTTP responses and refreshes Guardian
  rather than leaving old coverage displayed after a newer holdings read.

Kite's official contract specifies exchange identity and an index correspondence
between trigger values and child orders. Two-leg triggers are OCO, not additive
protective quantities: https://kite.trade/docs/connect/v3/gtt/ . A limit child can
still remain unfilled; these checks do not establish guaranteed protection.

## Verification

Regression tests first reproduced malformed sources, cross-exchange matching,
target-only false coverage and invalid legs. Focused suite: 46 tests passed.
An older partial-quantity fixture had two trigger values but only one child; it
was corrected to a valid single-leg fixture rather than relaxing validation.
TypeScript and secret scans passed. Full suite: 4,456 passed, eight skipped, zero
failures across 535 passing files and one skipped file. Exact release identity
and production verification are checked at handoff.

Synthetic-only browser harness: failed load displayed unknown; Retry recovered;
a changed plan with malformed action-response JSON was reloaded with exactly one
action POST. No browser page errors or overflow at 375/768/1440 pixels. An initial
socket-abort diagnostic observed browser transport retries, so the UI does not
claim that HTTP transport itself can never retry. No real plan/order was tested.
The local harness is outside the repo and is stopped after verification.

Authenticated production inspection before release confirmed the existing exact-
stop scorecard. It had zero evaluated and one legacy/ungraded US suggestion:
there is no defensible stop-benefit estimate yet. History is not fabricated.

## Remaining Guardian/live-portfolio work

- Universal automatic live protection is not delivered: complete account-specific
  capital, additional-loss and activation bounds and per-broker protective-order
  lifecycle evidence are required. A one-time mandate question is pending.
- Full India manual-fill attribution, stop advice, plan approval and monitoring
  are not the read-only GTT panel. They still require an approved state-machine
  design and the account mandate. Webull/Alpaca execution parity is also unbuilt.
- Regime-adaptive recovery ladders remain the documented proposal in
  `docs/research/live-holding-loss-review.md`; no automatic averaging down or new
  exit policy is activated by this repair.
- True live investment returns still lack verified cash-flow history. The chart
  remains labelled recorded-equity change; it does not claim live alpha.
- Next scheduled Webull risk collection must confirm the earlier source repair.
  Daily live-holding research is monitored separately from protection coverage.

Primary Robinhood execution remains excluded. Existing financial history, live
flags, risk limits and models are unchanged. No paid upgrade was used.
