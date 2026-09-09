# New Symbol, Listing, and Pre-IPO Discovery

> Status: PARTIALLY IMPLEMENTED — P0 plus the filing-discovery slice of P1 shipped 2026-09-09. Exchange-listing events, identity reconciliation, broker candidate probes, 20/40/60 admission shadows, and every money-path effect remain unimplemented and separately gated.
> Last revised: 2026-09-09 by Codex after code-path and source review.
> Money-path influence: none until a later, separately approved promotion.

## 0. Decision summary

Kairos should discover and study newly listed instruments, but it must not use the
owner watchlist as a machine discovery database or infer that discovery means a
symbol is safe to score or buy.

The recommended first release is an evidence-only candidate registry:

1. ingest authoritative issuer filings and listing events;
2. resolve issuer, listing, symbol, exchange, and instrument identity;
3. verify the exact target broker/account can buy the instrument;
4. collect point-in-time scores, prices, liquidity, and forward outcomes;
5. compare predeclared 20/40/60-session admission policies in shadow;
6. show the evidence in Research and Upgrade Path.

It must not add candidates to `watchlist`, make them entry-eligible, create paper
positions, or place live orders during this release.

### Feature-lifecycle record

- **Why:** Kairos can otherwise miss new companies and ETFs, while manually adding
  every listing is incomplete and does not produce evidence about when a new listing
  becomes suitable for the existing strategy.
- **Who:** the single Kairos owner.
- **Expected value:** broader, broker-relevant research coverage and a measurable
  answer to whether newly listed instruments add benchmark-relative return.
- **Shipped at:** 2026-09-09 (evidence-only SEC daily-index filing discovery, candidate/event/filing registry, Research and Upgrade Path read surfaces).

## 1. Verified baseline

### 1.1 What exists

- `watchlist.research_enabled` controls whether a watchlist row enters the ordinary
  ResearchAgent batch. It is an owner research preference, not an instrument-trust
  state.
- `gatherSymbols()` reads only research-enabled watchlist rows. Its watchlist
  partition currently reduces every non-manual watchlist source to the generic
  `watchlist` discovery source. Adding `source='new_listing_scan'` to a watchlist row
  alone would therefore lose the provenance needed by LearnerAgent.
- A technical score becomes usable at 15 completed candles. EMA50 requires 50 bars;
  EMA200 is measure-only and requires 200. The providers commonly return about 251
  bars, but 251 is not an entry requirement.
- New long entries already require at least two usable score dimensions, the normal
  score threshold, no earnings-repricing barrier, and no breakdown veto.
- `broker_instrument_preflights` and each execution adapter can record exact
  broker/account/symbol/side capability. The current Stage-0 program is measure-only
  and normally runs immediately before an attempted live order.
- `evidence_records`, `doc_chunks`, `decision_observations`, return labels, and
  Upgrade Path already provide most of the evidence and outcome infrastructure.
- The currently observed Robinhood MCP tool catalog has no tool for requesting or
  managing a primary-market IPO allocation. Robinhood documents IPO Access as a
  conditional-offer workflow with eligibility checks and potentially partial or
  zero allocation. This means Kairos cannot automate IPO Access through the current
  MCP surface. It does not justify a permanent or industry-wide claim.

### 1.2 What does not exist

- No authoritative, persistent new-listing event feed.
- No stable issuer-to-listing identity spanning pre-ticker CIK, later ticker,
  exchange, symbol changes, postponements, withdrawals, or delistings.
- No candidate lifecycle distinct from the owner watchlist.
- No IPO/new-listing cohort in discovery provenance or LearnerAgent.
- No measured answer for whether 20, 40, 60, or another number of sessions is the
  right admission delay.

## 2. Scope and safety boundaries

### In scope

- US issuer filing discovery: S-1, S-1/A, F-1, F-1/A, 424B4 and related status
  changes, keyed by CIK and accession number.
- US exchange-listing event discovery for ordinary equities, ADRs, direct listings,
  ETFs, and SPAC-related listings, with explicit instrument-type cohorts.
- Exact broker/account buy-capability corroboration.
- Point-in-time research and outcome capture with no trading influence.
- A Research-page candidate panel and an Upgrade Path shadow program.
- A source-adapter contract that can support India later without changing the state
  machine.

### Out of scope

