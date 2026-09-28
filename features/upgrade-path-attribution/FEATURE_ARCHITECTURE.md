# Upgrade Path Causal Performance Attribution

Status: PARTIALLY IMPLEMENTED — the attribution ledger has three production rows, all for the synthetic international-allocation diagnostic; actual Kairos stock-paper attribution is absent. The forward shadow-book schema was applied to production as migration `20260927182158`, with RLS/RPC/append-only controls verified. Its writer/reader integration is merged to `main` at `afc7c282` and the Vercel production deployment is `READY`; production still has zero shadow-book rows because the next market-local replay is scheduled for Monday 2026-09-28 at 23:45 UTC. On 2026-09-27, production `execute_paper_fill` was patched by migration `20260927212654` to preserve its exact passed stop/target on entry lots; a transactional source-rewrite test was rolled back, then the migration was applied and `pg_get_functiondef` verified. This repairs a necessary input for future replay, not a portfolio producer. The retired horizon-extension comparator is operational-only; of the eight remaining performance-eligible paths, seven still lack verified producers.
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

**Collector-health instrumentation (local, not P&L producers):** the scheduled
ATR exit-stop and holding-score-exit routes now write an invocation record to
`upgrade_path_producer_runs` when called in persist mode. Each record is
market-local and code-versioned, distinguishes owner/manual from authenticated
cron, records blocked/error outcomes, and labels its evidence as matured
decision-label metrics. Its `performanceAttribution` detail is explicitly
`not_produced_by_this_collector`; these records prove only that a collection
attempt ran and whether it wrote its decision-level metric rows. They do not
change either program's `producer_missing` attribution state, and a collector
wall-clock `asOfDate` is not represented as an observed market session.
The read model obtains one latest invocation per program through the
service-only `get_upgrade_path_producer_runs_latest(market)` function, rather
than a fixed recent-row limit that could eventually hide a low-frequency
program behind busier schedules. The UI shows the evidence type, row count,
persisted flag, and result-state distribution so a completed-but-insufficient
label analysis cannot look like a portfolio result.

**False-green guard (local, not deployed):** collector normalization no longer
calls every HTTP-200 response with nonempty results “collected.” Explicit
`success:false`/`ok:false`, and result states `stale`, `invalid`, `blocked`, or
`error`, are recorded as blocked/errored; legitimate evidence states such as
`insufficient` remain collected because they describe sample maturity rather
than a failed fetch. Focused regression tests cover these cases. The producer
run migration must be deployed with the code before these records can appear in
production. A production read on 2026-09-27 confirmed that the existing ATR,
Alpha Diagnostic Lab, and archetype-IC schedules are active and their latest
scheduled invocations succeeded. It also confirmed that
`upgrade_path_producer_runs` is absent in production, so the new local health
ledger is not collecting there. Latest ATR rows remain decision-level label
statistics (US 4.40 and India 5.40 effective observations at h10), not
portfolio attribution.

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

The Upgrade Path header reports portfolio-attribution counts separately from
operational lifecycle counts: performance-eligible, measured, collecting,
producer-missing and invalid, plus the number of operational-only programs.
“Review ready” is an operational evidence gate and must never be interpreted as
a measured portfolio benefit.

### Shared accounting foundation (local, not a producer)

`lib/shadows/paired-portfolio-replay.ts` now provides a reusable strict replay
seam for future adapters. It checks that baseline and variant declare the same
unique point-in-time decision population; every entry event links to that
population; both arms use the same ordered market-session window, benchmark
series, marks, starting policy and cost version; gross and net arms accept the
same event set; held names have a price mark on every session; and at least two
complete non-overlapping return blocks exist before a measured row can be
formed. Its supplied session list is independently checked against the
market-local regular-session calendar, including both endpoints; a caller
cannot omit a holiday-adjacent trading date while making its marks appear
internally complete. Unsupported calendar years fail closed. It produces gross/net NAV, benchmark-relative incremental return,
turnover, drawdown delta and a block-based interval/t-statistic. Mutation tests
prove the main fail-closed checks, including a calendar-gap mutation.

This is deliberately not called a producer: it does not derive any program's
baseline or challenger decisions, persist evidence, or run from a schedule.
Consequently the production state remains unchanged: one synthetic
international-allocation producer exists, actual Kairos stock-paper
attribution is absent, and the other seven performance-eligible paths remain
`producer_missing` until their policy-specific adapters and schedules are
verified. Source data currently does not preserve enough common decision,
position-lineage and daily-mark history to manufacture inception-to-date
portfolio replays for those paths.

