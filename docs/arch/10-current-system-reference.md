# Kairos current system reference

> Last reviewed: 2026-10-24
>
> This is the friend-facing, current-state guide. It describes what the code and
> production contracts do today. A feature marked **shadow**, **collecting**, or
> **blocked** is not a live trading policy. Historical feature architecture files
> remain design records; this chapter is the status authority for the present.

## 1. What Kairos is

Kairos is a personal research and paper-trading system for US equities/ETFs,
Indian equities/ETFs, and an isolated crypto paper sleeve. It runs deterministic
data collection and scoring, records immutable decision evidence, simulates fills,
monitors positions, compares portfolios with market-local benchmarks, and measures
whether proposed improvements have evidence. LLMs may summarize evidence or help
with research prose; they do not choose an unbounded symbol, score, stop, target,
or order by themselves.

There are three separate investing books:

| Book | Currency | Current execution state |
|---|---|---|
| US | USD | Paper trading active; live trading remains owner-gated/off |
| India | INR | Paper trading active; Zerodha/Kite live path remains owner-gated |
| Crypto | USD | Isolated paper pool and native research lane; live crypto disabled |

Paper books never share NAV, cash, positions, benchmarks, or learning cohorts.
"Active" describes the configured engine, not an unconditional permission to
buy: market-local health and accuracy/drawdown brakes may halt new exposure.

### Free-tier resource budget and truthful recovery

The owner requires Supabase to stay on Free. Council collection uses two lanes
and fifteen-minute scheduled sweeps; full evidence packets load only for selected
unscored candidates. Home-page signal/run responses exclude unused research
payloads. Repeated identical health findings stay visible without rewriting the
same alert every tick. Cleanup reports partial database failures rather than
pretending storage was reclaimed. No financial/research history is removed by
these optimizations, and retained data can still exceed the Free storage quota.

Provider symbol spelling is separate from app identity: Yahoo candle requests
translate US share classes such as BRK.B to BRK-B, but positions and evidence
keep BRK.B. Benchmark collection targets at least the expected completed market
session even if portfolio EOD failed; a current benchmark cannot replace a
missing, reconciled portfolio snapshot. Recovery does not fabricate past NAV.

### Leveraged funds: a separate intraday paper policy

SOXL/SOXS and TQQQ/SQQQ are opposing daily-reset exposure pairs. Their paper
workflow uses the same five-minute ETF/proxy setup rules, not company earnings
or a ten-session LLM score as an intraday forecast. The existing four-symbol
research pass runs at 09:00 New York time. During regular sessions, the dedicated
paper routes check on a five-minute cadence. New entries are considered after
09:45 and before the final thirty minutes; an opening-range breakout needs a
subsequent completed bar, so the first window does not guarantee an entry.

The setup checks completed five-minute bars, direction-signed SOXX/QQQ proxy
confirmation, session VWAP and volume compared with prior windows at the same
time of day. IEX is one venue, not consolidated market data. Missing or stale
data blocks entry and appears in System Health. Stops combine intraday price
invalidation and volatility; targets cover at least twice the full planned
initial risk. Cash, the combined 5% sleeve ceiling, 0.5% minimum entry and maximum
stop distance remain binding. Both sides of an exact opposing pair cannot be
held simultaneously. The database rechecks exposure under a portfolio lock.

New policy-v3 lots attempt a full exit before the close; a failed attempt retries
at the next regular-session observation. Old positions retain their recorded
policy. Periodic paper observations cannot guarantee a stop fill between checks
or protection through an overnight gap. The live leveraged path remains disabled
and is not represented as having the paper intraday policy or proven broker
protection. Council opinions remain ten-session shadows: new packets omit app
permissions and carry a new method identity, with separate evaluation series.
These rules are operational priors, not demonstrated profitable alpha.