- Requesting primary IPO allocations.
- A day-one or “hot IPO” entry path.
- New IPO-specific score weights, targets, stops, sizing, or exits.
- Silent insertion into the owner watchlist.
- Automatic paper or live eligibility.
- Changing `live_auto_enabled`, account allowlists, autonomy level, or broker
  enforcement mode.
- India ingestion until an NSE/BSE source passes the same provenance, licensing,
  freshness, and coverage checks.

An owner may still read research or manually follow a candidate. An owner-directed
manual trade remains governed by the existing confirmation, risk, and broker
preflight controls; this feature does not create a hidden manual-trading prohibition.

## 3. Source policy

### 3.1 Filings

Use SEC EDGAR directly as the primary US filing source. `data.sec.gov` is a regulator
source, requires no API key for public data, and publishes submissions in near real
time. Requests must use the SEC-required identifying User-Agent, bounded concurrency,
backoff, and immutable accession-number provenance.

Robinhood `get_sec_filing*` tools may be tested as a corroborating adapter only after
their live schemas and content coverage are captured. They are not currently in
`ROBINHOOD_RESEARCH_READ_TOOLS` and must not be assumed available to a new route merely
because a historical tool inventory named them.

### 3.2 Listing events

`search`, `create_scan`, and `run_scan` are not accepted as an authoritative new-
listing feed. Search requires a candidate query, and a scanner is not proven to emit
every new equity and ETF or preserve listing dates.

Before choosing a provider, Stage 0 must compare candidate sources against these
requirements:

- stable source event ID;
- exchange and first-trade/effective date;
- symbol, name, instrument type, and status;
- amendments, postponements, withdrawals, symbol changes, and delistings;
- daily publication cadence and documented correction behavior;
- licensing that permits Kairos storage and use;
- measured coverage against a second independent source.

Official exchange listing notices or directories are preferred. Nasdaq's Daily List
is an example of the required event shape, but it is a data product and must not be
selected until access, licensing, cost, and NYSE/other-exchange coverage are verified.

### 3.3 Broker truth

An exchange listing is not proof that the selected broker/account supports it.
Discovery adapters propose candidates; broker adapters corroborate exact capability.

For each listed candidate, run a read-only one-unit BUY preflight against the target
broker/account and persist the result to `broker_instrument_preflights` with
`proposal_id=NULL`. Add a required `purpose` discriminator:

- `execution_attempt` — the existing last-mile order-path observation;
- `candidate_probe` — a discovery/admission observation that cannot imply an order.

Backfill existing rows as `execution_attempt`. Upgrade Path's broker-enforcement gate
must count only `execution_attempt`; this program counts only `candidate_probe`.
Without that separation, automated candidate probes would falsely advance the
existing ten-session broker-enforcement gate. The candidate stores only a pointer to
the latest applicable preflight; the append-only preflight ledger remains the
evidence source.

A denied, unsupported, stale, account-mismatched, or symbol-mismatched result can never
be treated as allowed. A broker result may expire and must be refreshed before any
future admission decision.

## 4. Domain model

Do not add `first_seen_at` to `watchlist`. Create a dedicated machine-candidate model.

### 4.1 `listing_candidates` — current state

```sql
create table public.listing_candidates (
  id                    bigint generated always as identity primary key,
  market                text not null check (market in ('us','india')),
  issuer_key            text not null,
  listing_key           text not null,
  symbol                text,
  company_name          text not null,
  exchange              text,
  instrument_type       text not null check (instrument_type in
                          ('operating_company','adr','direct_listing','etf','closed_end_fund',
                           'spac','unit','warrant','preferred','unknown')),
  state                 text not null check (state in
                          ('pre_listing','announced','listed_observing','paper_admitted',
                           'withdrawn','postponed','rejected','delisted')),
  announced_at          timestamptz,
  first_trade_date      date,
  first_seen_at         timestamptz not null,
  last_seen_at          timestamptz not null,
  source                text not null,
  source_event_id       text not null,
  source_url            text not null,
  source_payload_hash   text not null,
  latest_preflight_id   bigint references public.broker_instrument_preflights(id),
  admission_policy_id   bigint,
  admitted_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (market, listing_key)
);
```

