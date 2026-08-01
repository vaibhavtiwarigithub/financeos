# Exogenous Risk Evidence Layer

> Status: **P0 FOUNDATION BUILT; P1-P3 INGESTION NOT YET ENABLED.**
> Date: 2026-07-26
> Owner approval: observation-first build approved 2026-08-01. No scoring, paper,
> live, exit, sizing, or broker activation is approved.

## 1. Decision

Build one canonical, point-in-time evidence layer for facts that affect markets
but do not belong to a company's fundamental, technical, insider, or ordinary
news-sentiment score.

The layer has three deliberately separate classes:

1. **Domestic regimes** — US macro/Fed and India macro/RBI.
2. **Global spillovers** — Fed impact on India, global oil, USD/INR, and
   global risk conditions.
3. **Discrete shocks** — tariffs, sanctions, supply disruptions, and conflicts.

The first releases are record-only and shadow-only. They cannot alter a score,
direction, position size, paper trade, live trade, stop, target, or broker order.
Admission to a money path requires separately measured, point-in-time,
market-and-sector-specific incremental value.

**P0 implementation (2026-08-01):** migration `20260801150000_exogenous_risk_p0`
adds the two append-only, owner-read/service-write-only ledgers described below and
removes the obsolete India Macro Read cron, which had already refused its market
before an LLM call or write. No ingestion adapter is enabled until an official source
exposes a stable, timestamped machine-readable contract. Empty ledgers are intentional
and are not treated as neutral macro evidence.

## 2. Why This Is Needed

Kairos currently has real but fragmented coverage:

| Input | Current state | Problem |
|---|---|---|
| US macro / Fed | US-only FRED MacroSentinel; FOMC ledger is record-only | Correct for the US, but cannot be reused as an India domestic regime. |
| India FII/DII | NSE factual line in the India thesis | Useful daily flow context, but not a regime and not scoreable alone. |
| Oil, gold, crypto products | Some ETFs/watchlist symbols and Markets display tiles | A visible instrument is not a validated factor or a symbol-exposure model. |
| Tariff and conflict news | May appear in per-symbol sentiment/LLM prose | No authoritative event identity, effective time, exposure mapping, or auditable impact record. |
| India macro | Explicitly unavailable in scoring | This is safer than borrowing the US regime, but leaves a genuine coverage gap. |

The bad alternative is a universal "risk score" that mixes stale CPI, a same-day
oil move, an LLM's interpretation of a conflict, and US Fed policy, then applies
it to every US and Indian symbol. That would be non-reproducible and would make
the earlier India-US macro leakage possible again.

## 3. Invariants

1. **No cross-market substitution.** India never reads a US domestic regime; the
   US never reads an India domestic regime. Global observations are explicitly
   tagged `scope=global_spillover` and have separate US/India transmission rules.
2. **Point in time.** Every observation records `observed_period`,
   `published_at`, `available_at`, source URL, source revision/vintage when
   available, and raw-payload fingerprint. A later revision never rewrites a
   value knowable at an earlier decision time.
3. **No fabricated neutral.** Missing, stale, partial, or contradictory evidence
   is `unavailable`, not a score of 50.
4. **Deterministic ingestion and math.** No LLM classifies an event, chooses a
   sector, computes a regime, or changes an exposure. LLMs may only summarize
   already persisted evidence for display.
5. **Off the money path until proven.** Research, paper, live, exits, sizing,
   allocation, and brokers do not import this layer in P0-P3.
6. **Append-only evidence.** Corrections append a new observation/supersession;
   they do not rewrite historical facts or impact calculations.
7. **Market-local accounting.** US results remain USD/SPY-or-VOO-relative;
   India results remain INR/NIFTY-relative. They are never cross-summed.

## 4. Source Policy

### 4.1 Approved primary sources

