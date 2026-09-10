# Broker-Compatible Broad US Research Universe

> Status: **PROPOSED — architecture only.** No schema, ingestion, schedule, score,
> eligibility, paper, or live-order behavior changes are authorized by this document.
> Last revised: 2026-09-09.
> Money-path influence: **none**. A broker preflight immediately before an order
> remains the only broker-tradability authority.

## 0. Decision summary

Kairos should stop treating its curated candidate queue as if it were a market
universe. It should maintain a broad, versioned US **measurement universe** that
is independently sourced, point-in-time reproducible, liquid, classified, and
separate from the small daily deep-research queue.

It must *not* attempt to make an LLM research every security Robinhood currently
offers each day. Robinhood says it offers over 11,200 securities, including stocks,
ETFs, CEFs, ADRs and certain OTC equities. That number includes heterogeneous
instruments and may change due to corporate actions, halts, account restrictions,
or broker policy; it is neither a stable historical universe nor a sector taxonomy.

The proposed result has three deliberately separate populations:

| Population | Purpose | Can affect money? |
|---|---|---|
| `us_instrument_catalog` | Current observed exchange/broker instrument identities and metadata | No |
| `us_measurement_universe` | Broad, liquid, point-in-time common-stock cohort used for deterministic data and factor/sector measurement | No initially |
| `daily_research_shortlist` | Bounded names selected from the measurement universe for expensive news/LLM research and existing scoring | Existing gates only; this architecture adds no authority |

This fixes the present evidence problem without implying that all Robinhood
instruments are suitable for research or trading.

**Measured in production 2026-09-09** (correcting an earlier draft of this section,
which claimed "117 canonical sector labels" — that figure was wrong by roughly 4x
and pointed at the wrong problem):

| Fact | Value |
|---|---|
| Distinct US symbols ever in `decision_observations` | 167 |
| Distinct US symbols ever in `decision_observations` (India) | 161 |
| Distinct sector labels across those 167 US symbols | **30** |
| Distinct sector labels in `symbol_profiles` overall | 37 |
| Observed US symbols with **no** sector at all | **50 of 167 (30%)** |

The binding constraint is therefore **classification coverage, not taxonomy
fragmentation**. Thirty labels across 167 names is a coarse taxonomy, not a
117-way mess; the actual hole is that nearly a third of the names the system has
made decisions about carry no sector at all. Stage 0 must price that finding
first: a 30% null rate may be a Finnhub coverage gap on specific instrument types
(ETFs, ADRs) rather than a reason to license a full security master. Do not use
this section to justify vendor spend until Stage 0 says which it is.

### Feature-lifecycle record

- **Why:** Sector and cross-sectional diagnostics are currently dominated by a
  small, technology-heavy candidate queue rather than a representative market
  population.
- **Who:** the Kairos owner.
- **Expected value:** valid sector breadth, auditable research coverage, and a
  clean comparison between the names the system studies and the names it selects.
- **Shipped at:** not shipped.

## 1. Verified baseline and constraints

### What exists

- `gatherSymbols()` in `lib/research-agent.ts` assembles a bounded daily list from
  holdings, `research_enabled` watchlist rows, Theme Scout, screeners, and a small
  relative-strength discovery stream. This is a candidate queue, not a full-market
  universe.
- `symbol_profiles` caches broad provider profile metadata. The present US source
  is Finnhub `profile2`, whose `finnhubIndustry` value is useful context but is not
  a verified canonical GICS classification contract.
- `edge_universe_members` supports immutable point-in-time memberships, but its
  historical current-liquid source is explicitly survivorship-biased and cannot be
  silently reused as this feature's historical truth.
- Robinhood REST has an instrument lookup used by the `robinhood` adapter's
  `preflightOrder`; that check is account/order-time evidence. It is not proof that
  a bulk enumeration API is available or licensed.