`issuer_key` is a US CIK when known and otherwise a source-scoped identifier.
`listing_key` is the stable source/exchange listing identity. `first_trade_date`
comes from an authoritative listing event. `first_seen_at` records Kairos discovery
latency and must never substitute for listing age.

### 4.2 `listing_candidate_events` — append-only lineage

Every discovery, correction, state transition, symbol mapping, filing link, broker
probe, rejection, and admission decision appends an event with:

- `candidate_id`, `event_type`, `event_at`, `effective_at`;
- prior and next state where applicable;
- source, source event ID/URL, payload hash;
- deterministic reason code and calculations;
- code version and policy version.

UPDATE, DELETE, and TRUNCATE are forbidden to authenticated and service roles by
grants and triggers. Corrections append a superseding event; they do not rewrite
history.

### 4.3 `issuer_filings` — append-only filing identity

Store one row per accession/document version:

- CIK, accession number, form, filed/accepted/effective timestamps;
- primary document URL, issuer name, candidate ID when resolved;
- raw document hash, retrieval timestamp, parser version and quality state;
- structured extracted facts and risks with section/page anchors;
- amendment/supersedes accession link.

The unique identity is accession number plus primary-document hash. A new S-1/A is a
new row. `decision_journal` receives a concise owner-visible summary that links to
these immutable filing rows; it is not the source of truth.

Full filing text may be chunked after issuer identity is resolved. Do not put a fake
ticker into `doc_chunks.symbol` for a pre-ticker company. Either add a separately
approved issuer-key retrieval contract or defer chunk ingestion until a real symbol
mapping exists.

### 4.4 `listing_admission_policies` and assessments

Store each frozen policy arm with its session floor, evidence requirements, broker
requirements, liquidity rule, primary outcome, inference plan, code version and
content hash. Once referenced by an assessment, it is immutable.

`listing_admission_assessments` is append-only and records candidate, policy,
as-of session, `would_admit`, every reason code, evidence IDs, calculations and code
version. A unique key on `(candidate_id, policy_id, as_of_session)` makes retries
idempotent. `listing_candidates.admission_policy_id` references this policy table only
after an owner-approved promotion.

### 4.5 Access

- Service role: insert/update current candidate state through a constrained RPC;
  append events and filings.
- Authenticated owner: read only.
- Anon: no access.
- State transitions use compare-and-swap and append their event atomically.

## 5. State machine

```text
pre_listing ──listing announced──> announced
announced ──first trade verified──> listed_observing
announced ──delay──> postponed
pre_listing/announced ──cancelled──> withdrawn
listed_observing ──approved policy passes──> paper_admitted
listed_observing ──invalid/unsupported──> rejected
listed_observing/paper_admitted ──delisted──> delisted
```

Only `paper_admitted` can enter the ordinary new-buy ResearchAgent candidate pool in
a future promoted stage. Pre-listing and observing candidates are researched by the
dedicated shadow collector and never set `decision_observations.entry_eligible=true`.

No state in this table grants live eligibility. Live execution still requires the
normal signal/proposal/autonomy chain and a fresh last-mile broker preflight.

## 6. Collection and APIs

### 6.1 Scheduled collectors

Run on US business days, not weekly:

1. `listing-filing-discovery` — incrementally reads new/changed SEC submissions.
2. `listing-event-discovery` — reads the approved listing-event adapter.
3. `listing-identity-reconcile` — resolves CIK/listing/symbol without guessing.
4. `listing-broker-capability` — refreshes exact account BUY capability after the
   listing becomes active and when prior evidence expires.
5. `new-listing-shadow` — captures a bounded rotation of point-in-time features,
   scores, liquidity and prices; it creates no executable signal.
6. Existing label maturation computes forward returns from immutable observations.

Each collector uses a lease/run key, pagination cursor, bounded wall-clock budget,
idempotent source IDs, explicit error state, and an `agent_runs` or equivalent run
record. Empty provider responses are unavailable, not “zero new listings.”

### 6.2 Owner APIs

- `GET /api/listing-candidates` — filters by state, type, broker capability and age.
- `GET /api/listing-candidates/[id]` — source lineage, filings, evidence and shadow
  outcomes.
- `POST /api/listing-candidates/[id]/follow` — creates or updates a manual owner
  watchlist relationship without changing candidate trust or admission state.
- `POST /api/listing-candidates/[id]/research` — refreshes filing analysis only;
  never changes eligibility.