| Evidence | US | India | Cadence | Initial role |
|---|---|---|---|---|
| Domestic policy rate / decision | Existing FRED target range + FOMC ledger | RBI MPC decision and RBI DBIE policy-rate series | Event / daily | Domestic regime evidence |
| Inflation / activity | Existing FRED series | MoSPI CPI and IIP releases | Monthly | Domestic regime evidence |
| Rates / financial conditions | Existing Treasury/FRED series | RBI DBIE 10Y G-Sec, policy corridor, liquidity, INR/USD | Daily/monthly | Domestic regime evidence |
| Portfolio flows | Existing US risk indicators only | NSE FII/DII; SEBI/NSDL reference fallback | Daily | India flow overlay |
| Oil | EIA Brent/WTI | PPAC Indian Basket, with EIA Brent as global comparator | Daily/weekly | Global spillover |
| Official trade actions | USTR / Federal Register | Indian Ministry of Commerce / DGFT notices when a machine-readable, timestamped source is proven | Event | Discrete-event ledger |

The primary India authority is RBI DBIE for monetary/financial series and MoSPI
for CPI/IIP. NSE FII/DII is not promoted into a domestic regime by itself.

### 4.2 Explicitly deferred or prohibited sources

- Do not scrape CME FedWatch, news pages, social posts, or an RBI page to invent
  a market-implied policy expectation. A future expectation adapter needs a
  lawful, timestamped, pre-decision source.
- Do not use Yahoo, TradingView, a crypto exchange, or a chart tile as the
  authoritative macro source. They may be display/fallback sources only after
  a separate source-policy approval.
- Do not use a general LLM, GDELT tone, or arbitrary headlines to produce a
  tariff/war severity score.
- Gold:silver ratio, crypto breadth, and generic geopolitical sentiment are not
  P0 inputs. They are hypothesis candidates only after the core evidence layer
  works.

## 5. Canonical Data Contracts

The implementation must extend the existing evidence/provenance conventions,
not create a disconnected second audit system. It should reference existing
`evidence_records`, `provider_call_ledger`, `evidence_cache_v2`, frozen
`symbol_daily_returns`, and the US `policy_rate_events` ledger by stable IDs or
fingerprints.

### 5.1 `exogenous_observations`

Append-only raw facts, one record per source observation/vintage:

```ts
type ExogenousObservation = {
  id: string;
  market: "us" | "india" | "global";
  scope: "domestic" | "global_spillover";
  seriesKey: string; // e.g. india.cpi_combined_yoy, global.brent_usd
  value: number | null;
  unit: string;
  observedPeriod: string;
  publishedAt: string;
  availableAt: string;
  source: string;
  sourceUrl: string;
  sourceRevision: string | null;
  payloadFingerprint: string;
  quality: "fresh" | "stale" | "partial" | "unavailable";
};
```

No data consumer receives a naked number without its availability and as-of
metadata. Source cache keys must include the source, series, market, period, and
revision identity.

### 5.2 `market_regime_runs`

Immutable output of a versioned deterministic regime function. It must have a
`market` column from day one. This is the eventual replacement for reading the
unmarketed legacy US `macro_regime` table; it does **not** modify that table in
the first phase.

```ts
type MarketRegimeRun = {
  id: string;
  market: "us" | "india";
  domesticState: "supportive" | "neutral" | "adverse" | "unavailable";
  globalSpilloverState: "supportive" | "neutral" | "adverse" | "unavailable";
  formulaVersion: string;
  inputFingerprint: string;
  computedAt: string;
  eligibleInputCount: number;
};
```

Domestic and global states are separate fields. They must never be added into a
single value without a validated formula version.

### 5.3 `exogenous_events` and `event_impact_observations`

An event carries an authoritative source, effective time, affected jurisdictions,
and a bounded taxonomy (`policy_rate`, `tariff`, `sanction`, `supply_disruption`).
It does not store a model-generated severity or inferred symbol list. A separate,
versioned exposure map may connect a **verified** event class to sectors or
instruments. Impact rows calculate 1/5/20 session raw and same-market benchmark
excess returns only from frozen return evidence.

Existing FOMC tables remain the authoritative US policy implementation. A later
adapter links them to this common contract rather than copying or rewriting them.

## 6. Transmission Maps