- **Correction (2026-09-09):** an earlier draft claimed "Robinhood MCP has no
  instrument-capability tool." That is false. The connected Robinhood MCP exposes
  `get_equity_tradability`, plus `search`, `run_scan`, `get_scanner_filter_specs`
  and `get_equity_fundamentals`. What it does *not* expose is a documented **bulk
  enumeration** tool, and every one of those is per-symbol or per-scan and
  rate-limited. The conclusion is unchanged — no bulk universe from the broker —
  but the claim must be stated as "no documented bulk-enumeration tool", not as
  an absence of instrument capability. §9 already requires this be verified from
  the actual connected adapter/tool contract rather than assumed.
- `broker_instrument_preflights` is append-only and distinguishes
  `execution_attempt` from `candidate_probe`; it must continue to keep discovery
  evidence separate from last-mile enforcement evidence.

### External facts to respect

- Robinhood states that it offers over 11,200 securities, but also documents that
  a security can be untradeable because of a halt, delisting/OTC status, foreign
  security restriction, or corporate action. [Investments on Robinhood](https://robinhood.com/us/en/support/articles/investments-you-can-make-on-robinhood/?region=US),
  [untradeable securities](https://robinhood.com/us/en/support/articles/whats-an-untradable-stock/).
- Nasdaq publishes current Nasdaq and other-exchange symbol directories, including
  security name, exchange, status and test-issue fields, with intraday updates.
  This is a useful current membership feed—not historical membership.
  [Nasdaq Symbol Directory definitions](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs).
- SEC EDGAR publishes ticker/CIK/exchange associations, but explicitly does not
  guarantee their accuracy or scope. It is an identity corroborator, not the sole
  universe or classification source. [SEC EDGAR data access](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).
- NYSE's complete security-master reference products are commercial. We must not
  claim a free, complete NYSE historical source before licensing and coverage are
  verified. [NYSE reference data](https://www.nyse.com/market-data/reference).

## 2. Scope and non-goals

### In scope

- A current US instrument catalog sourced from documented exchange/reference feeds.
- A versioned daily measurement-universe snapshot with explicit membership reasons.
- Deterministic, cached profile/price/liquidity collection for its members.
- A normalized classification contract with source, effective timestamp, and
  confidence/quality state.
- A bounded selection interface that feeds the existing ResearchAgent queue without
  replacing its entry, risk, or broker gates.
- Owner-visible coverage, source freshness, sector counts, and exclusions in
  Upgrade Path / Research.

### India: deliberately deferred, not forgotten

This document is US-only, and the schema names (`us_instrument_catalog`,
`us_measurement_universe`) make that permanent if left unstated. India has the
**same** population-bias problem at nearly the same scale — 161 distinct India
symbols in `decision_observations` against 167 US — so the deferral is a
sequencing choice, not evidence that India is fine.

India is out of scope for Stage 0 because its sourcing is materially harder: there
is no Nasdaq-directory equivalent, NSE/BSE reference data carries its own licensing,
and the classification vendor question must be answered separately. Deferring keeps
Stage 0 cheap and honest. A later India cohort must be its own architecture with its
own sources and its own frozen policy — it must NOT be produced by widening a
US-shaped table, and cross-market universe aggregates remain invalid per the
Scoring Data-Truth Review Protocol.

### Explicit non-goals

- No all-security daily LLM research.
- No claim that every catalogued security is Robinhood-tradable, liquid, or safe.
- No bulk broker probing of 11,200 securities unless the broker documents a
  read-only bulk capability and its rate/terms have been verified.
- No historical backtest using today's catalog membership.
- No automatic watchlist insertion, paper entry, live entry, score-weight change,
  broker enablement, or `live_auto_enabled` change.
- No use of the catalog to bypass `symbol_blocklist`, leveraged/inverse ETF policy,
  account allowlists, or last-mile broker preflight.

## 3. Population policy

### 3.1 Catalog: broad observation, not endorsement

`us_instrument_catalog` represents an observed current instrument identity:

- `instrument_id` (internal immutable identity), source IDs, ticker, exchange,
  name, observed instrument type, active/status, first/last seen timestamps;
- SEC CIK when corroborated, with conflicts recorded rather than overwritten;
- source payload hash, retrieval timestamp, parser version, and source freshness;
- no `tradable=true` boolean. Broker capability is account- and time-specific.

The catalog accepts common stock, ADR, ETF, CEF, preferred, warrant, unit and OTC
as distinct types so the system can explicitly exclude or separately study them.
It is not a trading allowlist.

### 3.2 Measurement universe: policy-controlled common-stock cohort

Initial measurement is US exchange-listed **ordinary common equity only**. ETFs,
ADRs, CEFs, preferreds, units, warrants, OTC issues, SPAC shells and leveraged or
inverse products are excluded from the initial cross-sectional sector cohort and
record an exclusion reason. They may receive separate instrument-family studies;
they must not dilute common-stock sector statistics.

Each daily member must satisfy a frozen policy version:

1. active primary US exchange listing from a documented source;
2. resolvable identity and a current classification of sufficient quality;
3. at least 60 completed trading sessions of price history;
4. a predeclared liquidity threshold using trailing 20-session median dollar volume;
5. valid close/volume coverage on the prior session;
6. no hard block in `symbol_blocklist` or generic instrument policy.

**Do not choose the liquidity threshold now.** Stage 0 measures $2m, $5m and $10m
20-day median-dollar-volume arms for size, sector coverage, provider cost and missing
bar rate. The eventual threshold, minimum price rule (if any), and maximum cohort
size are one frozen policy decision after that evidence. The architecture must not
silently select the result with the best realized returns.

Membership is not sector-quota-selected: forcing exactly N names per sector would
invent an investable universe that does not exist. The owner-visible report may show
undercovered sectors and the shortlist may impose exposure limits later, but the
measurement cohort remains a transparent liquidity policy.

### 3.3 Daily research shortlist: deterministic-wide, AI-narrow

The existing ResearchAgent keeps a bounded deep-research budget. A new deterministic
selector may propose a diversified shortlist only from that day's measurement
universe, with every inclusion carrying an immutable reason:

- held positions always retain their existing monitoring path;
- current manual watchlist intent remains a separately labeled source;
- candidates are ranked by existing deterministic screens/edge measurements,
  liquidity, freshness, and an explicit per-sector maximum;
- no score threshold, buy recommendation, or order may be produced merely because
  a name is in the broad cohort or shortlist.

The selector's *shadow* compares the existing candidate queue with the diversified
shortlist on coverage, data quality, score distribution, future labels and benchmark-
relative outcomes before the shortlist may replace any current source.

### 3.4 Current-screen audit and proposed family router

**Verdict: the current screens are a respectable safety baseline, but are not good
enough to be the long-term selection architecture.** They are good at avoiding a
silent outage and producing a small list; they are not yet good at choosing the best
research allocation across unlike instruments.

| Current path | What it does well | Material limitation |
|---|---|---|
| Yahoo common-equity momentum/value buckets | Limits to NMS/NYSE, rejects malformed preferred/warrant-style tickers, applies a volume floor, interleaves the two buckets, and has a daily absurd-threshold contract check | Only two static fundamental screens; its “momentum” ranks quarterly revenue growth, not price momentum; volume is shares/day rather than dollar liquidity; it has no spread, sector, correlation, data-quality or forward-outcome test |
| FinancialDatasets fallback | Keeps a second provider path when Yahoo fails | It has previously become unavailable when credits were exhausted, so it cannot be a silent primary truth source |
| Relative-strength discovery | Uses completed-session persisted price evidence and limits itself to four candidates | Its present input is a static current-liquid list, explicitly survivorship-biased; it is not a point-in-time broad-universe ranking |
| Metals / region / ETF paths | Preserve selected holdings and intentionally append known baskets | They are curated static lists, not family-specific screens; ETFs cannot be validly ranked with an operating-company P/E or revenue-growth rule |

The Yahoo field-contract cron is valuable and must remain: it detects whether a
provider still *applies* a field. It does **not** prove that the screen's economic
idea predicts returns, that it works outside technology, or that it selects liquid
broker-fillable candidates. “The filter executed” and “the filter has edge” are
different claims.

The replacement is a **family router**, not one giant stock screener. It uses the
catalog's verified instrument type and classification to choose a predeclared,
deterministic candidate screen:

| Family | Candidate-screen inputs (initial shadow only) | Explicitly not used |
|---|---|---|
| Ordinary common equity | minimum dollar liquidity, price-history/data quality, price relative strength, quality/growth, value, and only point-in-time earnings-revision data once its provenance is available | ETF/fund mechanics or a single universal P/E cutoff |
| Banks / REITs | same basic liquidity/price requirements plus family-applicable valuation/quality fields | generic operating-company growth screens when the field is economically inapplicable |
| Broad, sector and thematic ETFs | fund identity, assets/liquidity/spread availability, completed-session trend/relative strength and volatility | company revenue growth, ROE and P/E screens |
| Metals bullion funds / miners / streamers | instrument-family identity, fund liquidity, completed-session relative strength and volatility; commodity/macro features only after a sourced data contract and shadow evidence exist | treating GLD, GDX and a gold miner as the same issuer type or inventing a commodity signal from LLM text |
| ADRs, CEFs, preferreds, warrants, OTC, leveraged/inverse products | catalog and exclusion reporting only in the first release | generic automatic candidate selection |

Each family screen is a named **candidate source**, never a score adjustment or
buy rule. The router records the exact inputs, missing fields, policy version and
rank. It feeds a fixed-capacity, correlation-aware shortlist: no family can consume
the entire daily research budget; overlapping exposures and duplicate share classes
are deduplicated before the LLM stage.

Before any family screen is used outside shadow, freeze its primary horizon,
benchmark, selection cap and material-effect threshold. Evaluate it against (a) the
incumbent queue and (b) a transparent liquidity-only control on the same sessions.
Report coverage, data failure, turnover, h5/h10/h20 benchmark-relative outcomes,
drawdown and concentration. A screen with no adequate mature evidence remains
`insufficient_evidence`; it does not earn capital merely by producing attractive
names.

## 4. Data contracts and schema direction

This is a migration plan, not approval to apply one.

### 4.1 New append-only objects

1. `instrument_catalog_sources` — source/version/license/terms review and latest
   freshness; one active source policy per purpose, never a hidden fallback.
2. `us_instrument_catalog` — current identity state keyed by stable internal ID.
3. `instrument_catalog_events` — append-only adds, changes, delists, identity and
   classification conflicts, with raw-hash/source references.
4. `universe_policies` — immutable policy version, inclusion/exclusion predicates,
   thresholds, source versions, code fingerprint and content hash.
5. `universe_memberships` — immutable `(policy_id, as_of_session, instrument_id)`
   membership snapshots plus `included` and deterministic reason codes. Exclusions
   are sampled/aggregated in a companion coverage ledger rather than writing
   millions of rejected rows indefinitely.
6. `universe_collection_runs` — lease/run key, source freshness, input/output
   counts, errors, budget consumption, catalog and membership fingerprints.
7. `instrument_classifications` — append-only provider observations; normalized
   sector/industry, taxonomy/version, effective/observed timestamps and quality.
8. `universe_shortlist_assessments` — immutable daily arms, candidate source,
   selection reason, feature freshness and later label links.

`edge_universe_members` remains owned by Edge discovery. Reusing it would combine
two policy lifecycles and make future evidence provenance ambiguous.

### 4.2 Required invariants

- A membership snapshot cannot be UPDATEd, DELETEd or TRUNCATEd; corrections append
  a new observation/session with a source-correction link.
- Every computed statistic names `universe_policy_version`, `as_of_session`,
  membership fingerprint, data-cutoff timestamp and code version.
- Missing classification is `unclassified`, never guessed from a company name.
- A source outage is `unavailable`, not an empty universe or zero members.
- Delisted and symbol-reused identities never share an internal instrument ID.
- An expired broker preflight cannot be used to advertise a currently tradable
  instrument, and catalog membership can never satisfy an order preflight.

## 5. Collection design

### Stage 0 — source and capacity proof (read-only)

Before a migration, build only an owner-visible capability report that samples and
records:

1. Nasdaq listed and other-listed directory parseability, timestamps, duplicate and
   test-issue handling;
2. NYSE/NYSE Arca coverage route, licensing and whether a source can legally be
   stored and used by Kairos;
3. SEC CIK/ticker/exchange corroboration and conflict rate;
4. classification provider coverage, taxonomy consistency and TTL across a
   stratified sample of common stocks;
5. price/bar and liquidity coverage, provider call cost and practical batch rate;
6. Robinhood REST lookup on a small, rate-limited stratified sample only—reported as
   corroboration, never assumed to enumerate all account-eligible instruments.

Exit criteria: named source contracts, acceptable licensing, measured missingness,
and a budgeted daily cohort size. If any source is not adequate, the program stops
at a truthfully incomplete capability report.

### Stage 1 — catalog and snapshot (evidence-only)

On each US market session after the reference-data cutoff:

1. fetch and archive raw source manifests/payload hashes;
2. reconcile identities without ticker-only joins;
3. write catalog events and current state;
4. collect deterministic prior-session bars and liquidity in bounded batches;
5. write the frozen membership snapshot and a coverage/failure summary;
6. refresh classifications only when stale, while preserving their source/version;
7. expose freshness and exclusions. No ordinary ResearchAgent change yet.

Collection must be resumable, idempotent, rate-limited, leased, and fail closed for
membership publication: a partial source run is reported as partial and cannot
replace a complete snapshot.

### Stage 2 — shortlist shadow (still evidence-only)

For each complete measurement snapshot, produce two persisted arms:

- `incumbent_queue`: current ResearchAgent candidate provenance;
- `diversified_measurement_shortlist_v1`: deterministic ranking from the broad
  measurement membership under fixed per-sector maximum and overall daily cap.

Both arms receive the same score/data pipeline when capacity permits. Report their
overlap, sector/size/liquidity coverage, data failures, score distributions, entry
eligibility incidence, h5/h10/h20 returns and benchmark-relative results. A name
that lacks data stays a named failure; it must not silently drop from one arm.

Stage 2 includes one `family_router_v1` arm per applicable family alongside a
liquidity-only control. Do not ship all family screens at once: start with ordinary
common equities, then add ETFs and metals only after their data contracts and
appropriate controls are verified. This keeps a poor ETF or commodity screen from
being hidden inside an apparently successful equity aggregate.

### Stage 3 — separately proposed limited integration

Only after Stage 2 has adequate matured labels and no quality regressions may a
separate architecture propose changing the existing candidate queue. It must state
the exact policy arm, rollout percentage, rollback switch and effects on Research,
PaperTrader and live gateways. No live promotion follows automatically.

## 6. Classification policy

Use a licensed/reference provider chosen in Stage 0 for a normalized taxonomy such
as GICS sector plus industry group. Store the raw provider classification alongside
the normalized result. Finnhub's coarse industry can remain a display fallback but
cannot be treated as the canonical research-universe label without a coverage and
mapping audit.

Classification resolution order is deterministic:

1. source-specific stable instrument ID and current official/reference taxonomy;
2. independently corroborated provider mapping;
3. `unclassified` with source failure/conflict reason.

Never infer sector from ticker, LLM text, fund name, or a single peer list. ETFs and
multi-sector conglomerates require separate classification semantics and therefore
remain outside the first common-equity cohort.

## 7. Safety and failure behavior

| Condition | Required behavior |
|---|---|
| Source says no records / parser breaks | Mark run unavailable; retain prior snapshot as historical only; do not publish an empty current one |
| Identity or ticker conflict | Preserve both claims, mark unresolved, exclude from new measurement membership |
| Classification missing/stale | `unclassified`; no sector statistic inclusion |
| Price/liquidity missing | Exclude with reason; count in coverage report |
| Broker lookup denied/stale/unsupported | Catalog may remain observed; it cannot enter a broker-compatible shortlist label and cannot advance enforcement evidence |
| Corporate action/delisting/symbol reuse | Append event and terminate old identity; no ticker-only carry-forward |
| Provider budget exhausted | Stop new requests, report partial coverage, do not downgrade quality silently |
| Shortlist output empty | Record an explicit abstention with input/count/failure reasons, never fall back to the curated queue without labeling it |

## 8. Owner-facing surfaces

Upgrade Path is the aggregate program view. It should show:

- policy version, latest complete session, sources and freshness;
- catalog count by instrument type and measurement-member count by sector;
- classification, identity, price and liquidity coverage; exclusions by reason;
- the current broker-probe sample rate and outcome—not a false claim of universal
  Robinhood tradability;
- incumbent versus shadow shortlist overlap and matured-outcome evidence;
- clear state: `collecting`, `partial`, `insufficient_evidence`, `ready_for_review`,
  or `blocked`.

Research should show a symbol's membership source, policy, classification provenance
and whether it was selected by the incumbent or shadow shortlist. It must never call
the broad catalog a buy list.

## 9. Acceptance criteria

### Architecture / Stage 0

- [ ] No unsupported claim that Robinhood supplies a bulk, historical or canonical
  sector universe.
- [ ] Every source has a documented license/terms, freshness, identity fields,
  instrument coverage and measured sample failure rate.
- [ ] Three liquidity arms are measured before a default threshold is selected.
- [ ] A cost/capacity model proves the deterministic-wide run fits the scheduled
  provider budget; no LLM budget is used for the full cohort.
- [ ] Robinhood bulk/candidate-probe limits are verified from the actual connected
  adapter/tool contract, not assumed from a consumer app screen.

### Stage 1

- [ ] Re-running one session is idempotent; a partial run cannot overwrite a full
  snapshot.
- [ ] Every membership statistic is reproducible from a frozen policy, source hash,
  as-of session and code version.
- [ ] Sector coverage reports distinguish `unclassified`, excluded instrument type,
  and missing provider data.
- [ ] Mutation tests prove that current catalog membership cannot be reused for a
  historical snapshot and that a stale broker preflight cannot mark a name tradable.

### Stage 2

- [ ] Both selection arms are persisted before outcomes mature.
- [ ] The UI shows observations and uncertainty, not a winning-strategy claim.
- [ ] No score, eligibility, sizing, paper, live order, or broker configuration is
  changed by this program.
- [ ] Every family router has a matching liquidity-only control and reports its
  coverage, failure rate, overlap and matured benchmark-relative outcomes.
- [ ] The price-relative-strength arm is not promoted while its source universe is
  the current-liquid, survivorship-biased Edge list.

## 10. Decisions needed before implementation

1. Approve Stage 0 capability/cost study only, or fund/select a licensed US
   security-master and classification vendor now.
2. Decide whether the first measurement cohort is common equities only (recommended)
   or whether ETFs must be a separately governed simultaneous cohort.
3. After Stage 0: freeze the liquidity/minimum-price policy and daily deterministic
   budget; do not set these from historical returns.
4. Approve any Stage 1 schema migration only after the selected source contracts and
   data-retention terms are recorded.

## 11. What this document deliberately rejects

- “Research all 11,200 with AI every day.” This spends the budget on heterogeneous,
  often untradeable instruments while making the output less auditable.
- “Use Robinhood category labels.” A broker execution inventory is not a stable
  security-classification system.
- “Lower the sector sample floor.” That would make a weak cohort look statistically
  adequate rather than increase the evidence population.
- “Automatically buy all newly discovered names.” Discovery and execution are
  intentionally different safety states.
