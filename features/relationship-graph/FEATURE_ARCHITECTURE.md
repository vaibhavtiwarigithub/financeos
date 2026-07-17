# Relationship Graph and Cross-Company Propagation - Feature Architecture

> Status: **P0 feasibility study RUN AND FAILED. Recommendation: do not build. Design retained for the record.**
> Last updated: 2026-07-16 — P0 produced a provisional KILL; enhanced reproducibility rerun is required before final sign-off. See [`P0_COVERAGE_STUDY.md`](./P0_COVERAGE_STUDY.md).
> Previous revision: 2026-07-15 by Codex after primary-source and Kairos architecture review.
> Scope: design only. No migration, provider activation, scoring change, candidate insertion, or order path is authorized.
> Update this file when: source contracts, identity resolution, relationship schema, EdgeScout integration, validation gates, or money-path boundaries change.

## 0. P0 outcome (2026-07-16) — measured, not estimated

The P0 study §11 authorized was run against live SEC EDGAR over Kairos's real US universe
(92 US non-ETF symbols → **79 domestic 10-K filers**). Full report and method:
[`P0_COVERAGE_STUDY.md`](./P0_COVERAGE_STUDY.md). Probe: `scripts/sec-customer-coverage-probe.mjs`.

| P0 exit question (§11) | Measured result |
|---|---|
| Named-customer coverage **with a revenue %** | **5 / 79 = 6.3%** (CHD, SWK, AMT, CELH, CRWV — 10 links total) |
| Named, but no usable exposure % | 2 / 79 (QCOM ≥10% floor only; BX $-denominated, non-traded funds) |
| Identity resolution on those 10 strings | **60% resolved**, 20% ambiguous, 20% unresolved; a silent false positive (BCRED→BX) appeared immediately |
| Point-in-time `available_at` | **Works.** `acceptanceDateTime` on 79/79, intraday-precise; amendments carry their own timestamps, so as-of is deterministic |
| Freshness | exposure weight is **~6.5 months stale at median**, up to 381 days; refreshes annually |
| Cost | **$0**, 167 requests, ~3 min, ~169 MB/year raw |

**Answer to §16 open decision 1 ("Is free disclosed-customer coverage high enough to justify P1?"): No.**

The single riskiest assumption named in §17 — whether Kairos can obtain enough point-in-time, correctly
resolved, economically weighted public relationships for its actual US universe — **failed on measurement**.
US GAAP requires the *amount* of a ≥10% customer, not the *name*, and issuers overwhelmingly take the
anonymity option on exactly the highest-exposure links (NVDA 22%, ENPH 39%, AMAT 19%, MU 17%, INTC 43%;
FFIV/FSLR/RGTI literally letter or number their customers). §5.3's caution was correct and is now evidenced.

**Recommendation: do not build P1–P5.** n=5 cannot support the §9.1 cross-sectional experiment or the §9.2
evaluation battery; it cannot even reach EdgeIC's `nObs >= 12` preliminary diagnostic. Per §17, retain the
peer-move display and stop. Revisit only if the covered universe reaches ~500+ US issuers (the falsifiable
precondition derived in the study); re-running the probe then costs three minutes.

## 1. Review verdict

The product idea is valid: economically linked firms can transmit information slowly, and
customer returns have historically predicted supplier returns. The previous V3 document was
not build-ready, however. It made five unsafe leaps:

1. It stored a bullish/bearish `direction` on a relationship. A supplier/customer/competitor
   relationship is not intrinsically bullish or bearish; an event has a sign and a relation
   determines how that event may transmit.
2. It proposed a second provenance and learning system instead of reusing Kairos's Canonical
   Evidence Router, `evidence_records`, `edge_*` lab, research queue, and decision ledger.
3. It treated Finnhub peers as economic links. Similar-company peers are display context, not
   verified customer, supplier, or competitor relationships.
4. It overstated free data coverage. Public filings do not guarantee that every major customer
   is named, and FinancialDatasets segmented financials describe product/business segments,
   not a complete customer-supplier graph.
