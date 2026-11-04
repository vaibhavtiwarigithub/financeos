# Election and Legislative Policy Impact Shadow

Status: **Owner-approved; implementation complete locally 2026-11-04. Production schema applied and verified; code release and natural maturity verification pending.**
Date: 2026-11-04
Owner intent: determine whether election outcomes and concrete legislative/policy changes add measurable, point-in-time context to Kairos research.

## 1. User intention

Kairos should record who controls the US House and Senate after elections, track material policy actions that follow, and measure how exposed market sectors and instruments behave—without turning party labels or election narratives into unsupported buy/short calls.

## 2. Current architecture

- `market_events` and `market_event_outcomes` are append-only, owner-readable event evidence. Their current curated vocabulary covers tariffs and company guidance, not elections or chamber control.
- `policy_rate_events` records FOMC dates/outcomes; `policy_event_impacts` measures existing daily-return data. It is not a general policy ledger.
- MacroSentinel supplies a US market-wide macro scalar. Existing macro and instrument-family studies are descriptive/shadow evidence; India macro remains excluded from the composite.
- The congressional-disclosure panel is not an election feed. Its former House Stock Watcher source is discontinued.
- No election or control-change feature currently feeds scoring, council prompts, paper decisions, or live decisions.

## 3. Proposed architecture

### Scope and staging

Start with a **US-only, read-only election/policy event study**. Reuse the existing event ledger, policy-event impact pipeline, stored daily-return evidence, existing Market and Learning surfaces, and existing System Health. Do not add a schedule, provider, paid service, model call, score input, or trading behavior in this first stage.

The first release records certified chamber-control outcomes and a small, owner-reviewed set of concrete enacted/proposed federal policy events. It measures index and sector/instrument responses separately. Historical event records require cited primary sources and verifiable public timestamps; do not infer historic control states or announcement dates from memory.

### Event contracts

Use the existing append-only `market_events`/`market_event_outcomes` machinery where it can represent the event without lossy encoding. Add a small structured election/policy detail relation keyed to `market_events.id` only if the current event row cannot unambiguously represent:

- event family and chamber (`house`, `senate`, `presidency`, `federal_policy`);
- prior and resulting control state, or a policy's proposal/enactment/implementation status;
- affected policy domain (`tax`, `trade`, `energy`, `health`, `defense`, `antitrust`, `industrial_subsidy`, or `other`);
- primary-source publication/effective timestamps, captured timestamp, source URL and immutable source snapshot hash;
- uncertainty/status (`projected`, `called`, `certified`, `proposed`, `passed`, `signed`, `effective`, `blocked`, `reversed`).

Control-result and policy-action records must be distinct events. An election result is not the same event as passage, signature, effective date, or enforcement. Persist original announcement time and first-seen time separately. Late or unverifiable timestamps are ineligible for point-in-time analysis.

Use official election authorities for certified results and official legislative/regulatory sources for bills, agency rules, and effective dates. Any preliminary results are visibly provisional. No prediction-market or news-vendor feed is assumed licensed or available. If an official machine-readable source cannot be consumed within the free-tier/runtime limits, show a source blocker and allow cited owner entry rather than silently scraping or substituting an LLM guess.

### Exposure and outcomes

Use existing benchmark/sector ETF return series and declared instrument families. For company-level analysis, use only already-recorded, point-in-time company exposure data; do not infer a company's political beneficiary status from its name or current price movement. Keep unexposed/unknown names as unknown.

For each preregistered event family, compare fixed windows (1, 5, 20, and 60 sessions) against the same-market benchmark and matched non-event dates. The first implementation matches up to 20 prior windows on the preceding 20-session SPY return and realized volatility, requiring complete date-aligned subject/benchmark returns, the same price basis, and control windows ending before the event's first eligible close. The matched set must be complete before its mean/delta is reported. Control windows may overlap; their count is not an effective sample size or inferential n. Report raw and benchmark-relative return, matched-control difference, source coverage, event count, and separate outcomes by symbol/instrument. Treat SOXL/SOXS, TQQQ/SQQQ, commodities, and ordinary equities as distinct exposures; do not sign-flip an underlying-sector result to manufacture an inverse/leveraged forecast.

Separate (a) result surprise relative to a timestamped pre-event expectation, if a valid source later exists, from (b) result itself, and (c) concrete policy implementation. Without a valid expectation history, the event is labeled “outcome-only”; no surprise is fabricated.

### Statistical safeguards