Use candidate ID or CIK, not a free-form “ticker-or-CIK” parameter. A company may not
have a ticker yet, and ticker reuse/symbol changes make free-form identity unsafe.

## 7. Provenance in ResearchAgent

Add explicit discovery sources only when the shadow collector is wired:

- `new_listing_observation` — measure-only dedicated collection;
- `new_listing_admitted` — future paper-admitted candidate.

Update together:

- the `DiscoverySource` TypeScript union;
- `discovery_snapshot_members` CHECK constraint;
- discovery-ledger serialization;
- Research Journal filters and labels;
- carry-forward provenance;
- tests proving the source survives candidate → queue → research → observation.

Do not route a candidate through the generic watchlist partition, which would relabel
it `watchlist` and make cohort learning impossible.

## 8. Admission-policy shadow

### 8.1 Mainline and challengers

- **Mainline:** newly listed candidates remain in `listed_observing`; no automatic
  paper admission.
- **Challenger A:** admission assessment at 20 completed exchange sessions.
- **Challenger B:** assessment at 40 completed exchange sessions.
- **Challenger C:** assessment at 60 completed exchange sessions.

These are predeclared measurement arms, not three promises to trade. Session age is
computed from `first_trade_date` using the market calendar. Every arm also requires:

- a fresh exact broker/account BUY capability result;
- at least two genuinely usable applicable scoring dimensions;
- completed-candle provenance with no stale or current-intraday bar;
- valid quote and existing liquidity/risk checks;
- no earnings-repricing or breakdown veto;
- the ordinary score threshold.

An arm records `would_admit=false` plus reason codes when any requirement fails.

### 8.2 Cohorts

Never pool these without reporting them separately:

- operating-company IPO;
- ADR/foreign issuer;
- direct listing;
- ETF launch;
- SPAC IPO or de-SPAC/symbol conversion.

Each candidate is compared with point-in-time matched established instruments from
the same market, sector/instrument family, size and liquidity bucket, and calendar
window. The benchmark and comparison policy are frozen before labels mature.

### 8.3 Outcomes

At h5, h10 and h20, report:

- benchmark-neutral return and rank IC;
- maximum favorable/adverse excursion using executable-bar assumptions;
- close-to-next-open gap and realized volatility;
- spread/liquidity availability and broker denial rate;
- score coverage, dimension availability and breakdown-veto incidence;
- entry-threshold crossing rate, win rate, profit factor and drawdown;
- matched-control delta with confidence intervals.

Do not select a policy from win percentage or raw P&L alone. Listing clusters share
market conditions, so the inference unit includes distinct listings and independent
listing-week clusters. Results remain `insufficient_evidence` until both (a) a
predeclared lower bound of 30 distinct listings and 12 independent listing-week
clusters and (b) the sample required by a frozen power/MDE calculation have matured
for the relevant cohort and primary horizon. Thirty is an analysis floor, not proof
of edge. If the power requirement takes a long time, the correct result is to keep
abstaining.

Any later promotion requires:

1. no unresolved source or broker disagreements;
2. adequate candidate and matched-control coverage;
3. a positive primary-horizon matched-control estimate whose confidence interval
   clears the frozen material-underperformance tolerance, plus no contradictory sign
   across the secondary horizons;
4. no materially worse drawdown or liquidity failure than controls;
5. a frozen policy version and code fingerprint;
6. explicit owner approval.

Promotion first permits **paper admission only**. Live influence requires a separate
architecture and approval after forward paper evidence.

## 9. UI

Add a “New Listings” section to the existing Research surface, not a new top-level
page and not the watchlist table.

For each candidate show:

- company, symbol when assigned, exchange and instrument type;
- lifecycle state and authoritative first-trade date;
- latest filing/amendment and source link;
- broker/account capability with checked/expiry timestamps;
- completed sessions and score/data coverage;
- 20/40/60 challenger assessments and explicit refusal reasons;
- benchmark-relative shadow outcomes once matured.

Upgrade Path owns the aggregate program view: freshness, candidates by state,
coverage, unresolved identity/source/preflight conflicts, matured sample counts and
promotion readiness. “Working” must never be shown merely because prices rose.

## 10. Failure behavior