5. It elevated two very recent arXiv preprints into a production recommendation. They are
   useful hypotheses, not sufficient evidence to ship embedding propagation into Kairos.

**Correct product decision:** do not build a general LLM relationship graph first. Start with a
narrow, falsifiable, US-only, measure-only **disclosed customer momentum** experiment inside the
existing Edge/Factor lab. Add graph extraction, event propagation, candidate discovery, or model
embeddings only after each earlier layer proves coverage and out-of-sample incremental value.

## 2. Product purpose

The feature should eventually answer four distinct questions without presenting speculation as
fact:

1. **Relationship:** What verified economic relationship exists between two issuers?
2. **Exposure:** How economically important is that relationship, and to which party?
3. **Event:** What point-in-time event or return shock occurred at the leading issuer?
4. **Measured implication:** Has Kairos observed that this relation/event type predicts the
   linked issuer in the target market and horizon after costs?

The user-facing output must keep those layers separate. A relationship card may say:

> Supplier A disclosed Customer B as 18% of revenue in its 10-K filed on date D.
> Customer B rose 7% over the last 20 sessions. Kairos is measuring whether similar links
> predict Supplier A; this is not a recommendation.

It must not say "Supplier A will rise" merely because an LLM extracted a link.

## 3. Non-negotiable boundaries

- **No LLM on the money path.** An LLM may propose an entity/link assertion from bounded,
  sanitized filing text. It cannot set a score, direction, threshold, position size, order,
  long suppression, or exit.
- **No relationship output affects trading in P0-P3.** It is display-only or measure-only.
- **No direct hedge integration.** The governed downside hedge is a portfolio-level US market
  overlay. A bearish company relationship must never activate or size `SH`/`PSQ`.
- **No automatic shorting.** Negative observations remain research evidence. Kairos remains
  long-only for new single-name positions.
- **No competitor or peer inference from a provider list.** `symbol_profiles.peers` and the
  shipped peer-move strip remain context-only and outside this graph.
- **No parallel provenance store.** Provider acquisition uses the Canonical Evidence Router;
  decision evidence links to existing evidence and provider ledgers.
- **No auto-promotion.** Passing an EdgeIC measurement does not alter the Champion, scorer, P(win),
  sizing, candidate priority, or live eligibility. Any use requires a separately approved,
  validated Challenger or feature-registry change.
- **Per-target-market activation.** US and India measurements, validation, configuration, and
  promotion remain independent. Currency amounts are never cross-summed.
- **Fail closed on ambiguity.** Unresolved issuer identity, missing source availability time,
  stale relationships, missing exposure basis, or conflicting assertions produce no signal.

## 4. Existing Kairos systems to reuse

This feature extends existing architecture; it must not replace it.

| Concern | Canonical Kairos owner | Required integration |
|---|---|---|
| Provider choice, pacing, caching, source provenance | `lib/evidence/*`, `EvidenceEnvelope`, evidence policy/cache/call ledger | Add relationship/filing intents only through a reviewed Router contract; no direct provider calls in graph logic |
| Decision evidence | `evidence_records`, append-only `decision_observations` | Store IDs/hashes that identify the exact inputs known at decision time; never copy a second ungoverned evidence blob |
| Factor measurement | `edge_catalog`, `edge_signals`, `edge_signal_inputs`, `edge_ic_history` | Register graph-derived measurements as versioned edges and use EdgeScout/EdgeIC lifecycle |
| Candidate backlog | `research_queue` and ResearchAgent discovery attribution | Only a later approved phase may enqueue a linked issuer; no private queue |
| Outcome labels | `decision_observations` x `observation_labels` | Use for candidate-source evaluation only after candidate discovery exists; do not invent another outcome table |
| Strategy governance | Feature Registry, Validation Engine, Shadow, Champion/Challenger | Required before any measured edge can influence a score or eligibility |
| Display-only peers | `symbol_profiles.peers`, peer-move MVP | Remains separate and cannot seed verified graph edges |

