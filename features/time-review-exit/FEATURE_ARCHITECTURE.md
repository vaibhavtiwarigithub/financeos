# Time-Review Exit Policy

Status: APPROVED FOR P0 MEASUREMENT ONLY on 2026-08-07

## Decision

Kairos must not close an otherwise healthy profitable position solely because it
has crossed its configured holding horizon. The current horizon remains a hard
paper/live exit until a separately governed candidate proves better. The first
change is therefore a forward-only, append-only time-review shadow, not an exit
change.

## Problem

`PositionMonitor` currently closes a paper position when its age is greater than
its resolved horizon. A common ten-session plan therefore closes on session
eleven even when the position is profitable, has fresh research support, and is
still trending. That makes the horizon a liquidation timer rather than a review
point. Existing exit shadows compare static stops, targets, trails, and clocks;
they cannot reconstruct whether a specific position was healthy at its horizon.

## Product Rule

The eventual candidate policy is a deterministic time review:

1. Mechanical protection always wins. A protective stop, confirmed thesis/score
   exit, target handling, or mandatory risk restriction may close first.
2. At the configured horizon, a profitable alpha position is reviewed, not
   automatically extended.
3. It can be retained only when every required review input is fresh and the
   predeclared health rule passes. A one-session dip, a stale score, or missing
   evidence does not manufacture a positive result.
4. Partial-profit logic remains independent: a target can take a bounded partial
   and move the remaining stop to breakeven. It is not an excuse to keep adding
   risk or to remove protection.
5. A fixed maximum extension remains a safety boundary. This design never turns
   a swing mandate into an indefinite investment.

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
Future close outcomes are attached only after their market sessions mature.

## P0: Collection Only

### Trigger

The existing per-market `PositionMonitor` run observes each open paper alpha
position at exactly its resolved horizon, before the incumbent `age > horizon`
time-stop can fire. Hedge positions are excluded. The observer must be
best-effort and may never delay, suppress, or alter an exit.

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

### Initial Candidate Family

The trial family is deliberately small and predeclared:

- baseline: incumbent exit on the next session after the configured horizon;
- candidate A: extend five market sessions only when profitable, score is fresh,
  score is at or above the hold threshold, direction remains long, and drawdown
  from the stored high-water mark is no greater than one initial stop distance;
- candidate B: the same rule with ten market sessions.

Unknown score, unavailable direction, invalid price, or stale evidence is a
recorded `not_eligible`, never a synthetic healthy state. The candidate never
widens a stop, raises a position size, reopens a name, or overrides an existing
score/stop/target exit.

## P1: Outcome Labels And Evaluation

After five or ten completed sessions, a labeler records native-currency return,
benchmark return over exactly the same dates, excess return, maximum favourable
and adverse excursion, and whether the candidate would have hit a mechanical
stop. It also records whether an already-qualified replacement candidate existed
at the review session. Replacement is an attribution field in P1; it is not
reconstructed from future signals and does not authorize rotation.

P1 compares each candidate with the incumbent by market only. It reports sample
size and distinct review sessions, costs, drawdown, turnover, raw and benchmark-
relative returns, and false retention cases. It does not use a per-trade excess
average to approve a rule with a different holding period; any activation needs
an execution-faithful, market-local portfolio simulation with redeployment.

## Activation Gates

No P0/P1 record changes an exit. A paper-only candidate requires all of:

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

- no immediate modification to the `PositionMonitor` time stop;
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
4. Add outcome maturation and Upgrade Path readiness reporting.
5. Build the execution-faithful portfolio simulator only after enough review
   observations exist; do not activate from static candle evidence.