There is no valid all-symbol response to oil, Fed, tariffs, or war. Every future
mapping must be versioned, deterministic, and conservative:

| Driver | US examples | India examples | Rule before admission |
|---|---|---|---|
| Fed / US yields | long-duration technology, banks, REITs | FPI-sensitive financials, INR-sensitive importers/exporters | Measure separately by market and sector. |
| Oil rise | energy producers/refiners may benefit; airlines may suffer | upstream producers may benefit; airlines, chemicals, OMCs may suffer | Require the instrument registry/exposure tags; unknown exposure means no effect. |
| INR depreciation | US domestic impact usually none | exporters and import-dependent firms differ | Use RBI exchange evidence and a reviewed tag, never a ticker-name heuristic. |
| Tariff | importer/exporter and supply-chain effects differ | India exporter/importer effects differ | Only an explicit, reviewed exposure link can produce a hypothesis. |
| Crypto move | crypto ETFs, miners, exchanges | no general India equity effect assumed | Apply only to explicitly classified crypto exposures. |
| Gold:silver ratio | no default equity implication | no default India equity implication | Research-only until an IC study clears. |

## 7. Phased Build Order

### P0 — Truth and observability (2-3 engineering days)

1. Publish a source capability matrix: authority, cadence, expected delay,
   allowed use, fallback, staleness limit, and API quota/cost.
2. Add System Health checks for source freshness and observation coverage, not
   one alert per missing symbol.
3. Audit and relabel existing Markets tiles as `display-only` where appropriate.
4. Remove the now-harmless `macro-read-india` no-op cron after verifying no
   consumer depends on it.

Acceptance: the UI and health surface distinguish `not built`, `unavailable`,
`stale`, and `display-only`; no money-path import changes.

### P1 — India domestic macro shadow (5-7 engineering days)

1. Implement server-only official adapters for RBI DBIE and MoSPI. Start with
   repo rate, 10Y G-Sec, INR/USD, CPI Combined YoY, and IIP growth.
2. Persist release vintages in `exogenous_observations`; capture source release
   time rather than using fetch time as a fake release time.
3. Add daily frozen NSE FII/DII snapshots with source date, bounded stale policy,
   and no accidental reuse of the `gdelt` provider identity.
4. Compute an India domestic regime in `market_regime_runs`, shadow-only.
5. Compare regime outputs to NIFTY/sector outcomes by released-data time, with
   no score or trade effect.

Acceptance: an India run can be reproduced using only observations available at
that run's `computedAt`; a failed source yields `unavailable`, not calm; the US
path cannot query India records and vice versa.

### P2 — Global spillover evidence for both markets (4-6 engineering days)

1. Link the existing FOMC outcome ledger to the evidence contract; do not
   duplicate its event or impact records.
2. Add Fed-to-India as a separate global-spillover observation, never an India
   domestic-policy observation.
3. Add Brent/WTI from EIA for the US and the PPAC Indian Basket for India.
4. Add a versioned, read-only oil/FX/FPI exposure hypothesis map that defaults
   to no mapping for unknown symbols.
5. Record per-sector, per-market impact observations from frozen returns.

Acceptance: a Fed shock can be shown as global context for India while the India
domestic regime remains unchanged; all displayed effects state their source and
as-of time.

### P3 — Discrete-event ledger (5-8 engineering days)

1. Implement an event ledger for a small authoritative taxonomy only.
2. Ingest USTR/Federal Register trade actions and a separately validated Indian
   official trade-notice source. Start with policy/tariff events, not wars.
3. Permit an owner-reviewed event record for conflicts/supply disruption when
   an official source and effective timestamp exist. The application must not
   auto-infer an event from news sentiment.
4. Record impacts and candidate sector hypotheses; display them as observation,
   not trade recommendations.

Acceptance: every event has a source URL and effective/known-at time; a missing
exposure link cannot suppress or promote a symbol.

### P4 — Hypothesis evaluation (minimum 8-12 weeks of new evidence; no fixed
calendar promise)