The current `DiscoverySource` union does not include `relationship_graph`. That is intentional.
It is added only when P3 candidate-shadow architecture is separately approved.

## 5. What the research supports - and does not support

### 5.1 Peer-reviewed prior: customer momentum

Cohen and Frazzini (2008), *Economic Links and Predictable Returns*, supports a narrow claim:
publicly disclosed customer returns predicted subsequent supplier returns in their historical
sample. Their customer return was sales-weighted, their portfolios were formed monthly, and the
reported drift persisted beyond the initial customer shock.

This supports testing a **sales-weighted customer-return factor**. It does not prove that:

- every partnership, competitor, or co-mention edge predicts returns;
- an arbitrary 8-K has a mechanically knowable sign for every neighbor;
- a 1-day or 5-day Kairos implementation retains the historical edge after costs;
- the effect works unchanged in today's large-cap universe or in India; or
- an LLM-extracted graph is superior to disclosed customer links.

Primary source: [Cohen and Frazzini, Journal of Finance (2008)](https://pages.stern.nyu.edu/~afrazzin/pdf/Economic%20Links%20and%20Predictable%20Returns%20-%20Cohen%20and%20Frazzini.pdf).

### 5.2 Recent preprints: hypothesis grade only

- [Supply Chain Propagation of Textual Signals (arXiv:2606.29290)](https://arxiv.org/abs/2606.29290)
  reports promising results for FinBERT/graph-propagated 10-K features, but it is a June 2026
  single-author preprint using 255 S&P 500 firms over 2011-2025. It is not an independently
  replicated production standard.
- [Cross-Stock Predictability via LLM-Augmented Semantic Networks (arXiv:2604.19476)](https://arxiv.org/abs/2604.19476)
  reports that LLM edge filtering improved a historical long-short result on S&P 500 constituents
  from 2011-2019. The abstract does not establish point-in-time constituent handling,
  implementation costs, or suitability for Kairos's long-only books.

Therefore embedding propagation is an **offline research candidate**, not the P1 implementation.
It must prove incremental out-of-sample value over the simple disclosed-customer baseline after
costs and multiple-testing correction.

### 5.3 Disclosure reality

SEC EDGAR is free and official, and current filing metadata/XBRL APIs require no API key. SEC
fair-access guidance currently caps automated access at 10 requests/second and requires a declared
user agent. That is a ceiling, not a service-level guarantee or an unlimited quota.

Major-customer disclosures are incomplete for graph construction:

- US GAAP can require disclosure that a customer contributes 10% or more of revenue and the
  amount/segment, but customer identity is not always required.
- Regulation S-K was modernized in 2020 into a more principles-based business-description rule.
  Kairos must not assume every 10% customer is named.
- FinancialDatasets `segmented_financials` exposes product/business segment revenue. It is not
  proof of customer identity or customer-level revenue exposure.

Source contracts are therefore capability-probed and coverage-measured before architecture
approval. Missing identity/exposure is `unavailable`, never guessed.

Primary sources: [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces),
[SEC developer fair-access guidance](https://www.sec.gov/about/developer-resources), and
[SEC 2020 Regulation S-K modernization](https://www.sec.gov/rules-regulations/2020/08/modernization-regulation-s-k-items-101-103-105).

## 6. Correct conceptual model

### 6.1 Issuers are not ticker symbols

Graph nodes represent legal issuers, not ticker text. A separate point-in-time mapping connects an
issuer to one or more tradable instruments. This prevents symbol changes, share classes, ADRs,
cross-listings, delistings, and duplicate economic exposure from corrupting the graph.

Minimum identity keys:

- US issuer: CIK plus normalized legal name; LEI when available.
- India issuer: reviewed exchange/company identifier from an approved NSE/BSE/SEBI source.
- Tradable instrument: `(market, exchange, symbol, currency, valid_from, valid_to, is_primary)`.

An LLM may return a name mention. A deterministic resolver must map it to exactly one issuer and
instrument. Zero or multiple matches are quarantined.

### 6.2 Relationships are neutral assertions

A durable assertion describes an economic fact:

- supplier supplies customer;
- customer buys from supplier;
- parties have a material partnership/JV; or
- an issuer disclosed material dependence on another issuer.

The assertion stores no bullish/bearish direction. It separately records:

- relation type and orientation;
- exposure percentage and whose revenue/cost basis it describes;
- extraction quality and verification state;
- economic-validity interval (`valid_from`, `valid_to`); and
- knowledge-time fields (`source_published_at`, `available_at`, `retrieved_at`).

### 6.3 Events and propagation observations are separate

An event or leading-company return shock is a time-stamped observation. A propagation measurement
joins an event/return to relationships that were known and economically valid **before** the target
decision timestamp.

Conceptually:

```text
leading input (customer return or validated event)
  x economic exposure
  x relationship verification quality
  x age/validity rule
  = measure-only propagation raw value
```

This is not an analyst score. Cross-sectional normalization and forward-return evaluation remain
in the Edge/Factor lab.

## 7. Proposed data architecture

These tables are proposals only. A future implementation requires an approved migration plan and
live-schema verification.

### 7.1 `issuer_entities`

Stable legal entities.

| Column | Purpose |
|---|---|
| `issuer_id` | UUID primary key |
| `legal_name`, `country` | Reviewed identity |
| `cik`, `lei`, `india_company_id` | Nullable unique external identifiers |
| `identity_status` | `verified`, `ambiguous`, `retired` |
| `created_at` | System time |

### 7.2 `issuer_instruments`

Bitemporal issuer-to-security map.

| Column | Purpose |
|---|---|
| `issuer_id` | FK to issuer |
| `market`, `exchange`, `symbol`, `currency` | Tradable identity; market and currency always explicit |
| `valid_from`, `valid_to` | When the mapping was economically true |
| `available_at`, `retrieved_at` | When Kairos could know it |
| `is_primary` | Prevent duplicate ADR/share-class candidate emission |

### 7.3 `relationship_assertions`

Append-only facts, not mutable current-state rows.

| Column | Purpose |
|---|---|
| `assertion_id` | UUID primary key |
| `subject_issuer_id`, `object_issuer_id` | Oriented issuer pair |
| `relation_type` | Narrow grammatical enum; start with `supplier_to_customer` (subject is supplier, object is customer) |
| `exposure_pct`, `exposure_basis`, `exposure_period_end` | Nullable; never mix revenue and cost exposure |
| `valid_from`, `valid_to` | Economic validity interval |
| `source_published_at`, `available_at`, `retrieved_at` | Point-in-time availability |
| `evidence_record_id`, `router_policy_version_id`, `payload_hash` | Links canonical Kairos provenance; no ad hoc `evidence_ref` blob |
| `source_locator`, `source_span_hash` | Accession/document/section and hash of the cited bounded span |
| `extractor_version`, `schema_version` | Reproducibility |
| `assertion_action` | `assert` or `retract`; an accepted retraction ends a prior assertion without mutating it |
| `verification_status` | `proposed`, `accepted`, `rejected` |
| `supersedes_assertion_id` | Corrections add rows; UPDATE/DELETE remains blocked |
| `created_at` | System time |

A deterministic current/as-of view resolves the accepted assert/retract supersession chain. An old
row remains historically accepted; the later accepted row determines current state without rewriting
history. Raw LLM confidence is not stored as economic truth. Verification confidence is derived from
objective checks such as identity uniqueness, source class, citation-span match, and numeric exposure
extraction.

### 7.4 Reuse `edge_*` tables for measurements

Do not add a `propagation_signals` truth layer. Register, for example:

```text
edge_id: customer_momentum_sales_weighted_v1
input: trailing customer return known at t + accepted customer relationship known at t
raw_value: sum(exposure_weight_j * customer_return_j)
expected_sign: +1
default lookback: 20 trading sessions
evaluation horizons: 5, 10, 20 trading sessions
```

Write values to `edge_signals`; write relationship assertion IDs, price evidence references,
availability timestamps, and adjustment policy to `edge_signal_inputs`; write evaluation to
`edge_ic_history`. A missing exposure produces unavailable for the sales-weighted edge. An
unweighted variant, if tested, is a separate edge ID and therefore a separate statistical trial.

## 8. Acquisition and extraction pipeline

### 8.1 Router-owned acquisition

Before build, define and review narrow Router intents such as:

- `filings.document`
- `relationships.disclosed`

The Router owns provider policy, cache, pacing, freshness, payload hashes, capability status, and
call ledger. SEC should be the initial authoritative US source. FinancialDatasets may be a policy
option only after a live capability/entitlement probe proves the required customer-level contract.

### 8.2 Untrusted-document isolation

Filings and news are untrusted text even when hosted by an official source.

- Strip scripts, active content, hidden markup, and irrelevant exhibits.
- Bound bytes, tokens, nesting, entities, and output tuples.
- The extraction model gets no tools, network, shell, credentials, memory writes, or order APIs.
- Treat instructions inside documents as data, never system instructions.
- Require strict schema validation, an exact source locator, and a supporting span hash.
- Reject unknown relation enums, self-links, unresolved entities, future timestamps, invalid
  percentages, and output not grounded in the supplied span.
- Store model/prompt/schema versions for reproducibility.

### 8.3 Verification state machine

```text
raw document
  -> proposed assertion (untrusted extraction)
  -> deterministic identity/source/numeric checks
  -> accepted OR rejected
  -> later filing may append a superseding assertion
```

Only accepted assertions enter display or EdgeScout. P0 should include owner review because the
covered universe is small and the cost of a false link is high. Automation can be reconsidered
after precision is measured against a labeled fixture set.

## 9. Statistical and trading correctness

### 9.1 Pre-register the first experiment

The first trial is only `customer_momentum_sales_weighted_v1`:

- US primary common equities only;
- accepted disclosed customer relationships only;
- relationship and instrument mapping available before the as-of timestamp;
- 20-session customer return, evaluated at 5/10/20-session supplier horizons;
- benchmark-neutral and raw target returns both retained;
- split/dividend-adjusted prices with explicit availability and adjustment policy;
- no parameter search selecting the best lookback after seeing results.

Other relation types, unweighted links, event semantics, embeddings, neutralization schemes, and
horizons are separate registered trials. They increase the trial-family count used by DSR/PBO/FDR
governance; they are not silent variants of one factor.

### 9.2 Long-only decision metric

Cohen-Frazzini and both recent preprints emphasize long-short portfolios. Kairos is long-only for
new names, so a long-short Sharpe cannot authorize adoption. Required evaluation includes:

- top-bucket long-only benchmark-relative return after modeled costs;
- hit rate, drawdown, turnover, capacity, and sector concentration;
- rank IC/ICIR with overlapping-horizon correction;
- stability across time, sectors, issuer size, and relationship age;
- comparison with ordinary momentum to prove incremental value; and
- explicit unavailable/coverage rates so sparse disclosure is not mistaken for selectivity.

The existing EdgeIC `nObs >= 12` classifier is a preliminary measure-only diagnostic, not a
production promotion gate for this new sparse/data-mined family. Promotion must use the canonical
Edge/Factor plus Advanced Learning governance and cannot be weaker than its multiple-testing,
walk-forward, sample-floor, cost, and owner-approval rules.

### 9.3 No immediate candidate or score effect

Even a promising measurement remains in `edge_*`. To affect ResearchAgent later, a separate design
must choose exactly one governed route:

1. **Discovery route:** enqueue a linked issuer for normal deterministic scoring, with no score
   bonus; or
2. **Feature route:** log a normalized relationship feature in the point-in-time decision snapshot,
   then promote it only through Feature Registry + Challenger validation.

It must not do both in one experiment, because selection and score effects would become
inseparable. Long-candidate suppression is also a money-path change and requires the same gates.

## 10. Market and session isolation

### Initial scope

- P0-P2 are US-only. India is `not_applicable`, not silently empty.
- India requires a separately validated official filing/entity source and its own coverage study.
- Yahoo/Finnhub peer lists cannot substitute for Indian economic relationships.

### Cross-market relationships

The graph may eventually represent a real US-customer/India-supplier relationship, but it does not
cross-sum books or currencies. The propagation observation belongs to the **target instrument's**
market, currency, mandate, benchmark, calendar, and owner controls.

Cross-market evaluation must prove `available_at <= target_decision_ts` using both exchange
calendars and time zones. An event released after the target market closed cannot be treated as
known for that session. ADR and local shares are one issuer with multiple instruments; candidate
deduplication selects the configured primary instrument per market.

## 11. Phased build order and rollback

### P0 - source and identity feasibility, display fixtures only

1. Live-probe SEC and any optional provider contract on 25-50 representative US issuers.
2. Measure named-customer coverage, exposure coverage, entity-match precision, and conflicting
   disclosure rate.
3. Build a reviewed fixture set with positive, absent, ambiguous, superseded, and prompt-injection
   cases.
4. Exit criterion: documented coverage plus high-precision entity/assertion verification. If the
   free data is too sparse, stop. Sparse is an acceptable result.

No graph table, candidate, score, or LLM cron is required merely to run the feasibility probe.

### P1 - accepted relationship ledger and read-only display

Add issuer/instrument/assertion storage behind `relationship_graph_enabled=false`. Display only
accepted disclosed customer links with source, exposure basis, age, and "not a recommendation".
No competitor seeding and no propagation.

### P2 - customer momentum in the existing Edge lab

Compute `customer_momentum_sales_weighted_v1` into `edge_*`, measure-only. The Edge dashboard shows
coverage and caveats. It cannot write `agent_signals`, `research_queue`, `decision_observations`,
paper positions, proposals, or orders.

### P3 - candidate shadow, only after P2 evidence

If P2 passes its pre-registered tests, design a separate candidate-discovery shadow. It records
which target names would have been added, but does not add them to ResearchAgent. Compare their
normal deterministic outcomes with the existing universe.

### P4 - separately approved paper integration

Only after P3 prospective evidence and owner approval may one route from Section 9.3 become a
validated Challenger. Start US paper-only and OFF. Live remains a later, separate decision.

### P5 - optional embedding/LLM network experiment

Run only as an isolated offline experiment after the simple baseline exists. It must beat the
baseline out of sample after costs and trial correction. Model artifacts are pinned and hashed;
provider/model updates create a new trial, never silently replace the old one.

### Disable/rollback

Each phase has an independent per-market flag. Disabling stops new acquisition, extraction,
measurement, or candidate shadow while preserving immutable evidence and results. A rollback never
deletes or rewrites history.

## 12. Security, operational, and cost controls

- RLS on every new public table; no `anon` access; owner read only where UI needs it; service-role
  writes; fixed `search_path` and service-role-only grants for any SECURITY DEFINER RPC.
- Append-only assertion and evaluation ledgers reject UPDATE/DELETE. Corrections append a
  superseding row.
- Bounded extraction batch, wall-clock limit, per-document size cap, retry cap, dead-letter state,
  and health alert aggregation.
- SEC requests use a declared contact user agent, shared pacing, conditional caching, and the
  Router ledger. Stay materially below the SEC's maximum access rate.
- No source is described as unlimited. Unknown quota/entitlement remains unknown.
- No raw filing body, model prompt, provider error, URL query credential, token, or service key is
  written to logs.
- Data retention distinguishes small immutable source-span hashes from large cached filing bodies;
  large bodies receive an explicit TTL and storage budget.
- Provider, parser, prompt, model, schema, and policy versions are pinned in every extraction run.

## 13. Product UX requirements

The eventual UI is evidence-first and novice-readable:

- **Verified relationship:** issuer names, relation orientation, exposure and basis if known.
- **Source and age:** filing type, accession/link, filed date, relationship validity.
- **What happened:** leading return/event and the exact as-of time.
- **System posture:** `display only`, `measuring`, `shadow candidate`, or later governed state.
- **Confidence honesty:** use `verified`, `ambiguous`, `stale`, `conflicting`, or `unavailable`;
  never render an LLM's self-assigned confidence percentage.
- **No recommendation language** before an approved integration phase.

The UI must not collapse "peer", "supplier", "customer", "partner", and "competitor" into one
generic related-stock list.

## 14. Required tests for any future build

### Identity and temporal correctness

- Symbol rename/share-class/ADR mappings resolve to the correct issuer as of date.
- Ambiguous company names and private/unlisted entities quarantine rather than guess.
- Assertions unavailable at the target decision time cannot enter a signal.
- Superseded relationships remain historically queryable but disappear from later as-of views.
- Cross-market session/time-zone tests prevent look-ahead.

### Extraction and security

- Prompt instructions embedded in filing text cannot alter schema or invoke tools.
- Output without an exact source span, valid locator, and unique entity match is rejected.
- Percentages above 100, mixed exposure bases, self-links, unknown enums, and future dates reject.
- Parser/model/version changes create distinct artifacts and do not rewrite assertions.

### Statistical honesty

- Sales-weighted formula matches a fixed fixture exactly.
- Missing exposure yields unavailable rather than zero/equal-weight substitution.
- Each alternate parameter/model is counted as a distinct trial.
- Point-in-time universe, price adjustment, costs, and benchmark are reproducible.
- Long-only results are reported alongside IC/long-short diagnostics.
- Ordinary momentum comparison identifies whether the graph adds incremental information.

### Boundary tests

- P0-P2 imports cannot reach `agent_signals`, `research_queue`, PaperTrader, PositionMonitor,
  TraderAgent, broker adapters, hedge controller, or execution gateway.
- Relationship flags default OFF independently by market and phase.
- A disabled or unavailable provider produces no fabricated relationship or signal.
- No graph value changes scoring, entry eligibility, P(win), sizing, exit, or orders without a
  separately approved and validated strategy version.

## 15. Acceptance criteria for architecture approval

Before implementation is approved, the owner/reviewer should require:

1. P0 coverage evidence from live free sources, not provider marketing or memory.
2. A canonical Router intent/adapter contract and point-in-time provenance mapping.
3. A reviewed issuer/entity-resolution contract.
4. A fixed initial edge specification and trial-family registration.
5. Explicit proof that the build extends `edge_*` and existing evidence ledgers.
6. Separate US and India applicability; India may remain unsupported.
7. A no-money-path import test and flags OFF by default.
8. A cost/storage/cadence estimate that fits current free-cloud budgets.

## 16. Open decisions

1. ~~Is free disclosed-customer coverage high enough to justify P1?~~ **ANSWERED 2026-07-16: No — 5/79
   filers (6.3%) yield a named customer with a revenue share. See §0 and `P0_COVERAGE_STUDY.md`.**
   Decisions 2-6 below are now moot unless the revisit precondition (~500+ covered US issuers) is met.
2. Should accepted assertions require owner review indefinitely, or only until fixture precision
   clears a pre-registered threshold?
3. Should the first later integration be candidate discovery or a logged feature? Do not combine
   both.
4. What minimum prospective calendar span and independent cross-sections are required beyond the
   current preliminary EdgeIC classifier before P3?
5. Which official India filing/entity source can provide a lawful, stable, point-in-time contract?
6. Where should bounded extraction run? Prefer the existing trusted research cron for reviewed
   filing extraction; use an isolated worker only if untrusted code/models are introduced.

## 17. Recommended decision now

Approve only **P0 feasibility research**, not implementation of the graph. Do not prioritize this
ahead of the Canonical Evidence Router cutover and first trustworthy learning-loop run. If P0 later
shows sparse named-customer coverage, retain the peer-move display and stop; Kairos should not build
a large graph whose apparent precision comes from guessed relationships.

The single riskiest assumption is not whether customer momentum once existed. It is whether Kairos
can obtain enough **point-in-time, correctly resolved, economically weighted public relationships**
for its actual US universe to measure that anomaly honestly and cheaply today.