**Local ATR-stop replay core (2026-09-27; not a producer):** a pure daily step
for the predeclared 2.8× decision-time ATR stop now uses the production paper
ladder, US completed-session OHLC versus India's current close-only exit checks,
and the existing close/stop fill rule. Its complete stop/target/high-water state
can round-trip through the existing JSONB shadow-book state. The snapshot
builder can also create a one-session, identical-book seed row, explicitly
blocked as having no post-seed return interval. These pieces do not read source
trades, run on a schedule, persist a replay, or write an attribution row. The
first production ATR entry still requires post-migration lots with exact stored
stop/target and linked point-in-time ATR; until then, this remains an unshipped
adapter foundation and the Upgrade Path state must remain `producer_missing`.
The session core mirrors the deployed paper RPC's symbol pyramiding contract
(weighted-average cost/quantity update without resetting original risk levels),
covered by a focused test. The core also requires the caller to certify raw OHLC
for barrier checks: current Yahoo paths can persist raw open/high/low with an
adjusted close, and production `corporate_actions` is empty, so neither may be
silently treated as a replay-ready executable series.

**Replay-source/accounting hardening (2026-09-27; still local-only):**
`fetchYahooRawReplaySeries()` now requests Yahoo chart v8 raw OHLC and split /
dividend events together, validates OHLC consistency and monotonic sessions,
and returns an explicit `raw_ohlc` source contract. It does not assert Yahoo's
corporate-action feed is complete or authoritative; a producer must reconcile
events with the persisted action source and refuse mismatches or missing
coverage. The ATR stepper now adjusts held quantities, basis, stops, targets,
and high-water prices for splits, and credits gross dividend cash. Dividend
tax/withholding is not modeled, so these returns cannot be described as fully
after-tax P&L. Mutation tests cover raw-vs-adjusted bars, event parsing, split
unit changes, gross dividend credit, malformed session actions, and explicit
same-session entry/sale ordering. Non-mechanical sells are applied after buys
so a fill is not exposed to pre-entry intraday extrema; unmatched sale quantity
is returned as a reconciliation diagnostic rather than silently discarded.
There is still no route, schedule, daily snapshot, paired attribution row, or
deployed verification: the Upgrade Path card must continue to say
`producer_missing`.

**External fill cost correction (2026-09-27; local-only):** Actual non-mechanical
paper exit prices in `paper_trades.exit_price` already include the app's modeled
sell slippage (`computeExitFillPrice()`; rotation RPC also applies 5 bps before
recording the fill). The ATR replay was charging its 5-bps sell cost again on
those source-ledger exits. It now treats recorded external fills as all-in
execution prices and charges replay sell costs only on replay-priced mechanical
and score exits. Regression tests assert the proceeds and zero additional cost
for actual recorded fills. This repairs replay arithmetic; it still does not
provide market data, persistence, schedules, or measured attribution.

**A0 canonical-session correction and monitor read retry (2026-09-27; local-only):**
The Alpha Diagnostic Lab now compares only canonical EOD rows with the expected
market-session calendar. Intraday operational snapshots on holidays are not
counted as missing trading sessions; an expected exchange session without an
EOD row still fails A0. The production US evidence is therefore split honestly:
the 2026-09-07 intraday row is a holiday artifact, while 2026-09-11 is a real
missing EOD record and remains a data-truth failure. No backfill is fabricated.
PositionMonitor now retries its idempotent paper-position and portfolio reads
twice on transient Supabase errors; exhaustion still aborts before position
actions. The diagnostic tests and typecheck pass locally. Neither change is
deployed, and neither provides any of the seven missing portfolio-attribution
producers.

The Upgrade Path summary separately counts the synthetic fixed-allocation
diagnostic so “measured” cannot be misread as “measured on Kairos paper/live
holdings.” This UI clarification does not change the row's comparison or make
it evidence for the actual Kairos book.

**ATR baseline/challenger accounting adapter (2026-09-27; local-only):**
`runAtrStopPairedPortfolioReplay()` now adapts the daily ATR-stop stepper into
the shared strict portfolio replay. It independently re-runs baseline and
challenger from the exact same initial book and requires identical ordered
sessions, daily bars, actions, candidate entries, external fills, cost model,
and same-window benchmark marks. Source events are converted to simulator fills
without recharging slippage already embedded in recorded paper fills. Any
unmatched sale, unsupported corporate action, missing candidate, cross-arm
input mismatch, or incomplete market session window refuses the measurement.
Focused adapter tests and full suite pass. This is an accounting seam only: no
production loader, route, schedule, durable paired input archive, attribution
writer call, or production verification exists yet; the path must remain
`producer_missing`.

**Scheduled collector audit (2026-09-27; local-only):** The registry named two
ATR-stop jobs and the route required cron authentication, but no migration
actually created the `kairos-exit-stop-shadow-us/india` schedules. Added
`20260928101500_schedule_exit_stop_shadow.sql` with distinct post-close UTC
slots; India runs Tuesday-Saturday UTC to collect the prior India-local
weekday. ATR-stop and score-exit producer records now report the latest source
observation session separately from the UTC invocation date. The schedule
migration has not been applied, and schedule/runtime execution remains
unverified. This repairs a collection-liveness gap only; there is still no
paired portfolio-P&L producer for ATR stop.

