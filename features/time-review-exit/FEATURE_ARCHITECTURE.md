# Time-Review Exit Observations

Status: **P0 descriptive observations only; the old P1 comparator is retired.**
Last reviewed: 2026-09-27.

> **Supersession notice:** The owner removed the unconditional time stop on
> 2026-09-10. Therefore the historical P1 baseline (“sell next session after
> the horizon”) is no longer the incumbent policy. The old +5/+10 outcomes are
> immutable hypothetical labels, not a comparison against current exits and not
> portfolio P&L evidence. Scheduled collection continues only for descriptive
> exact-horizon review observations; the scheduled route no longer matures new
> P1 outcomes. Do not use old readiness counts or labels to recommend an exit
> change. A new experiment needs its own approved architecture and a baseline
> that matches the current score/stop/target-driven exit behavior.

## Current decision

Kairos must not close an otherwise healthy profitable position solely because it
has crossed its configured holding horizon. The unconditional time stop was
removed by owner decision on 2026-09-10. The current exit system instead relies
on its data-driven score/thesis exits and protective stop/target logic. Reaching
the old horizon is a review checkpoint only; it does not create an incumbent
sale decision.

## Problem

The original feature was designed while `PositionMonitor` still applied a
maximum holding horizon. That exit was later removed. The old P1 experiment
assumed it could compare the incumbent next-session exit with +5/+10-session
holds; that comparator no longer represents what the app does. The P0 observer
still records position state at the exact horizon, which remains useful as
descriptive evidence about holdings and score freshness.

## Active P0 contract

The active observer is deterministic and descriptive only:

1. It records a position when it reaches its resolved-horizon review point.
2. Existing score/thesis exits, stops, targets, partial exits and risk controls
   remain independent and authoritative.
3. The observer cannot hold, close, resize, reopen, or protect a position.
4. A fresh score and positive review classification are descriptive facts only;
   they do not imply an extension recommendation or return advantage.

No LLM can select an extension, exit, threshold, or position quantity. LLMs may
only explain a completed deterministic observation outside the money path.

## Why A New Forward Ledger Is Required

`decision_observations` is immutable entry-time research evidence. Price candles
can replay a later return, but cannot recover the score freshness, direction,
drawdown, earnings state, or eligible replacement set known on the real review
date. Recomputing those facts today would introduce look-ahead bias. Historical
price-only path simulations remain useful for static geometry, but are not proof
for this policy.

P0 must instead write one immutable observation at each real horizon review.
The former P1 outcome-maturation design below is retained as historical context
only; it is not active under the current policy.

## P0: Collection Only

### Trigger

The existing per-market `PositionMonitor` observes each open paper alpha
position at exactly its resolved horizon. There is no `age > horizon` exit
branch. Hedge positions are excluded. The observer is best-effort and may never
delay, suppress, or alter an exit.

### Immutable Review Record

Each review record contains:

- position, symbol, market, native currency, entry timestamp and review session;
- entry price, review price, unrealized return, high-water mark and drawdown from
  that high;
- frozen resolved horizon and candidate extension horizon;
- freshest holding research score, direction, timestamp, score-age status, and
  exit/hold thresholds in force;
- deterministic review classification and every missing/failed input;
- entry mandate/strategy version provenance and an idempotency key.

The record is append-only, market-local, owner-readable, and written by the
service role only. US/USD and India/INR records are never combined.

### Retired Candidate Family (Historical Design Only)

The original, now-retired trial family was deliberately small and predeclared:

- historical baseline: incumbent sale on the next session after the configured horizon;
- candidate A: extend five market sessions only when profitable, score is fresh,
  score is at or above the hold threshold, direction remains long, and drawdown
  from the stored high-water mark is no greater than one initial stop distance;
- candidate B: the same rule with ten market sessions.

Unknown score, unavailable direction, invalid price, or stale evidence is a
recorded `not_eligible`, never a synthetic healthy state. The candidate never
widens a stop, raises a position size, reopens a name, or overrides an existing
score/stop/target exit.

## Retired P1: Outcome Labels And Evaluation (Do Not Run)

The historical labeler recorded native-currency return after five or ten completed sessions,
benchmark return over exactly the same dates, excess return, maximum favourable
and adverse excursion, and whether the candidate would have hit a mechanical
stop. It also records whether an already-qualified replacement candidate existed
at the review session. Replacement is an attribution field in P1; it is not
reconstructed from future signals and does not authorize rotation.

This P1 comparison assumed a next-session incumbent sale. That assumption is
obsolete because the unconditional time stop was removed on 2026-09-10. Existing
v1/v2 rows are immutable audit history; do not mature new rows or use them for
readiness or benefit claims. Any future exit experiment requires a new approved
architecture and a portfolio baseline matching the live score/stop/target policy.

The former P1 design compared each candidate with the incumbent by market only. It reported sample
size and distinct review sessions, costs, drawdown, turnover, raw and benchmark-
relative returns, and false retention cases. It does not use a per-trade excess
average to approve a rule with a different holding period; any activation needs
an execution-faithful, market-local portfolio simulation with redeployment.

## Retired Activation Gates (Not Applicable To Current P0)

No P0 record changes an exit. The following gates applied only to the retired
P1 candidate and are not a path to activate it:

1. at least twenty distinct review sessions per market and a predeclared trial
   correction across the two extensions;
2. no deterioration in cost-adjusted portfolio return, benchmark-relative return,
   maximum drawdown, or turnover against the incumbent in sealed replay;
3. a forward shadow whose point estimate and adverse-case review are consistent
   with the sealed replay;
4. an approved architecture update, a versioned mandate flag defaulting off, and
   an owner promotion for that market.

Live behavior is a separate approval after paper evidence. It retains all broker,
kill-switch, mandate, and protective-order gates.

## Explicit Non-Goals

- no restoration of the removed unconditional time stop;
- no LLM exit authority;
- no automatic adaptive extension duration;
- no cross-market/currency portfolio comparison;
- no using a current score to backfill a historic review;
- no capital-rotation decision in this feature.

## Acceptance Criteria

1. The P0 observer cannot change a paper position, paper trade, cash balance,
   order event, exit reason, score, mandate, or broker proposal.
2. A malformed or failed P0 write is visible in diagnostics but does not interrupt
   the incumbent monitor loop.
3. A review observation is idempotent for one position and review session.
4. Candidate health cannot be true with a stale/missing score or invalid price.
5. Tests prove the observer cannot execute an exit and that US/India facts cannot
   be combined.
6. Upgrade Path exposes collection progress and explicitly says it has no current
   influence.

## Build Order

1. Add the append-only review ledger and owner-only RLS.
2. Add a pure classifier and tests for the predeclared candidate family.
3. Add a best-effort P0 observer to PositionMonitor with no behavior change.
4. Keep the scheduled P0 review observations descriptive; do not mature the
   retired next-session-versus-extension labels.
5. Require a new approved architecture before implementing any policy-specific
   outcome or portfolio replay.
