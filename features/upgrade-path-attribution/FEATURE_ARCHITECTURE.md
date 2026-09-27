# Upgrade Path Causal Performance Attribution

Status: PARTIALLY IMPLEMENTED — the core attribution contract and international-allocation producer have production attribution rows. The forward shadow-book schema was applied to production as migration `20260927182158`, with RLS/RPC/append-only controls verified. Its writer/reader integration is pushed on `codex/upgrade-path-attribution-producer` and passes Vercel Preview for commit `5137f6d6`, but is not merged or collecting in production; the production snapshot table still has zero rows. As of 2026-09-27, the retired horizon-extension comparator is operational-only; of the eight remaining performance-eligible paths, seven still lack verified producers.
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

### Registry eligibility audit (2026-09-26)

`attributionClass` describes whether the program has a concrete portfolio
decision alternative **now**, not whether it could someday influence a trade.
This distinction corrected seven registry entries which had been marked
performance-eligible despite having only an IC, diagnostic, safety-parity, or
data-capture output:

| Current class | Programs | Meaning |
|---|---|---|
| `matched_replay` | exit geometry, ATR exit stop, score exit, setup experts, capital rotation, international allocation | There is a declared baseline-versus-alternative decision policy; the portfolio replay producer is still required. |
| `paper_cohort` | strategy challenger validation, downside hedge | A future activated paper cohort can be compared with a frozen control; no current producer is implied. |
| `operational_only` | listing discovery, broker tradability, score/price divergence, diagnostics, label coverage, horizon extension (retired comparator; descriptive checkpoint only), live-exit ladder parity, archetype IC, alpha diagnostics, evidence router, degradation guard, India news evidence, technical calibration, PIT fundamentals, specialist packs, earnings risk, exogenous risk, autonomous-live execution | The current output proves collection, readiness, reliability, or descriptive signal behavior, not an isolated portfolio policy. |

**Policy correction (2026-09-27):** the unconditional time stop was removed on
2026-09-10, so the horizon-extension arm's next-session-sale baseline is no
longer the incumbent exit. That program was reclassified from `matched_replay`
to `operational_only`; its historical +5/+10 outcomes remain immutable and
cannot count toward attribution or readiness. The registry now has eight
performance-eligible programs: international allocation has the only verified
producer, leaving seven with explicit `producer_missing` blockers.

Every currently eligible path other than international allocation exposes an
individual producer blocker in the registry and Upgrade Path card. Examples:
MFE/MAE labels do not preserve stop/target ordering; holding-score summaries
do not provide executable exit timestamps; rotation decision events are not a
matched future portfolio; and no challenger or hedge paper cohort is active.
These are deliberate `producer_missing` states, not collection waits. A path
cannot be relabeled `collecting` until a scheduled, versioned producer actually
writes a valid portfolio-level comparison.

Operational-only status is not a permanent ban on measuring return impact. It
means the present feature contract contains no frozen behavior-changing policy
to compare. Define and approve that policy first, then add it as a new versioned
variant instead of retroactively turning a descriptive metric into P&L proof.

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

### Shared accounting foundation (local, not a producer)

`lib/shadows/paired-portfolio-replay.ts` now provides a reusable strict replay
seam for future adapters. It checks that baseline and variant declare the same
unique point-in-time decision population; every entry event links to that
population; both arms use the same ordered market-session window, benchmark
series, marks, starting policy and cost version; gross and net arms accept the
same event set; held names have a price mark on every session; and at least two
complete non-overlapping return blocks exist before a measured row can be
formed. It produces gross/net NAV, benchmark-relative incremental return,
turnover, drawdown delta and a block-based interval/t-statistic. Mutation tests
prove the main fail-closed checks.

This is deliberately not called a producer: it does not derive any program's
baseline or challenger decisions, persist evidence, or run from a schedule.
Consequently the production state remains unchanged: one synthetic
international-allocation producer exists, actual Kairos stock-paper
attribution is absent, and the other seven performance-eligible paths remain
`producer_missing` until their policy-specific adapters and schedules are
verified. Source data currently does not preserve enough common decision,
position-lineage and daily-mark history to manufacture inception-to-date
portfolio replays for those paths.

### Forward shadow-book snapshot ledger (production schema; preview integration, not yet collecting in production)

The new `upgrade_path_shadow_book_runs` append-only table is intended to retain
daily baseline and variant book states from the same starting capital and
market session (initial positions may differ when allocation or selection is
the tested policy). The
`lib/shadows/shadow-book-ledger.ts` builder refuses mixed markets, mismatched
candidate populations, incomplete ordered session windows, missing held-name
marks, or a gross-only cost claim. It records net cumulative book/benchmark
returns, drawdown, turnover, the common-population hash and source-input hash.
Its `captured` status explicitly does **not** imply a causal or statistically
qualified result; the row carries a blocker until a program-specific paired
replay has produced its confidence statistics.

The append-only table, RLS policy, owner-scoped read grant, service-role insert,
latest-per-market RPC, and mutation trigger are live from migration
`20260927182158`. Production checks confirmed RLS enabled, one owner read
policy, one append-only update/delete trigger, anon read/execute denied, and
service-role insert/RPC execute allowed. The TypeScript builder, international
allocation writer call, API/UI integration, and per-program adapters remain
on the feature branch and Vercel Preview; production currently has no rows in this new snapshot table because the integration has not been released to production.
Therefore this is not yet data collection or a completed new producer. The
existing international-allocation attribution producer continues to write its
separate attribution ledger. The other seven missing programs still require
frozen adapters, market-local schedules, persisted pair history, and a
production/UI round trip before they can be called producers.

## UI

Each Upgrade Path card gains an **Attribution** section:

- state pill and comparison type;
- “Since” date and baseline/variant versions;
- incremental net return, benchmark-relative incremental return, 95% interval,
  independent-session count, turnover and drawdown delta when `measured`;
- exact blocker when `collecting`;
- explicit explanation when `not_attributable` or `invalid`.

The card separately displays **Collection health**, supplied by the
owner-only `/api/admin/shadow-liveness` read model. It reports market-local
evidence freshness, the active schedule and latest recorded cron status. For
shared label-maturation rows it marks the evidence as shared rather than
claiming independent US/India freshness. Event-driven evidence with no
qualifying input is `waiting_for_input`; an old event row alone is not proof of
current health. Collection status never upgrades attribution state.

The health read model uses the service-only `get_shadow_cron_health()` RPC
(`20260926191851_shadow_cron_run_health`) to distinguish an active schedule
from a schedule whose latest invocation failed or has gone stale. The RPC
returns only job name, schedule, active flag and latest start/status; it is not
granted to `anon` or `authenticated`.

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