1. Use the existing point-in-time replay, Edge IC, FDR, and walk-forward
   infrastructure to test each *one* hypothesis separately.
2. Require adequate event count, market/sector sample floor, post-cost result,
   stability across windows, and no worse drawdown/turnover than the baseline.
3. Promote at most one validated, narrow use at a time: initially a subtractive
   `long -> neutral` eligibility guard in paper shadow. Never promote an event
   feature that directly creates a buy, exits a holding, or widens risk limits.
4. Require an owner sign-off and a reversible feature flag before paper action;
   live remains disabled pending a separate approval.

The key constraint is data time, not coding time. CPI/IIP and RBI decisions are
monthly/event-driven, so reliable validation cannot be compressed into a week.

## 8. Explicit Deferrals

- **Gold:silver ratio:** add only as a shadow Edge-lab factor after P2. It has no
  default portfolio action because its equity relationship is regime dependent.
- **Crypto macro factor:** add only for instruments classified as crypto exposure;
  a broad US/India equity penalty is unsupported.
- **War score:** do not build one. Record verified events and their observed
  impacts; the product must not pretend it can quantify an unfolding conflict.
- **Policy expectations:** retain `unavailable` until a lawful pre-decision feed
  is selected. Official outcomes cannot reconstruct prior market expectations.
- **Live usage:** completely out of scope.

## 9. Safety, Security, and Rollback

- All ingestion routes are server/cron-only and owner-triggerable; browser code
  reads a redacted, owner-authenticated projection only.
- New evidence and impact tables use RLS deny-by-default, no anon grants,
  service-role-only writers, append-only triggers, indexes on
  `(market, series_key, available_at)` and event/impact keys.
- Raw payloads are bounded, schema-validated, and fingerprinted; no cookies,
  headers, tokens, or arbitrary fetched HTML enter the database or UI.
- Every phase has a feature flag whose disabled state leaves today's US macro,
  India scoring, paper, live, and exit behavior byte-for-byte unchanged.
- Rollback disables readers/jobs; it never deletes evidence or rewrites past
  signals/trades.

## 10. Validation Plan

1. Adapter fixtures: normal release, revision, late release, malformed payload,
   source throttle, stale fallback, duplicate fingerprint, and unavailable.
2. Boundary tests: US consumers cannot access India domestic observations;
   India cannot access US domestic observations; global observations cannot be
   mislabeled as domestic.
3. PIT replay tests: a value published after `as_of` is rejected even when its
   observation period is earlier.
4. Falsification tests: unknown symbol exposure, absent benchmark, missing
   expected policy rate, incomplete return horizon, and missing source must all
   leave scores/directions/orders unchanged.
5. Production proof before any promotion: write fresh source rows, then verify
   their as-of metadata, regime run fingerprints, market isolation, and a UI
   projection with no provider URL/token leakage.

## 11. Decision Record

- **Why:** The user needs auditable macro and event context across both books
  without mixing USD/INR, importing unreliable news judgement, or spending
  research-provider quota.
- **Who:** Vaibhav operating separate US and India paper/live portfolios.
- **ROI:** Better diagnosis and future evidence-backed risk gating; no promised
  alpha until the layer passes the existing validation process.
- **Build decision:** **GO for P0-P3 record/shadow architecture; DEFER all score,
  paper, live, exit, gold/silver, crypto, and war-score admission.**

## 12. References

- RBI DBIE: https://dbieold.rbi.org.in/DBIE/
- MoSPI release calendar: https://mospi.gov.in/sites/default/files/Advance_Release_Calendar.pdf
- SEBI FPI source index: https://www.sebi.gov.in/curation/fpi.html
- RBI MPC schedule: https://www.rbi.org.in/scripts/PublicationsView.aspx?id=23139
- EIA oil data: https://www.eia.gov/dnav/pet/pet_pri_spt_s1_w.htm
- PPAC Indian Basket: https://ppac.gov.in/index.php/prices/international-prices-of-crude-oil
- USTR Section 301 source: https://ustr.gov/issue-areas/enforcement/section-301-investigations