The four planners share upward-rounded full-risk targets. Intraday-v3 paper
lots trail by their recorded entry-risk fraction even below 1%; ordinary stocks,
legacy leveraged lots and dormant live execution keep their previous defaults.
Setup evidence names each failed condition (ETF opening range, ETF VWAP,
directional proxy, or same-time volume) rather than a generic confirmation label.
The 2R entry target applies to the shares sold there, not guaranteed whole-lot
profit: selling half at 2R and the rest at entry produces 1R before costs.
For SOXL's semiconductor cap, recognized funds lacking sector data receive a
conservative full-notional exposure bound (3x for the four approved leveraged
funds), never a guessed zero or an inverse offset. Unknown companies and
unsupported leveraged exposures still block. The fill records this accounting
version and bounded symbols; it is not measured constituent look-through.

## 2. Runtime and ownership

The application is Next.js App Router with Supabase Postgres/Auth/pg_cron. Server
routes use the server or service Supabase client; owner-only routes use the confirmed
owner gate. Cron invokes deployed routes through the Vault-backed
`kairos_call_agent` bridge. Local Windows schedules are not the production source
of truth.

The main workspaces are Investing (`/dashboard`), Property (`/property`), and
Capital (`/capital-plan`). The System Reference page exposes an owner-only,
fixed allowlist of Markdown documents. It is not a repository browser.

## 3. Research pipeline

### 3.1 Universe and discovery

Research is bounded. The app combines the configured watchlist, holdings, screener
admissions, discovery buckets, ETFs, metals and market-specific research queues.
Discovery creates evidence and candidate membership; it does not itself authorize
a trade. Broker tradability checks are separate and must be satisfied before a
money-path order.

The US discovery lane is bounded and rotates liquid candidates. India uses its
market-local universe and exchange symbols. A candidate can be refused for stale
data, unsupported instrument type, missing evidence, liquidity, broker availability,
or insufficient history. Refusals are recorded rather than silently disappearing.

### 3.2 Evidence collection

Provider calls are cached and quota-accounted. Alpha Vantage has atomic daily
reservation/capacity controls; raw bypasses are not allowed. Price bars are stored
in `price_cache` with provider, basis and provenance metadata. Post-close price
prewarm runs before PositionMonitor so stop/target evaluation does not rely on the
previous session. Evidence shadows exercise the router without changing live score
inputs.

US research includes fundamentals, technicals, sentiment, macro and insider inputs
where applicable. India uses market-local fundamental, technical and sentiment
inputs; US macro is not stamped onto India. ETFs and other instruments have explicit
applicability rules instead of fabricated company fundamentals.

### 3.3 Deterministic score

The equity score is a weighted composite with an availability mask. Unavailable
dimensions are excluded according to the shared scorer contract; invalid weights,
invalid scores and excluded placeholders fail closed. A high score is a candidate
signal, not proof of predictive edge. Current IC/t-stat measurements remain
diagnostic because qualifying sessions, mature labels, cohort integrity and
overlap-adjusted effective sample size are still insufficient for promotion.

## 4. Paper trading lifecycle

1. Research writes a session-validated signal.
2. PaperTrader claims eligible signals and checks market controls, kill switches,
   cash, mandate threshold, open-name/sector limits, duplicate/pyramid rules,
   broker-compatible symbol policy and fresh pricing.
3. A transactional fill RPC writes the paper event, trade lot, position and cash
   movement atomically.
4. PositionMonitor refreshes completed-session marks and current evidence. It
   updates highest price and applies the shared exit ladder.
5. A target touch can be detected from the settled bar high even if the close
   recovered. Stop precedence remains conservative when both barriers occur.
6. Target handling may sell a partial lot and move the runner protection to
   breakeven. Trailing protection ratchets upward and never loosens.
7. A score/direction invalidation, stop, target/trail or safety action can close a
   position. The old unconditional clock time-stop is not the intended current
   policy; no-clock behavior must still be validated against each market route.
8. Closed lots feed learning and diagnostics only after taint, source, session and
   label checks.

