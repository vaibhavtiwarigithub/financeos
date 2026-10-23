# Shared leveraged intraday v3 repair

## What was wrong

The old four paper doors used different late-morning entry windows, daily ATR
and daily trend data. A 10:30 research pass and a 10-session council forecast
were not an intraday opening assessment. SOXS's October 22 noon attempt was
rejected for stop risk, not council score. Its overnight gap was not a return
available to someone who first bought after the open. All three council members
also cited generic app entry-block metadata as a negative predictor. The common
ETF cap compressed a separately routed sleeve that cannot enter equity rotation.

## Implemented contract

- One pure current-session evaluator for all four, with explicit inverse sign,
  ETF/proxy opening-range and VWAP confirmation, aligned completed five-minute
  bars, non-overlapping session volume comparisons and explicit IEX provenance.
  Relative volume compares equal elapsed-session windows over three to five
  prior complete sessions. Missing periods, bad OHLCV or stale event times do
  not become observations or zero scores.
- Two-minute maximum paper quote age, ten-minute prior verified quote-path
  liveness, five-minute scheduled checks and a 09:00 ET context research pass.
  Empty no-op runs cannot manufacture monitor proof. Unknown years, holidays,
  early closes, premarket and after-hours use the existing shared calendar.
- Daily history/liquidity/research still provide context, but a prior-day long
  score is not required to recognize an independently confirmed current setup.
  This does not use council opinions to place orders.
- Intraday invalidation plus two-range-ATR volatility stop; target covers at
  least twice the full initial risk, rounded upward for decimal serialization.
  The 12% stop-distance ceiling, 1% risk budget, 0.5% viable-entry minimum and
  combined 5% sleeve ceiling remain. Total distinct symbols also respect the
  stored market mandate. Exact opposing funds are not concurrent holdings.
- Service-only admission is rechecked under the existing portfolio lock in all
  four fill RPCs, including marks, quantity/notional consistency and quote age.
  New positions store their entry policy. Historical rows remain policy-null.
- New v3 lots attempt a full exit in the last fifteen regular-session minutes;
  a failed session-end exit is retried on the next regular-session observation.
  The generic daily monitor does not impose another exit policy on new v3 lots.
  Legacy positions are not force-liquidated. Full-session pre-entry highs/lows
  cannot be replayed against a later entry or a newly ratcheted stop.
- Existing partial exits already clear the target atomically. That state is
  reused; no duplicate partial-state table or column was added.
- Council v2 removes permissions/indicative trade plans from new packets and
  states the ten-session forecasting task explicitly. New method IC series are
  separated from legacy series, including matched baselines/blends and actual
  model identity. Subscription-only, hybrid and API paths retain provenance.
  The leveraged composite has a separate uncapped version; ordinary ETF ranking
  caps, outer dimension weights, council roster, budget and enablement are unchanged.
- UI labels say ten-session outlook, not intraday prediction or return percent.

## Verification evidence

Full regression before final release: 4,298 passed, eight skipped, zero failures.
The focused clock/setup suite covers all four doors, post-I/O time, stale/future
quotes, closing-window crossings, inverse direction, incomplete bars, actual
range risk, reward/risk, opposing exposure, early closes, DST, unsupported years,
prompt contamination and method separation. TypeScript passed. Local production
scratch builds generated all 78 pages; exact final production build is verified
against the pushed SHA before completion. Generated build references are restored.

Real app-adapter collection returned usable five-minute data for all six symbols:
SOXL 456, SOXS 465, TQQQ 427, SQQQ 504, SOXX 443 and QQQ 452 observations in the
read window. A historical plumbing exercise at October 22 11:00 ET returned wait
for SOXL/TQQQ and ready for SOXS/SQQQ; same-time relative volume was approximately
1.69/1.05/1.06/1.05 with four prior complete comparison windows. This is NOT an
out-of-sample profit test or a reconstruction of executable historical fills.

The additive guard/provenance and admission-contract migrations were applied and
inspected in production. All four functions call the common guard; anon and
authenticated lack execute privileges, service_role retains them. Subscription
enqueue preserves new prompt identity. Positive admission, opposite-pair, cap,
reward/risk, minimum-size and max-symbol tests ran inside an explicitly rolled-
back transaction without executing a fill. Original cash and eight-slot mandate
were verified restored, and zero real positions acquired a new policy version.
Null/NaN/mismatched-notional/stale-quote rejection was independently verified.
Security-advisor counts were unchanged; this is not a clean global security audit.

The new schedule migration is deliberately applied only after runtime READY.
It removes superseded paper pg_cron jobs, replaces them with four five-minute
jobs and moves, rather than adds, the four-symbol LLM research pass. Duplicate
paper Vercel jobs are removed; live jobs/flags and owner settings are not enabled.

## Honest remaining boundaries

The next natural open-session runs must establish current production collection,
decisions and end-session exits. Closed-market QA cannot prove those outcomes.
Polling can miss barriers between observations, a partial-venue VWAP is not a
consolidated tape, and a gap can defeat a planned stop. Missing exit quotes can
leave a position overnight; the system must alert, not fabricate a fill.
These fixed policy priors are not demonstrated profitable alpha.

The US paper book currently has no available cash. A qualified setup still
cannot create buying power; this release does not sell unrelated positions or
increase leverage to manufacture an entry. Live funds remain off. The dormant
live planner has opposing-pair and full-risk target checks, but it does not have
the paper v3 intraday execution policy or verified real stop/cancel/fill evidence.
That broker lifecycle is not marked complete. Owner Kite authentication and
missing historic cash-flow/account-value evidence also cannot be invented by a
code change. Cash-flow-adjusted live investment returns remain unbuilt.
