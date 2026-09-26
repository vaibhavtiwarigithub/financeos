# Upgrade Path Causal Performance Attribution

Status: IMPLEMENTED — production-verified 2026-09-26 (owner approval 2026-09-18)
Owner: Vaibhav
Scope: Upgrade Path governance and evidence reporting only. No score, sizing,
paper, live, broker or execution behavior changes.

## Decision

Every Upgrade Path entry must show one of five explicit attribution states:

1. `measured` — a predeclared baseline-versus-variant comparison exists on the
   same market, common evaluation window, same eligible population, and cost
   model. It reports incremental portfolio return, benchmark-relative return,
   uncertainty, drawdown and turnover.
2. `collecting` — the program can affect a portfolio eventually, but its matched
   outcome window is not mature. It reports the exact missing sample/session
   gate, never an estimated gain.
3. `not_attributable` — the program is operational or descriptive only (for
   example data freshness, diagnostics or health), so a portfolio-return number
   would be a category error. It states the operational proof instead.
4. `invalid` — a purported result failed provenance, common-window, baseline,
   cost, independence, or version checks. It is visible as invalid and cannot
   make a path review-ready.
5. `producer_missing` — a path is eligible for performance attribution but no
   verified producer yet writes its portfolio-level paired replay. This is not
   equivalent to `collecting`: an active UI card or shadow event stream alone is
   not an attribution data pipeline.

`ready_for_review` continues to mean only that the path's declared evidence
gate is met. It is not a return forecast, approval, or deployment action.

## Causal contract

One append-only `upgrade_path_attribution_runs` row represents one immutable
comparison for one `{program_id, market, program_version, baseline_version,
as_of_session}`. The row stores:

- comparison type: `matched_replay`, `paper_cohort`, `operational_only`;
- start/end session and non-overlapping evaluation horizon;
- baseline and variant portfolio returns, same-window benchmark return, and
  incremental return (`variant - baseline`);
- net-of-cost incremental return, turnover, maximum drawdown delta, number of
  independent sessions, confidence interval and t-statistic where meaningful;
- matched population hash, point-in-time input hash, mandate/strategy versions,
  cost-model version, and a validity/reason field.

No result may combine US and India, use a different candidate population on the
two arms, overlap its nominal independent sessions, compare gross variant return
to net baseline return, or attribute a result across a mid-window program/mandate
version change. Any such mismatch writes `invalid` rather than a number.

## Program eligibility

Only programs with a predeclared decision alternative may eventually use
`matched_replay`: exits, entry/selection challengers, capital rotation,
allocation, sizing and strategy variants. Their report must compare the same
eligible decisions on the same dates before declaring portfolio impact.

Programs that become paper-active use `paper_cohort` only after a frozen
activation date and an otherwise unchanged control/baseline. If simultaneous
changes prevent isolation, the result is `invalid`, not attributed.

Purely operational paths are permanently `not_attributable`. They may report
data coverage, outage avoidance or correctness proof, but never a hypothetical
portfolio uplift.

## Implemented producer and current scope

The first scheduled producer is intentionally narrow: the predeclared US
international-allocation diagnostic compares 100% VOO buy-and-hold against an
80% VOO / 20% VXUS allocation rebalanced monthly on the first matched session
close. It reads only cached adjusted-close bars, applies a fixed one-way 5 bp
cost assumption, requires at least 756 matched sessions, rejects interior
session gaps, and reports common-window gross/net arm returns, turnover,
drawdown, and a 95% Student-t interval/t-statistic over non-overlapping 63-session
active-return blocks. It is a **synthetic fixed-allocation diagnostic**, not a
replay of Kairos paper or live holdings, and it cannot authorize a policy or
trade.

The producer is `/api/allocation/international/replay`, scheduled by the
market-specific pg_cron job `kairos-international-allocation-replay-us`
(`45 23 * * 1-5`). It persists immutable run inputs/results and writes the
paired attribution row through the append-only writer. The run's
`cron_authenticated` value proves the request passed the cron secret; the
separately queried active `cron.job` entry proves the schedule exists. Neither
claim should be confused with evidence that every scheduled invocation
succeeded.

The separate `price-cache-fill` collector owns both replay series. It refreshes
history when either the five-year start bound is short **or the latest bar is
behind the expected completed session**; checking only the oldest bar allowed
VXUS to stop at 2026-07-24 while VOO advanced to 2026-09-25. If either bar depth
or freshness remains short after a collector tick, System Health raises
`allocation-replay-history-stale` with the symbol and observed latest date. The
replay remains explicitly as-of its latest matched session, never presented as
current-to-date. Public Yahoo history is confined to this cache-only diagnostic
collector; it is not a scoring, eligibility, or execution source.

PostgREST can cap a response at 1,000 rows even when `.range()` asks for more.
Therefore each benchmark history must be fetched in bounded pages until a short
page is returned; a single wide range is not complete-history evidence. A
production run must end at the latest common cached session and the persisted
matched-session count must agree with the source cohort. The immutable ledger
may retain earlier corrected/partial measurements; consumers use the newest
`as_of_session` and creation time, and the row must disclose its actual window.

Only this diagnostic currently has a verified scheduled portfolio-level
producer. Other performance-eligible paths must remain `producer_missing` until
their own paired portfolio replay is implemented, deployed, scheduled, and
validated against production evidence. Shadow observations or symbol-level IC
are not substitutes for portfolio attribution.

## UI

Each Upgrade Path card gains an **Attribution** section:

- state pill and comparison type;
- “Since” date and baseline/variant versions;
- incremental net return, benchmark-relative incremental return, 95% interval,
  independent-session count, turnover and drawdown delta when `measured`;
- exact blocker when `collecting`;
- explicit explanation when `not_attributable` or `invalid`.

The page footer repeats that an observed incremental return is historical
evidence, not a forecast. A path cannot be called beneficial from an unpaired
P&L total or from aggregate portfolio performance after multiple releases.

## Acceptance criteria

1. Every registry entry declares its attribution class; no silent default.
2. The status API returns an attribution object for every entry.
3. UI renders the state and never substitutes a generic benefit label for a
   causal result.
4. Tests reject mixed markets, version drift, mismatched windows, gross/net
   comparisons, missing costs, and overlapping-session claims.
5. No writer or consumer may promote/enable a strategy from attribution alone.
6. Every performance-eligible path without a verified producer reports
   `producer_missing`, not `collecting` or a stale aggregate P&L estimate.
7. The international-allocation result is labeled synthetic and never
   represented as historical Kairos portfolio performance.
