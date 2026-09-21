# Kairos current system reference

> Last reviewed: 2026-09-21
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

The historical sizing replay is an offline diagnostic. It compares fixed equal
allocation with stop-risk allocation under finite cash, caps, costs, partial exits
and supplied marks. It does not alter production sizing or claim a globally optimal
percentage. A separate top-up experiment is not yet approved for production.

## 5. Exit geometry and sizing status

Current production exits preserve the actual entry/position geometry and provenance
where available. The recent intraday-high repair prevents a target touch from being
lost merely because the closing price fell back below target. This is an execution
correctness fix, not evidence that the target formula is optimal.

The sizing replay engine and fingerprinted CLI are implemented and tested. Historical
coverage is incomplete: the canonical cache has broad history, but 20 India symbol
roots have no matching price history, and partial-lot lineage/entry-stop provenance
still require reconciliation. See `features/portfolio-sizing-replay/` and its
read-only coverage queries.

## 6. Benchmarks and performance truth

Benchmarks are market-local and session-labelled. US and India collectors run at
their own post-close times with bounded retries. A run is complete only when every
enabled benchmark reaches that market's expected session; otherwise it is partial
or error with provider/session/retry detail. Freshness alerts resolve only after all
configured benchmarks advance.

Portfolio-vs-benchmark charts are presentation outputs of these canonical rows,
not independent fetches. A stale chart is a data-contract failure, not a reason to
silently reuse yesterday's benchmark.

Upgrade Path attribution is append-only and requires a matched baseline and variant,
common window/population, frozen versions/hashes, costs, benchmark, independent
sessions and exact arithmetic. The ledger currently has no valid measured rows for
many paths. “Collecting” and “review-ready” do not mean “proven improvement.”

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

Use `docs/arch/` for stable operational chapters, `features/*/FEATURE_ARCHITECTURE.md`
for individual designs, `WORK_LOG.md` for delivery evidence, `PROJECT_DECISIONS.md`
for owner approvals, and `public/agent-diagrams/system-map.json` for topology.
If an old feature document says “planned” while this chapter says “shipped,” the
implementation result and current code win; update the stale feature document in the
next documentation pass rather than treating its proposal as runtime behavior.