A repository-wide check of the 36 unique schedule names currently declared in
the Upgrade Path registry found four more missing scheduler declarations:
the weekly US/India Alpha Diagnostic Lab and archetype-IC jobs. The routes and
evidence ledgers already existed, but a displayed schedule name did not create
a cron. Migration `20260928104500_schedule_upgrade_path_diagnostics.sql` now
declares the four Sunday UTC jobs with distinct market parameters and bounded
timeouts. Tests tie these job names, endpoints, and UTC times to the registry.
This migration is also unapplied; deployed execution is unverified. The two
diagnostic families are liveness/evidence collectors, not matched portfolio
P&L producers.

**Entry-risk provenance repair (2026-09-27):** the live `execute_paper_fill`
RPC already received the exact per-fill `p_stop_loss` and `p_price_target`, and
used them for the new `paper_positions` row, but omitted them from the
originating `paper_trades` row. Before repair, only 24/104 US and 38/143 India
alpha buy lots had both levels; among entries on/after 2026-08-27, only 16/28
US and 28/35 India lots did. Migration
`20260927212654_capture_entry_risk_levels_for_attribution` uses exact-fragment
guards to patch the deployed RPC without replacing its safety logic. It records
the original levels on future entry lots only; it does not backfill historical
NULLs or change trading behavior. A current-policy portfolio replay still needs
chronological mark/stop history, partial-lot lineage reconciliation,
market-local adjusted OHLC, and exact alternative policy adapters.

### Forward shadow-book snapshot ledger (production schema and deployed writer; first scheduled collection is pending)

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
allocation writer call, and API/UI integration were merged at `afc7c282` and
deployed `READY` to Vercel production on 2026-09-27. At the Sunday verification
there were still zero rows: the active market-local international-allocation
replay is scheduled weekdays at 23:45 UTC, so the first post-release invocation
is due Monday 2026-09-28 at 23:45 UTC. Until that invocation succeeds and the
row is verified, report the snapshot producer as deployed/scheduled but not
yet collecting. The existing international-allocation attribution producer
continues to write its separate attribution ledger. The other seven missing
programs still require frozen adapters, market-local schedules, persisted pair
history, and a production/UI round trip before they can be called producers.

### US ATR forward paired shadow book (2026-09-28; collector built, first snapshots pending)

`POST /api/agents/atr-stop-forward?market=us` (`lib/shadows/atr-forward-run.ts`) closes the collector gap for the ATR-stop path, US only. It is the first Upgrade Path program with a scheduled, market-local forward producer over the real paper book; it does **not** yet produce an attribution row or a measured result.

- **Estimand.** Identical baseline and variant books start from the reconciled US paper book at one completed session. Both arms then receive the same ordered sessions, raw OHLC, validated corporate actions, actual paper-lot entries and actual non-mechanical sales, cost model and benchmark marks. The only difference is the initial stop of an entry made after the seed that has a decision-time ATR: 2.8x ATR versus the recorded baseline stop. Seeded legacy holdings are identical in both arms and cannot differ; an entry with no decision-time ATR is held identically on the baseline stop and reported, so the measured effect is "ATR stop where decision-time ATR exists".
- **Sources.** Bars: Yahoo chart v8 raw OHLC (never adjusted close). Benchmark: VOO raw close, same session. Corporate actions: Yahoo events must agree with the persisted ledger and a fresh complete coverage row (fed by `/api/agents/corporate-action-coverage` from Massive splits/dividends, validated by the shared assessor). Entries/sales: `paper_trades` lot ledger via `paperLotReplayEvents`, with the decision-time ATR joined through `signal_id` to `decision_observations.features.technical.atr14`. Mechanical stop/target sales are simulated, not copied.
- **Fail-closed.** A missing bar, benchmark close, coverage row, ledger disagreement, unreconciled seed, unmatched sale or non-resumable history writes no snapshot and records a `blocked` producer run. Loader/database errors are errors, not evidence. Already-written sessions are kept; the next run resumes (at most five sessions per run).
- **Persistence.** One append-only `upgrade_path_shadow_book_runs` row per session; the per-session mark (prices, benchmark close), the cumulative matched decision population and cumulative turnover are stored inside the row so history rebuilds exactly from persisted evidence. The first row is a seed anchor and is marked seed-only.
- **Not done.** No attribution row: that needs at least two complete non-overlapping ten-session blocks plus the paired confidence computation, roughly a month of sessions away, and only entries after the 2026-09-27 entry-risk provenance repair can differ between arms, so the first measurable window may be thin. Dividend tax/withholding is not modeled. India is refused: no corporate-action source covers NSE names. The other six performance-eligible programs are unchanged.

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