- Declare event families, affected cohorts, windows, benchmarks, and comparisons before reading outcomes.
- Count every tested event type, sector, horizon, and interaction toward trial multiplicity. Show raw counts and a conservative corrected analysis; sparse events stay `insufficient`.
- Avoid counting symbols exposed to the same event as independent event replications. Cluster or aggregate at the event/date level and retain matched dates.
- Preserve point-in-time prices, source vintages, market calendars, adjusted-price basis, and missing-window reasons. No forward fill across missing sessions.
- Show associations and uncertainty, not causal claims. Election control is correlated with economic conditions and often anticipated by markets.

## 4. User journey and system flow

1. Existing policy-event collection/owner entry records an official result or policy event with source evidence.
2. Existing event-maturation work derives returns from already-persisted price observations; no quote fetch is initiated by this feature.
3. The Markets policy-event card shows current control status, event timeline, source, timestamp precision, and provisional/certified state.
4. Learning shows matured event-study outcomes and evidence limitations by market instrument family, event cohort, and horizon.
5. If the primary source is absent, stale, or incomplete, show `unavailable`/`provisional`; never interpret an empty event list as “no policy risk.”

## 5. UI / API / data / interaction model

- Reuse the existing `/api/markets/policy-events` and `/api/events` surfaces where their access contract fits.
- Add no new route unless the existing event contract cannot safely serve structured election metadata; if unavoidable, use the existing owner/cron auth patterns and read-only owner UI.
- Prefer an additive structured relation linked to `market_events`; append-only writes, service-role-only writer, owner-only reads, source provenance, and no public writes.
- Reuse `market_event_outcomes` and existing daily returns for impact calculation. Extend the existing Learning evidence view rather than create another dashboard.
- No trades, short orders, target prices, deterministic score adjustments, or per-symbol “buy/sell” recommendations are produced.

## 6. States and edge cases

- `provisional`: unofficial projections or incomplete counts; excluded from certified-result studies.
- `certified`: official result available and cited.
- `proposed` / `passed` / `signed` / `effective` / `blocked` / `reversed`: distinct policy lifecycle events, never collapsed into one label.
- `timestamp_unverified`: displayable but excluded from point-in-time measurement.
- `source_unavailable`: retain last verified record with stale timestamp and degraded source status.
- `insufficient`: too few independent event dates or incomplete outcome windows; not zero, failure, or neutral evidence.
- `matured`: complete predeclared event and matched-control windows are available.
- Market closure and unsettled control do not count as missing producer failures before the official schedule permits certification.

## 7. Files that may be touched after approval

- `features/election-policy-shadow/FEATURE_ARCHITECTURE.md` and an implementation-result record.
- `lib/events/vocabulary.ts`, event ingestion/maturation, and focused tests.
- A new additive migration only if structured fields cannot be represented safely using the existing ledger; `docs/arch/04-database-schema.md` must be updated if so.
- `app/api/markets/policy-events/route.ts`, its existing Markets component, and existing Learning event-study surface only as required.
- `docs/arch/09-learning-loop.md`, `docs/arch/03-agents.md` only if producer ownership changes, `PROJECT_DECISIONS.md`, and `WORK_LOG.md`.

## 8. Risks and decisions needed

- Party control alone is a weak and confounded predictor; the feature must center on policy content, surprise, implementation, earnings/rates context, and measured cross-asset response.
- Resolved: the owner approved an additive, service-only context/exposure migration; see `20261104150000_policy_impact_event_context.sql`.
- Reliable, licensed pre-election expectations may not be available without paid access; the first release must work honestly without them.
- Historical backfill is limited to events whose public timestamp and outcome status can be independently sourced.
- Sector labels do not capture company-level revenue or cost exposure. No stock-specific claim is valid without point-in-time issuer exposure evidence.
- No change to the existing decision that shorts are outside the live trading scope. Researching downside exposure is not authorization to short.

## 9. Acceptance criteria

- Official result/policy facts retain source URL, public timestamp, first-seen timestamp, status, and immutable source evidence.
- Provisional and certified results are never conflated; missing source data is visible and never recorded as neutral.
- Event studies use only information and price observations available after the recorded public event time, with complete windows and matched benchmark dates.
- Counts reflect event dates, not the number of same-event symbols; tested families/horizons and limitations are shown.
- Election/policy evidence is visible in Markets and Learning but has zero readers in composite scoring, LLM council prompts, paper/live trading, or execution.
- No new API, database write path, source integration, schedule, paid service, or model inference is added without approval of the concrete design and any required access/source decision.

## 10. Approval and implementation boundary

Owner approved implementation with “go ahead and build” on 2026-11-04. The implementation uses the US-only, measure-only design above. Structured event metadata and exposure provenance use an additive migration. Ingestion is cited owner entry because no free, unified, certified US election-and-policy feed is in the approved source set. Existing natural event maturation derives outcomes from stored daily-return evidence; it issues no extra market-data request for these events. No new provider, paid service, schedule, model inference, score input, or trading behavior is included.