The Paper Portfolio position cards also show a read-only price path and a
separate execution-step chart. The price path reads `paper_position_marks` by
current open position ID and market, and displays percent change from the first
recorded mark (not the actual initial fill). The execution chart reconstructs
buy/add and sold-share steps from `paper_trades` within the current position
epoch and shows the exact fill price and traded notional on each event. It
reconciles its ending share count to the open position and refuses to draw when
the position epoch, partial-exit lineage, or exact quantity is ambiguous. The
step line is shares held, not dollar market value or P&L; the price path and the
activity path intentionally remain separate so buys/sells are not confused with
price movement. Daily marks are stale/provenance-labelled. Neither line claims
split-adjusted total return or intraday price history.

The historical sizing replay is an offline diagnostic. It compares fixed equal
allocation with stop-risk allocation under finite cash, caps, costs, partial exits
and supplied marks. It does not alter production sizing or claim a globally optimal
percentage. A separate top-up experiment is not yet approved for production.

## 5. Exit geometry and sizing status

Current production exits preserve the actual entry/position geometry and provenance
where available. The recent intraday-high repair prevents a target touch from being
lost merely because the closing price fell back below target. This is an execution
correctness fix, not evidence that the target formula is optimal.

The sizing replay engine and fingerprinted CLI are implemented and tested. A
read-only production recheck on 2026-10-07 found 115 US / 153 India original buy
lots, strict pre-fill risk-plan matches for 92 US / 127 India, and at least one
matching price bar for 92 US / 86 India. Those are not complete replay tapes:
27 US lots are tainted or learning-excluded, and daily position marks cover only
35 US / 36 India distinct sessions with stale rows. The replay still cannot
support “best sizing” or historical portfolio uplift. No entry stop is inferred
from today's stop, no absent market bar is fabricated, and no live sizing policy
changes. A separate top-up counterfactual is not yet implemented. See
`features/portfolio-sizing-replay/DATA_READINESS.md`.