| Failure | Required behavior |
|---|---|
| Listing source unavailable or stale | Record unavailable; do not infer no listings |
| Filing amendment cannot be fetched | Keep prior version, record gap; do not call it current |
| CIK-to-symbol mapping ambiguous | Keep unresolved; never guess |
| Listing postponed/withdrawn | Append transition; stop eligibility clock |
| First-trade date missing | Remain `announced`; no session-age calculation |
| Broker capability unsupported/denied/stale | `would_admit=false`; never coerce to allowed |
| Fewer than two usable dimensions | Abstain and record missing dimensions |
| Shadow collector exceeds budget | Persist cursor and resume; do not starve ordinary research |
| Candidate already manually watched | Preserve owner settings; link identities only |
| Symbol changes or is reused | New listing identity/event; never rewrite old observations |
| Schedule misses a run | Surface stale status in System Health and Upgrade Path |

## 11. Build sequence

### P0 — source and schema proof

- Verify live Robinhood capability schemas without calling an order tool.
- Compare at least two listing sources for coverage, corrections, licensing and cost.
- Build rolled-back schema/RLS/immutability tests.
- No scheduled writes, scoring or trading.

**Implemented 2026-09-09:** append-only candidate/event/filing tables with RLS and
immutable evidence triggers; a separate `candidate_probe` preflight purpose that
cannot advance the existing execution-enforcement gate; migration and active cron
verification. The source comparison and Robinhood-schema corroboration remain open.

### P1 — evidence-only US collectors

- Filing, listing, identity and broker-capability collection.
- Candidate detail and Research UI.
- Mainline remains abstain.

**Implemented slice:** the weekday `kairos-listing-discovery-us` job reads bounded
SEC daily master indexes for S-1/S-1-A/F-1/F-1-A/424B4 metadata and persists issuer
filing lineage. The Research Journal's New Listings tab and Upgrade Path show that
evidence and the unresolved state. This is explicitly *not* an exchange-listing
event collector: SEC filing metadata does not set `first_trade_date`, ticker,
exchange, or broker capability. Those remaining P1 collectors must not be claimed
as shipped until an approved authoritative source passes the source contract.

### P2 — shadow admission study

- Bounded point-in-time feature capture.
- 20/40/60 arms, matched controls and label maturation.
- Upgrade Path reporting.

### P3 — paper admission, only after evidence and approval

- Promote one frozen admission policy.
- Add `new_listing_admitted` to the ordinary research pool without using watchlist.
- Enforce the new-listing gate independently in the paper-entry consumer.
- Mutation-test that changing the gate to `return true` creates test failures.

### P4 — possible live consideration

Deferred. Requires forward paper evidence, last-mile broker-preflight enforcement,
and a separate explicit owner decision.

India follows P0-P2 only after an NSE/BSE listing source passes the same source
contract. The schema and policy engine remain market-neutral; no `.NS` guessing is
allowed as listing identity.

## 12. Acceptance criteria for the first approved release

1. No discovered candidate is inserted into `watchlist` automatically.
2. No candidate affects `entry_eligible`, paper fills, live proposals or orders.
3. Every candidate has an immutable source event, payload hash and retrieval time.
4. Filing amendments remain separate accession-version evidence.
5. Listing age uses authoritative `first_trade_date`, never discovery time.
6. Exact broker/account/symbol/BUY capability is recorded without submitting an
   order.
7. Source, identity, broker and data-quality disagreements fail closed and appear in
   System Health/Upgrade Path.
8. `new_listing_observation` provenance survives every persistence boundary.
9. The 20/40/60 policies run on identical point-in-time data and cannot influence
   execution.
10. Empty, stale and unsupported states are distinguishable in API and UI.
11. Unit, integration, mutation, full-suite, typecheck and isolated production build
    pass.
12. Any migration is verified in production with rolled-back mutation/immutability
    checks before a route reads it.

## 13. Source references

- SEC EDGAR APIs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- SEC IPO risk bulletin: https://www.sec.gov/investor/alerts/ipo-investorbulletin.pdf
- Robinhood IPO Access: https://robinhood.com/us/en/support/articles/about-ipo-access/
- Robinhood IPO request process: https://robinhood.com/us/en/support/articles/how-to-request-ipo-shares/
- Nasdaq Daily List product description: https://www.nasdaqtrader.com/trader.aspx?id=DailyListPD