Paper allocation currently has a soft 5% cash objective (never a forced-buy rule),
a paper-only 100% gross ceiling, and an eight-name limit. A 60% sector / 20%
per-name paper ceiling amendment is owner-approved and deployed to production
(PR #56, merge commit `3da0090d85ad6744bf70398ae8e45c3ba734b08f`). Live
portfolio gates continue to use shared 80% gross / 30% sector / 12% per-name
limits. The higher paper ceilings only create room for qualified
buys/top-ups; they do not override daily volatility, correlation, signal,
stop/target, cash, daily-order, or rotation-readiness checks and do not guarantee
cash below 5%.
When qualified executable half-Kelly evidence is absent, PaperTrader falls back
to the configured flat size (10% by default); when evidence is present, half-Kelly
is capped by the owner-set size and the constructor may only reduce it further.
The deployed top-up path can add to a held symbol only after a fresh eligible
signal, at a fill price above current weighted average cost, at most once per
symbol/session, and subject to the same cash, daily, name, sector, volatility,
correlation and gross limits. This policy is implemented; its historical
return/drawdown superiority is not established until the replay's missing
lineage and mark evidence are resolved.

Do not interpret broad-symbol screening as independent portfolio breadth: only
market-local, point-in-time eligible, liquid candidates that survive the same
entry, capacity, correlation, and cost gates can become comparable bets. The
cross-sectional-rank feature remains off by default. Expanding its universe or
changing position sizing requires a frozen point-in-time universe and paired,
after-cost out-of-sample portfolio replay; neither the card chart nor a raw symbol
count is evidence to change buy policy.

## 6. Benchmarks and performance truth

US and India live pages now use the paper chart's market-local benchmark choices
and exact-session arithmetic, but read only recorded live account equity. They
hold account membership fixed, mark missing observations as gaps and state real
coverage/staleness. No paper proxy or backcast from current holdings fills missing
live history. Deposits, withdrawals and transfers are not recorded sufficiently
to compute investment return: the live line is explicitly unadjusted account-
value change and no live outperformance badge is shown. Cash-flow-adjusted live
performance requires a separate verified cash-flow/valuation contract.

Benchmarks are market-local and session-labelled. US and India collectors run at
their own post-close times with bounded retries. A run is complete only when every
enabled benchmark reaches that market's expected session; otherwise it is partial
or error with provider/session/retry detail. Freshness alerts resolve only after all
configured benchmarks advance.

Portfolio-vs-benchmark charts are presentation outputs of these canonical rows,
not independent fetches. A stale chart is a data-contract failure, not a reason to
silently reuse yesterday's benchmark.

The performance-series contract uses only untainted end-of-day paper NAV snapshots,
deduplicates each session to its latest canonical snapshot, and paginates the full
history rather than silently stopping at a fixed row limit. Benchmark observations
must match the configured benchmark component. When benchmark history starts later
than portfolio history, the relative-return headline and plotted comparison use the
same exact overlapping sessions; the portfolio's full-window return is shown
separately so the two periods cannot be mistaken for a like-for-like comparison.
Missing benchmark sessions remain gaps rather than being visually bridged.

Capital rotation's two paper books have their shadow and paper-execution config
flags enabled, but `rotation_allow_score_only_paper` is false and no live proposal
path is enabled. On 2026-10-07 both market-local producers wrote rotation decisions
and neither executed. The current score-to-return gate remains insufficient:
US h10 has 5 independent blocks, mean edge -0.77%, t -0.45; India has 5 blocks,
mean edge -2.00%, t -1.19. A code defect found the same day dropped the
constructor-sized quantity from `replacementCapacity()`, falsely logging US
replacements as infeasible; the local fix now returns exact quantity and notional
and is covered by an evaluator integration test. Production events predate that
code fix, and the return/persistence/turnover/economic gates remain. No rotation
execution flag is being opened to bypass them. See
`features/capital-rotation/FEATURE_ARCHITECTURE.md`.

The broad-universe evidence also has distinct layers. Current ResearchAgent
`universe_snapshots` are still bounded mixed-source candidate lists (production
maximum in the recent 14-day window: 105 US / 23 India). `edge_universe_members`
contains a separate US point-in-time top-400 ADV20 sample, but only 10 persisted
as-of dates from 2024-12-13 through 2026-07-21; the equivalent India PIT
membership source is unavailable. The pure OOS orchestrator exists without a
route or schedule invoking it in this checkout. Thus broad PIT factor research is
not a continuously collected daily research shortlist and does not feed buys.
Neither the static candidates nor the factor snapshots prove a full Robinhood
universe or broker tradability.

Upgrade Path attribution is append-only and requires a matched baseline and variant,
common window/population, frozen versions/hashes, costs, benchmark, independent
sessions and exact arithmetic. Existing production attribution rows are synthetic
international-allocation diagnostics, not Kairos paper-book P&L. The ATR
paired-book producer is deployed and validates complete immutable snapshots;
it can emit only net-of-cost evidence after two non-overlapping ten-session
blocks. On October 23, production has 20 ATR snapshots through October 22,
covering one completed ten-session block, and no ATR attribution row. Twenty
snapshots include the initial state and are not twenty return intervals. The
latest persisted producer invocation collected successfully. The additive migration is applied.
Other paths remain producer-missing unless explicitly proven otherwise.
“Collecting” and “review-ready” do not mean “proven improvement.”

## 7. Learning, strategies and shadows

LearnerAgent summarizes closed outcomes and generates bounded challengers. Validation
uses purged/out-of-sample evidence and does not automatically mutate weights merely
because a small sample looks good. Capital rotation, external strategies, sector
signals, risk tiers, catalyst scoring, exit alternatives and model comparisons are
primarily measure-only shadows until their declared gates pass.

The app must report, per shadow: population, dates, version, number of qualifying
sessions, label maturity, overlap-adjusted effective sample size, IC/t-stat or
operational result, benchmark comparison, blockers and next safe action. It must
never create a winner row from aggregate portfolio P&L or hindsight-selected names.

Upgrade Path separates collection health, statistical analysis and portfolio
benefit. Its first screen prioritizes failed evidence pipelines, missing outcome
comparisons, then result reviews, with recorded owners and review dates. A
missing paired-book producer is an implementation task, not an experiment that
will become ready merely by waiting. Intentionally inactive scaffolds and
market-inapplicable programs are excluded from active/performance denominators.
Council, formula-variant, insider and India event cards read their existing
market-local evaluator batches and link to the full Learning tables; an old or
failed evaluation is not a fresh result. Descriptive IC is not portfolio P&L.

Label coverage is a server-only database aggregate across horizons, so growing
past a client row limit cannot turn available evidence into a false zero. The
separate h10 geometry reader remains bounded and fails explicitly. Repeated
observations on a date remain an inference warning; they do not cause collection
to fail merely because more symbols were researched. Statistical gates remain
unchanged. Daily and weekly jobs use their own freshness bounds.
Label watermark/h10 indexes and parameter-bound aggregate planning keep this
read model separate from raw full-history downloads. Collection-health probes
are bounded to four concurrent reads, and failed evidence reads hide numerical
progress instead of manufacturing zero coverage.

## 8. Crypto lane

Crypto research is native and separate from equity scoring. Public Coinbase/Kraken
candles and quotes supply research; Robinhood MCP supplies broker capability and
execution truth. The approved paper basket is BTC-USD, ETH-USD and SOL-USD, with
bounded broker-discovered candidates recorded separately.

Crypto paper entry requires completed data, a native score, fresh two-sided public
quote, valid geometry, cash, market controls, a claimed native signal and no open
duplicate position. The crypto fill RPC has a separate mandate branch and does not
reuse an equity mandate. Crypto live execution remains disabled pending broker
preview, protective-order and reconciliation evidence.

## 9. Live trading safety

Live switches remain off unless explicitly enabled by the owner. Live execution must
verify broker account/pair eligibility, fresh executable quote, preview acceptance,
idempotency, risk and kill-switch state, and protective-order reconciliation. A
signed-in viewer cannot invoke owner money-path routes. Paper and live execution
records are tagged and never silently merged.

## 10. System health and operations

System Health distinguishes failures from informational notices and owner actions.
Critical failures include stale/missing market data, quota violations, broker token
failure, failed persistence, or an unsafe live position. A healthy collector may
still produce refusals; refusals are evidence, not necessarily incidents.

When investigating a problem, verify in this order: expected session, provider
provenance, persisted row, route response, cron run, then UI. Never infer that a
successful build or rendered card means the money path worked.

## 11. Status vocabulary

| Status | Meaning |
|---|---|
| Shipped/active | Code and required production contract are present and verified |
| Paper-only | Can affect isolated simulated books, never broker orders |
| Shadow/measure-only | Collects evidence; cannot affect score, sizing or trades |
| Collecting | Infrastructure is live but the minimum evidence gate is not met |
| Blocked | A named data, provenance, owner or broker prerequisite is missing |
| Proposed | Architecture only; no implementation should be inferred |

## 12. How to read the rest of the repository

Local cache recovery tooling (`scripts/provider-cache-archive.mjs`) can export
superseded provider-cache slots older than 45 days, verify checksums and perform
an isolated local PostgreSQL restoration. It cannot delete or restore production
rows. The October 24 production exports failed; partial files are not backups.
Pruning remains blocked until a complete archive passes its restore drill and
an atomic conditional SQL path is available. Trading/research history is excluded.
See `features/provider-cache-archive/FEATURE_ARCHITECTURE.md` for the recovery gates.

Use `docs/arch/` for stable operational chapters, `features/*/FEATURE_ARCHITECTURE.md`
for individual designs, `WORK_LOG.md` for delivery evidence, `PROJECT_DECISIONS.md`
for owner approvals, and `public/agent-diagrams/system-map.json` for topology.
If an old feature document says “planned” while this chapter says “shipped,” the
implementation result and current code win; update the stale feature document in the
next documentation pass rather than treating its proposal as runtime behavior.
