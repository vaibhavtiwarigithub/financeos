# P0 Coverage / Identity Feasibility Study — Disclosed Customer Links (US)

> Status: **provisional KILL; do not build.**
> Run date: 2026-07-16. Adjudication record rebuilt 2026-07-16 (second pass).
> Probe: `scripts/sec-customer-coverage-probe.mjs` (read-only, no DB writes, no money path).
> Scope: exactly the study authorized by `FEATURE_ARCHITECTURE.md` §11 (P0) and §17. No graph, no table,
> no scoring, no candidate emission, no migration was built.
>
> **Every number below is derived by `scripts/validate-p0-adjudication-manifest.mjs` from
> `P0_ADJUDICATION_MANIFEST.json`, not written by hand.** `tests/p0-adjudication-manifest.test.ts` fails
> if this document and the manifest disagree. See Appendix A.

## 0. The one question

> Can Kairos obtain point-in-time, correctly resolved, economically weighted disclosed-customer links,
> from free sources, for its actual US universe, at sufficient coverage to measure customer momentum honestly?

**Measured answer: no.** Two reasons, and they compound:

1. **Insufficient homogeneous coverage.** The pre-registered factor (FEATURE_ARCHITECTURE §9.1) needs ONE kind of economic
   relationship — a customer buying goods from a supplier — with a real exposure weight and a tradable
   counterparty. **4 of 79 covered US filers (5.1%) yield that, across 5 links.** The 79-filer universe
   produces 27 named weighted relationships in total, but they are three *different* economic
   relationships (customer revenue, market-maker order flow, tenant rent) that do not propagate alike and
   must never be summed into one factor.
2. **Structural missingness, not a parsing gap.** US GAAP (ASC 280-10-50-42) requires the **fact and
   amount** of a ≥10% customer — **not the name**. Issuers take the anonymity option, and they take it
   hardest on the highest-exposure links. Digital Realty is the exhibit: it *names* Oracle at 9.0% while
   *anonymizing* its #1 tenant at 11.7%. The name is disclosed exactly where the economics are small.

> **The prior headline of this document — "5 of 79 (6.3%) … 5 suppliers and 10 customer links" — is
> withdrawn.** It was asserted without a preserved adjudication record and it conflated three different
> relationship types under one "customer" label. It was not merely imprecise; it was differently wrong.
> The replacement numbers below are worse for the feature, not better.

## 1. Method and sample frame

**Sample frame (real, not synthetic):** Kairos's live US universe as of 2026-07-16 — `watchlist` rows not
past `expires_at`, plus `paper_positions` where `market='us' and qty>0` — mirroring the US-equity surface
of `gatherSymbols()` in `lib/research-agent.ts`. Pulled from the FinanceOS Supabase project
(`dionkikgdmlaotvtbnfr`). ETFs removed using `KNOWN_US_ETFS` (`lib/asset-classification.ts`) plus the
thematic-fund tickers present in the universe but absent from that list.

| Stage | N |
|---|---|
| Live US universe minus ETFs | **92** |
| — foreign private issuers (file 20-F/40-F, no 10-K): ARM, ASML, CRNT, EQNR, NTTYY, STM, TSM | −7 |
| — no CIK in SEC ticker map (renamed/acquired/OTC ADR): CYBR, ENN, SQ, VMW, VWDRY | −5 |
| — no 10-K in EDGAR feed: SKHYV | −1 |
| **Analyzable domestic 10-K filers** | **79** |

**Probe:** for each issuer — resolve ticker→CIK via `company_tickers.json`, take the latest `10-K` from
`data.sec.gov/submissions/CIK{cik}.json`, fetch the primary document, strip HTML, and extract candidate
customer-concentration spans. **167 requests total** (1 ticker map + 87 submissions + 79 documents) at
~0.9 req/s with a declared User-Agent — an order of magnitude under SEC's 10 req/s fair-access ceiling.

**Adjudication:** candidates are a **recall net, not a classifier**. The reviewed run used customer-
concentration, legal-suffix, and mega-cap-gazetteer nets to guard against missing a named case. This mattered: the first AMT span looked like
an aggregate-only disclosure, but reading the filing revealed a per-customer table. Regex-only
classification would have gotten AMT wrong in one direction and CELH wrong in the other.

**Audit correction (Codex, 2026-07-16):** the original committed script did not preserve the claimed
independent-net tags, source-document hashes, or the human adjudication manifest. The script now emits
all three recall-net tags, the exact sample frame + hash, accession metadata, and a SHA-256 hash of each
filing.

**Enhanced rerun:** 92/92 sample symbols processed in 202.6 seconds; sample-frame SHA-256
`b50dbd47e2161698b84c02dabb1c40c0f77eb9d6f146ca32aa887d5ab57b528e`; 79 domestic 10-Ks, 7 foreign
private issuers, 5 ticker-map misses, and 1 no-10-K case. The deliberately broad nets emitted **682
candidates** (508 customer-concentration, 133 legal-suffix, 71 mega-cap-gazetteer hits; candidates may
carry multiple tags).

**Adjudication record (2026-07-16, second pass):** all 682 candidates are now committed as
`P0_ADJUDICATION_MANIFEST.json` — one bounded record per candidate span hash, no raw filing text. Appendix A
describes the record, the two defects it corrects in the first pass, and the disagreement rate.

## 2. Coverage — of 79 filers, who discloses a NAMED counterparty with a weighted share?

**Every number in this section is recomputed by the validator from the manifest.**

### 2.1 The reconciled headline, reported separately (never summed)

| Measure | Value |
|---|---|
| Candidate spans reviewed | **682** (22 accepted, 660 rejected) |
| Filers with ANY named weighted relationship | **9 of 79 (11.4%)** — AMT, CELH, CHD, CRWV, DLR, FSLR, HOOD, QCOM, SWK |
| Total named relationships (deduplicated) | **27** |
| — span-level, before dedup | 48 |
| Resolved tradable relationships | **20** |
| Relationships ≥10% exposure | **15** (10 of them tradable) |
| Distinct suppliers represented | **9** (8 with ≥1 tradable relationship) |
| Distinct counterparties | 26 (19 tradable) |
| Exposures that are a **floor**, not a share | 5 |

**Deduplication:** relationships are counted per unique `(filer, counterparty, period, relationship_type)`.
Overlapping spans restate ONE disclosure — CHD emits **6** spans for a single Walmart link, SWK 3, CELH 3,
AMT 2, CRWV 2, QCOM 2, FSLR 2. Span-level counting inflates 27 relationships to 48. The 48 is never
reported as a relationship count.

### 2.2 By relationship type — the conflation the first pass made

These are three **materially different economic relationships**. They do not propagate like one
homogeneous signal, and no number in this study sums across them.

| `relationship_type` | Relationships | Filers | What it is |
|---|---|---|---|
| `tenant_rent` | **15** | 2 (AMT, DLR) | Counterparty leases sites/space under multi-year contracts. Revenue is contracted rent, not demand-sensitive purchasing. |
| `customer_revenue` | **10** | 6 | Counterparty buys goods/services; filer books revenue. **The only type the pre-registered factor is about.** |
| `market_maker_counterparty` | **2** | 1 (HOOD) | Counterparty pays the filer for order flow. Revenue flows the same direction, but the driver is trading volume and rebate economics, not product demand. |

By `exposure_basis` (deduplicated): `revenue` 11, `recurring_revenue` 11, `net_sales` 5. Span-level,
before dedup: `revenue` 21, `net_sales` 14, `recurring_revenue` 11, `segment_net_sales` 2.

### 2.3 The number that actually decides the feature

Filter to the homogeneous factor — `customer_revenue`, tradable counterparty, a real weight rather than a
disclosure floor, against a consolidated denominator:

| Filter | Relationships | Filers |
|---|---|---|
| `customer_revenue` | 10 | 6 |
| … resolved to a tradable US issuer | 7 | 6 |
| … **and a real weight, not a "10% or more" floor** | **5** | **4** |

**The entire usable dataset, from 79 filers:**

| Link | Exposure | Basis |
|---|---|---|
| CRWV → MSFT | 67% | revenue |
| CELH → PEP | 43.2% | revenue |
| CHD → WMT | 23% | net sales |
| SWK → HD | 15% | net sales |
| SWK → LOW | 12% | net sales |

**4 filers, 5 links.** Three of the five point at big-box retail.

### 2.4 The full deduplicated relationship table (all 27)

| Filer | Counterparty | Type | Exposure | Basis | Identity | Symbol |
|---|---|---|---|---|---|---|
| AMT | T-Mobile | tenant_rent | 18% | revenue | resolved_ticker | TMUS |
| AMT | AT&T | tenant_rent | 17% | revenue | resolved_ticker | T |
| AMT | Verizon Wireless | tenant_rent | 14% | revenue | resolved_ticker | VZ |
| AMT | Telefónica | tenant_rent | 10% | revenue | **ambiguous** | — |
| CELH | Pepsi | customer_revenue | 43.2% | revenue | resolved_ticker | PEP |
| CHD | Walmart Inc. | customer_revenue | 23% | net_sales | resolved_ticker | WMT |
| CRWV | Microsoft | customer_revenue | 67% | revenue | resolved_ticker | MSFT |
| DLR | Oracle Corporation | tenant_rent | 9.0% | recurring_revenue | resolved_ticker | ORCL |
| DLR | IBM | tenant_rent | 2.3% | recurring_revenue | resolved_ticker | IBM |
| DLR | Equinix | tenant_rent | 2.0% | recurring_revenue | resolved_ticker | EQIX |
| DLR | LinkedIn Corporation | tenant_rent | 1.6% | recurring_revenue | **resolved_private** | — |
| DLR | Meta Platforms, Inc. | tenant_rent | 1.6% | recurring_revenue | resolved_ticker | META |
| DLR | Lumen Technologies, Inc. | tenant_rent | 1.2% | recurring_revenue | resolved_ticker | LUMN |
| DLR | AT&T | tenant_rent | 1.0% | recurring_revenue | resolved_ticker | T |
| DLR | Comcast Corporation | tenant_rent | 1.0% | recurring_revenue | resolved_ticker | CMCSA |
| DLR | JPMorgan Chase & Co. | tenant_rent | 0.9% | recurring_revenue | resolved_ticker | JPM |
| DLR | Morgan Stanley | tenant_rent | 0.9% | recurring_revenue | resolved_ticker | MS |
| DLR | Rackspace | tenant_rent | 0.8% | recurring_revenue | resolved_ticker | RXT |
| FSLR | NextEra Energy | customer_revenue | ≥10% **floor** | net_sales | resolved_ticker | NEE |
| FSLR | Silicon Ranch Corporation | customer_revenue | ≥10% **floor** | net_sales | **resolved_private** | — |
| HOOD | Citadel Securities, LLC | market_maker_counterparty | 13% | revenue | **resolved_private** | — |
| HOOD | Wintermute Trading Ltd | market_maker_counterparty | 6% | revenue | **resolved_private** | — |
| QCOM | Apple | customer_revenue | ≥10% **floor** | revenue | resolved_ticker | AAPL |
| QCOM | Samsung | customer_revenue | ≥10% **floor** | revenue | **resolved_private** | — |
| QCOM | Xiaomi | customer_revenue | ≥10% **floor** | revenue | **resolved_private** | — |
| SWK | The Home Depot | customer_revenue | 15% | net_sales | resolved_ticker | HD |
| SWK | Lowe's | customer_revenue | 12% | net_sales | resolved_ticker | LOW |

Notes on this table, all recorded per-link in the manifest:

- **AMT is `tenant_rent`, not `customer_revenue`.** The filer says "customers" and "% of our total
  revenues", but the economics are carrier site leases with five-to-ten-year non-cancellable terms —
  identical in kind to DLR's tenant table. Classifying it as customer revenue because the filer used the
  word "customer" is exactly the conflation this pass exists to remove. This is a change from the first
  pass, and it *reduces* the homogeneous set.
- **HOOD yields zero tradable links.** Citadel Securities and Wintermute Trading are both private.
- **FSLR and QCOM disclose floors.** "10% or more" is not a weight. Per §7.3 (`exposure_pct` nullable,
  never guessed) and §14 ("missing exposure yields unavailable"), these cannot be sales-weighted.
- **`resolved_private` means "identified entity, no US-listed common stock"** — private (Citadel,
  Wintermute, Silicon Ranch), a wholly-owned subsidiary (LinkedIn → Microsoft), or foreign-listed only
  (Samsung, Xiaomi). Fail-closed: `resolved_symbol` is null and it is never counted as tradable.
- **CELH → Costco 10.8%, in the previous version of this table, is not in the manifest.** No adjudicated
  span in the 682 supports it. It is withdrawn as unproven.
- **BX is not in this table.** No BX span was accepted; BCRED/BREIT are disclosed in dollars, not percent,
  and are non-traded funds — no tradable instrument on the other end of the edge.

### 2.5 Where the 660 rejections went

| Rejection reason | N |
|---|---|
| `no_customer_relationship` | 159 |
| `non_customer_percentage` | 145 |
| `anonymous_customer_share` | 119 |
| `segment_or_geography_share` | 113 |
| `named_entity_not_customer` | 66 |
| `boilerplate_or_risk_factor` | 24 |
| `receivables_only_not_revenue` | 20 |
| `named_customer_no_share` | 10 |
| `supplier_or_vendor_not_customer` | 2 |
| `aggregate_multi_customer_segment_share` | 1 |
| `ownership_percentage_not_customer_share` | 1 |

The last two are reason corrections made by the second pass; the dispositions were unchanged (Appendix A.3).

### The decisive pattern: percentage disclosed, identity withheld

US GAAP (ASC 280-10-50-42) requires disclosing the **fact and amount** of a ≥10% customer — **not the name**.
The spec warned not to assume every 10% customer is named. The probe confirms issuers overwhelmingly take
the anonymity option — and, decisively, they take it *as exposure rises*.

#### The exhibit: Digital Realty's top-20 tenant table

DLR publishes its 20 largest tenants by annualized recurring revenue, with the share for each. It is the
single most generous disclosure in the entire 79-filer universe — and it anonymizes precisely the
counterparties that matter. From span `f89bc3ae1b5f68c6` (FY2025):

| Rank | Tenant | % of recurring revenue | Named? |
|---|---|---|---|
| 1 | **"Fortune 50 Software Company"** | **11.7%** | **NO** |
| 2 | Oracle Corporation | 9.0% | yes |
| 3 | **"Social Content Platform"** | **5.3%** | **NO** |
| 4 | **"Global Cloud Provider"** | **4.5%** | **NO** |
| 5 | IBM | 2.3% | yes |
| 6 | Equinix | 2.0% | yes |
| 7 | LinkedIn Corporation | 1.6% | yes |
| 8 | Meta Platforms, Inc. | 1.6% | yes |
| 9 | "Fortune 25 Investment Grade-Rated Company" | 1.4% | NO |
| 10 | "Social Media Platform" | 1.4% | NO |
| 11 | "Fortune 25 Tech Company" | 1.3% | NO |
| 12 | "Specialized Cloud Provider" | 1.3% | NO |
| 13 | Lumen Technologies, Inc. | 1.2% | yes |
| 14 | AT&T | 1.0% | yes |
| 15 | Comcast Corporation | 1.0% | yes |
| 16 | JPMorgan Chase & Co. | 0.9% | yes |
| 17 | "Quantitative Research and Investment Firm" | 0.9% | NO |
| 18 | Morgan Stanley | 0.9% | yes |
| 19 | Rackspace | 0.8% | yes |

**11 named, 8 anonymized.** The #1 tenant — the largest single exposure in the table, at 11.7% — is a
pseudonym. So are #3 and #4. The largest *named* tenant is #2 at 9.0%. **The name is disclosed exactly
where the economics are small.** This is not a scraping problem. There is no name to scrape.

(The span truncates mid-row-20, so row 20 is not adjudicated; 19 of 20 rows are readable. DLR's own
narrative, span `416341a7b69ffdb6`, adds that the top 20 are ~51% of recurring revenue and the top three
~26% — and two of those top three are pseudonyms.)

The same pattern, in pseudonymous and fully anonymous forms, across the universe — verbatim from the
filings:

| Issuer | Disclosed exposure | Customer identity | Span |
|---|---|---|---|
| NVDA | one customer **22%**, another **14%** of total revenue | "one direct customer" | `050ce6252bf4d0f9` |
| ENPH | one customer **39%** of net revenues (48% in 2024) | "one customer" | `7135b06d5b9c56de`† |
| AMAT | two customers **19%** and **15%** of net revenue | "two customers" | `6c741731314b6e5b` |
| MU | one customer **17%** of total revenue | "one customer" | `1ea12ad8a265f169` |
| INTC | three largest customers **43%** of net revenue | "our three largest customers" | `2884715f57b103fb`† |
| FFIV | **Customer A 15.8%**, **Customer B 17.5%** | literally lettered | `f70f4559c2a0866e` |
| FSLR | **Customer #1 11%**, **Customer #2 10%** | literally numbered | (see below) |
| RGTI | **Customer A–E**, up to **42%** | literally lettered | `4beb77c4cead0b6d` |
| AVGO | top five end customers **~40%** | "top five end customers" | (aggregate) |
| SMCI | four customers each **≥10%** of net sales | "four customers" | (floor, anonymous) |
| MRVL | **Customer A 14%**, **Distributor A 37%** | literally lettered | `3fae9c6b2f57e7e1` |
| PANW | three distributors **18.8%**, **14.4%**, **11.0%** of total revenue | "three distributors" | `5d82c120efe49c41` |

† span id shown is the adjudicated span for that issuer that carries the quoted text or its immediate
context; each issuer emitted several overlapping spans.

#### The second exhibit: FSLR contradicts itself inside one filing

FSLR is the cleanest possible demonstration that the *name* and the *weight* are disclosed under different
rules and rarely together. In the **same 10-K, same fiscal year**:

- The Item 1 / MD&A narrative **names** two customers but gives only a floor: "Silicon Ranch Corporation
  and NextEra Energy each accounted for **10% or more** of our net sales" (span `ec4046584f418ee0`).
- The financial-statement concentration note gives **real weights** but **anonymizes**: "Customer #1
  **11%**, Customer #2 **10%** of our total net sales."

The name is in the disclosure with no weight; the weight is in the disclosure with no name. You cannot
join them — nothing in the filing says Customer #1 is Silicon Ranch. Any pipeline that "resolves" that
join is fabricating an edge.

**This is structural, not a parsing gap.** No extraction quality, LLM, or engineering effort recovers a
name the filer never wrote. And note *which* issuers these are: the semiconductor/hardware complex — where
supplier→customer economics are strongest and where Cohen-Frazzini would bite hardest — is precisely where
identity is universally withheld.

### Sector / market-cap breakdown

**Formally UNMEASURED.** Sector and market-cap fields were not fetched (doing so would spend provider calls
beyond the bounded probe — an invariant of this study). The qualitative pattern from the issuer identities
is nonetheless consistent and evidenced by the lists above:

- **Names appear** almost only where the counterparty is a famous big-box retailer or a single hyperscaler —
  consumer staples and industrials selling into Walmart / Home Depot / Lowe's / Pepsi (CHD, SWK, CELH),
  two REITs with contracted tenants (AMT, DLR), one AI-cloud reseller (CRWV).
- **Names are withheld** across semis/hardware (NVDA, AMAT, AMD, AVGO, MRVL, MU, INTC, SMCI, FSLR, ENPH).
- **No customer exists to disclose** across banks, utilities, insurers, retailers, and consumer platforms
  (BAC, AXP, WFC, GS, DUK, NEE, TJX, HD, LOW, AMZN, TSLA) — a correct "no link", not a data gap.

## 3. Identity resolution — not the binding constraint

**Method (second pass, 2026-07-16):** the exact counterparty strings **as they appear in the filings** were
run against SEC `company_tickers.json` with a deterministic normalizer (NFKD, drop non-ASCII, lowercase,
strip punctuation and legal suffixes) using **exact match only — no substring matching**. Each link's
adjudicated `identity_resolution` and the note justifying it are recorded per-link in the manifest.

Of the **27 deduplicated relationships**: **20 resolved_ticker**, **6 resolved_private**, **1 ambiguous**,
0 unresolved. Fail-closed is enforced mechanically by the validator: `resolved_symbol` is non-null **if and
only if** `identity_resolution === 'resolved_ticker'`.

### Corrections to the previous version of this section

The first version of §3 was written from a substring-matching resolver whose output was not preserved. Re-run
with exact matching, three of its claims do not survive:

1. **"Verizon Wireless is a subsidiary, not an issuer → unresolved" is wrong.** AMT's own filing defines the
   term: `Verizon Communications Inc. ("Verizon Wireless")` (span `0a2be758c4857089`). The filer hands you
   the listed parent. Resolves to VZ.
2. **"AT&T collides with LSCC, H, WTS" was a substring artifact**, not a property of the data. Exact match
   returns `T, T-PA, T-PC, TBB` — one issuer plus its preferreds and notes, which an `is_primary` instrument
   flag (§7.2) disambiguates cleanly.
3. **"Telefónica matched nothing" was half the story.** The *corrupted* string ("Telef nica" — the HTML
   pipeline destroys non-ASCII before resolution starts) matches nothing. Repaired, "Telefonica" matches
   `TEFOF` and `TELFY` (OTC ADRs) **and** `VIV` (Telefónica Brasil — a different issuer). It is genuinely
   `ambiguous` with no primary US listing, but for a different reason than reported.

The **BCRED → BX false positive stands as a warning about substring matchers** — it is real, and §6.1 and
§3's fail-closed rule exist to prevent it — but note that exact matching does not reproduce it. It is a
property of the naive algorithm, not of the disclosure data.

### The failure modes that DO survive

| Filing string | Exact match returns | Why |
|---|---|---|
| `Pepsi` | **0** | CELH's defined short form; the map title is "PEPSICO INC" |
| `IBM` | **0** | acronym; map title is "INTERNATIONAL BUSINESS MACHINES CORP" |
| `Lowe's` | **0** | apostrophe normalizes to `lowe s`; map title yields `lowes` |
| `T-Mobile` | **0** | map title is "T-Mobile US, Inc." |
| `Rackspace` | **0** | map title is "Rackspace Technology, Inc." |
| `Verizon Wireless` | **0** | filer's defined term, not the registrant name |
| `AT&T`, `Oracle`, `Comcast`, `JPMorgan Chase`, `Morgan Stanley`, `NextEra Energy` | 2–10 tickers | same issuer's preferreds / share classes / structured notes |

Every one of these is fixable — an alias gazetteer plus an `is_primary` flag (§7.2). **That is the point.**
Resolution is an engineering problem with a known solution, and solving it would raise the tradable count
on a denominator of **27 relationships, of which only 5 are the homogeneous weighted customer links the
factor needs**. Resolution is not the binding constraint. **Coverage is.**

## 4. Point-in-time — this part actually works

The only unambiguously positive finding.

- **`acceptanceDateTime` is present on 79/79 filings**, with intraday precision (e.g. AAPL FY2025 10-K:
  `2025-10-31T10:01:26Z`). This is a real `available_at`, satisfying §7.3's knowledge-time requirement.
- **`acceptanceDateTime` ≠ `filingDate`, and using `filingDate` would be wrong.** ENPH's FY2025 10-K was
  *accepted* `2026-02-14T02:38Z` but carries `filingDate 2026-02-17` (accepted late Friday; date-stamped
  the next business day after the holiday). `filingDate` errs in both directions; only acceptance time is
  the true knowledge time.
- **Many filings are accepted after the US close** (a large share at ~21:00–23:00Z ≈ 16:00–18:00 ET), so
  the link is not actionable until the next session. §10's "available_at <= target_decision_ts" check is
  both necessary and computable.
- **Amendments are real and correctly dated.** CELH filed a `10-K/A` for FY2022 on 2023-04-19, seven weeks
  after the original 2023-03-01 10-K for the same fiscal year. A naive "latest filing for FY2022" query
  leaks the amendment backwards. Because every filing carries its own acceptance timestamp, the correct
  as-of query — `max(acceptanceDateTime) where acceptanceDateTime <= t` — is deterministic and available.

**Verdict on PIT: solved, and free.** It is the only leg of the study that passes. Every link in the
manifest carries an `available_at` taken from `acceptanceDateTime`, and the validator enforces that it is
an intraday timestamp, never a date-only `filingDate`. It is also worthless on its own, because there are
5 homogeneous links to timestamp.

## 5. Freshness / lag — measured

| Measure | Value |
|---|---|
| Fiscal period end → filed | median **48 days** (p25 38, p75 56, min 22, max 90) |
| Age of latest 10-K today (2026-07-16) | median **148 days**, max 351 |
| Age of the **fiscal year the exposure describes** | median **197 days (~6.5 months)**, max **381 days** |

A 10-K-sourced exposure weight is **~6.5 months stale at the median and up to a year old** by construction,
and refreshes **once a year**. Cohen-Frazzini's premise is slow diffusion of information *across* a link;
here the link's own weight is a year out of date — noise stacked on a 5-link sample.

## 6. Cost — measured

| Item | Value |
|---|---|
| Provider spend | **$0** (SEC EDGAR, free, no API key) |
| Requests for one full-universe pass | **167** (1 ticker map + 87 submissions + 79 documents) |
| Wall clock at 0.9 req/s | **~3 minutes** |
| Mean 10-K primary document | **2.14 MB** raw HTML |
| Raw bodies for 79 filers | **~169 MB** per annual refresh |
| Natural cadence | annual (10-K), so ~1 refresh/issuer/year |

Cost is **not** the reason to stop. Storing only source-span hashes (§12) would be a few KB — that is
exactly what `P0_ADJUDICATION_MANIFEST.json` does. This is cheap. It is simply cheap and empty — 169 MB
fetched to obtain 5 usable links.

## 7. Verdict — PROVISIONAL KILL for the current universe

**Do not build P1. Do not build the ledger, the tables, or the extraction pipeline.**

The verdict rests on two findings, and the second is why no amount of engineering changes the first:

> **Insufficient homogeneous coverage + structural missingness.**

Reasoning, in order of weight:

1. **Insufficient homogeneous coverage: n = 5 cannot be measured.** The pre-registered experiment (FEATURE_ARCHITECTURE §9.1) is
   a *cross-sectional* sales-weighted factor requiring rank IC/ICIR with overlapping-horizon correction,
   plus stability across time, sector, issuer size, and relationship age (FEATURE_ARCHITECTURE §9.2). The universe yields **5
   weighted, tradable, homogeneous `customer_revenue` links across 4 filers**. There is no cross-section.
   Even EdgeIC's preliminary `nObs >= 12` diagnostic — which FEATURE_ARCHITECTURE §9.2 explicitly calls *too weak* to promote on
   — is unreachable. Building P1/P2 would produce a dashboard that can never emit a verdict.
   - The headline count of 27 named relationships does **not** rescue this. 15 of them are `tenant_rent`
     (contracted REIT leases) and 2 are `market_maker_counterparty` (order-flow rebates). Summing them into
     one "customer" factor is the mistake the first adjudication pass made. They do not propagate alike;
     pooling them manufactures an n that the economics do not support.
2. **Structural missingness: the regime removes the links that matter.** GAAP requires the amount, not the
   name, and issuers take the anonymity option **on the highest-exposure links specifically**:
   - **DLR is the proof.** It names Oracle at 9.0% while anonymizing its #1 tenant at **11.7%** ("Fortune 50
     Software Company"), its #3 at 5.3% ("Social Content Platform") and its #4 at 4.5% ("Global Cloud
     Provider"). The disclosure is generous everywhere the exposure is trivial.
   - **FSLR names two customers with no weight, and weights two customers with no name, in the same 10-K.**
     The join does not exist in the document.
   - **NVDA (22%), ENPH (39%), AMAT (19%), MU (17%), INTC (43%), MRVL (37%), PANW (18.8%), FFIV, RGTI, SMCI,
     AVGO** — all anonymous or lettered.
   No extraction quality, LLM, or engineering effort recovers a name the filer never wrote. This is the
   assumption §17 named as the single riskiest — and it failed.
3. **What survives is a concentrated retail bet, not a graph.** 3 of the 5 usable links lead to big-box
   retail (WMT, HD, LOW); the other two are PEP and MSFT. A "customer momentum" factor over this set is a
   correlated bet on a handful of mega-caps wearing a graph's clothing — precisely the false precision §17
   warns against.
4. **The weights are ~6.5 months stale** and refresh annually.
5. **Resolution is fixable and it does not matter.** Unlike coverage, identity resolution has a known
   engineering solution (§3). Solving it perfectly moves the tradable count within a 27-relationship
   denominator whose homogeneous, weighted core is 5.

**A "no" here is the cheap, successful outcome.** The probe cost 167 free requests and ~3 minutes of wall
clock; the adjudication record cost one additional free request. Together they retire a multi-phase build
(P1 ledger + P2 edge lab + P3 shadow) that would have spent weeks to arrive at an unmeasurable n=5. Per
§17: retain the existing peer-move display and stop.

### Why still *provisional*

The reason Codex marked this provisional — no preserved adjudication record behind the headline — is now
resolved: Appendix A commits one bounded record per candidate, and the validator derives every number in this
document. One item keeps it provisional:

- **Recall of the regex nets themselves is UNPROVEN.** The manifest adjudicates the 682 spans the nets
  emitted. It cannot rule out a named-and-weighted disclosure sitting in a filing region no net matched,
  because the raw filing text is deliberately not committed (§12). Bounding it requires re-running the
  probe with a widened net and diffing the candidate sets — cheap (~3 minutes, $0), but not done here.

That open item cuts **toward** the KILL being under-stated, not over-stated: additional recall could only
find *more* anonymized disclosures alongside any additional named ones, and the named ones would still have
to clear the weighted-tradable-homogeneous filter that 22 of 27 relationships already fail. **Nothing found
in this pass moves the verdict toward BUILD. The corrected numbers are worse than the ones they replace.**

### What would have to change to revisit (falsifiable preconditions)

- **A ~10x larger covered universe.** At the measured rate — **5 usable homogeneous links per 79 filers**
  (4 filers, 5.1%) — reaching even 30–50 links needs roughly **500–800 covered US issuers**. Kairos covers
  79. Universe expansion is the precondition; it is not on the roadmap, and this feature is not a reason to
  put it there. (Note this precondition got *harder* under the corrected numbers: the previous version
  computed it from a 6.3% rate that pooled three relationship types.)
- **Universe tilted toward the disclosure niche** — consumer staples/industrials selling into big-box
  retail, where names actually appear. Kairos's universe is tech/semis-heavy, i.e. tilted into the
  *anonymized* bucket. The current universe is close to the worst case for this factor.
- **A disclosure-rule change** requiring customer identity. Reg S-K's 2020 modernization moved the opposite
  way (toward principles-based disclosure). No such change is pending.

If the universe ever crosses ~500 US issuers, re-run `scripts/sec-customer-coverage-probe.mjs` — it is
cheap, and it answers this in three minutes.

### What this study does NOT claim

- It does **not** claim Cohen-Frazzini's anomaly is false. It claims Kairos cannot *observe* enough of it.
- It does **not** evaluate India (out of scope; no validated PIT contract — §10).
- It does **not** measure a sector/market-cap breakdown (unmeasured — see §2).
- It does **not** measure extraction precision against a labeled fixture set (FEATURE_ARCHITECTURE §11 P0 item 3) — that work is
  moot given coverage, and was not run.
- It does **not** prove the recall of the regex nets (see §7 "Why still provisional" and Appendix A.5).
- It does **not** verify that an adjudicated `resolved_symbol` is the *correct* ticker for the counterparty
  beyond the SEC ticker-map evidence recorded per-link (Appendix A.5).
- It does **not** evaluate FinancialDatasets' `segmented_financials`, which per §5.3 describes product/business
  segments, not customer identity, and is not a substitute source for this question.

## 8. Reproducibility

```bash
# 1. The probe. Read-only. No DB writes, no keys. Set your own contact string.
SEC_UA="Your Project (you@example.com)" \
  node scripts/sec-customer-coverage-probe.mjs --out sec-probe-results.json

# 2. The record. Offline, deterministic, no network. Recomputes every number in this document.
node scripts/validate-p0-adjudication-manifest.mjs
npx vitest run tests/p0-adjudication-manifest.test.ts
```

The probe emits one record per issuer: exact sample-frame hash, CIK, company, form, accession,
`filingDate`, **`acceptanceDateTime`**, `reportDate`, document URL, filing SHA-256, and candidate spans
tagged by recall net. Candidates still require a separate label; the script never promotes regex output to
truth.

**Artifacts:** no database table was created (none was needed). No migration. No provider spend.
No money-path surface was touched.

## Appendix A — The adjudication record

The reason this study was marked provisional is that its headline could not be reproduced from any
committed artifact. That is fixed here.

### A.1 What is committed

| File | What it is |
|---|---|
| `P0_ADJUDICATION_MANIFEST.json` | **Exactly one record per candidate span, 682 of them**, keyed by span id. Per record: `id`, `symbol`, `cik`, `accession`, `documentSha256`, `spanSha256`, `nets[]`, `disposition`, `rejection_reason`, `adjudicator`, `review_depth`, `first_pass{}`, and **`links[]`**. |
| `P0_CANDIDATE_INDEX.json` | Text-free index of the same 682 candidates (`id`, `symbol`, `accession`, `nets`, `spanSha256`, `spanChars`). An independent id universe the validator diffs the manifest against, so the manifest cannot silently gain, lose, or invent a candidate. |
| `scripts/validate-p0-adjudication-manifest.mjs` | Deterministic, offline validator. 26 checks + every count in this document. |
| `tests/p0-adjudication-manifest.test.ts` | 28 tests. Includes 9 mutation tests that deliberately corrupt the manifest and assert the validator catches it — a validator that passes everything proves nothing. |

**No raw filing text is committed.** Spans are represented by `spanSha256`, filing bodies by
`documentSha256`. The candidate id rule — `sha256(symbol|accession|span)[:16]` — is **verified at build
time for all 682**, which is what ties the hashes back to the probe output.

Each link carries: `counterparty_name`, `identity_resolution`, `resolved_symbol`, `identity_note`,
`relationship_type`, `exposure_pct`, `exposure_basis`, `exposure_is_floor`, `period`, and `available_at`
(from `acceptanceDateTime`, never `filingDate`).

### A.2 The two defects this pass corrects

The first adjudication pass (682 in / 682 out) had two defects that make its output **not a corrected
number but a differently-wrong one**:

1. **Lossy schema.** It carried a single `customer` string per span. One span routinely names many
   counterparties: AMT names four, QCOM three, SWK two, DLR eleven. The extra names were pushed into
   free-text notes and lost — and QCOM's were jammed into one field as `"Apple; Samsung; Xiaomi"`. The
   manifest uses `links[]`: 22 accepted spans flatten to **48 link rows**, versus the first pass's 22.
2. **Taxonomy conflation.** It accepted three materially different economic relationships as one "customer"
   factor: CoreWeave→Microsoft 67% (customer revenue), Robinhood→Citadel Securities 13% (market-maker order
   flow), Digital Realty→Oracle 9.0% (tenant rent). These do not propagate alike. The manifest classifies
   `relationship_type` explicitly, and **no number in this study sums across types**.

The second pass also reclassified **AMT from `customer_revenue` to `tenant_rent`** — tower site leases with
five-to-ten-year non-cancellable terms are the same economics as DLR's tenant table, regardless of the
filer calling them "customers". That removes 4 links from the homogeneous set.

### A.3 Disagreement rate with the first pass

| | |
|---|---|
| Dispositions changed (accept ↔ reject) | **0 of 682 (0.0%)** |
| Rejection *reasons* corrected (disposition unchanged) | 2 of 660 (0.3%) |
| Accepted spans whose **modelling** changed | **22 of 22 (100%)** |
| Link rows: first pass → manifest | 22 → **48** |

**The first pass's recall held up; its modelling did not.** Read that split precisely: on the binary
question "does this span disclose a named counterparty with a weighted share", the two passes agree
completely. On what the accepted spans actually *say*, they disagree on every single one — because the
schema could not express multi-counterparty spans and the taxonomy pooled three different economics.

The two reason corrections: `6d311f8d130ca745` (F/Ford Otosan — the 41%/41%/18% are **JV ownership
stakes**, not customer shares) and `0a2be758c4857089` (AMT — a named pair, but an **aggregate 85% of a
segment**, not a per-counterparty share).

### A.4 How the rejections were audited

The first pass reported **zero ambiguous cases across 682 noisy regex hits**. That claim was treated as a
red flag, not as evidence. The audit:

- **All 22 accepted spans re-read in full.** Every disagreement above came from this.
- **A mechanical false-negative screen over all 660 rejections**: a percentage within 220 characters of a
  counterparty keyword (`customer|tenant|licensee|distributor|market maker|counterparty|end market|reseller`)
  **and** a corporate-suffix or mega-cap proper noun inside the same window. **31 hits, all re-read in full.**
- **All 10 `named_customer_no_share` and all 3 `supplier_or_vendor_not_customer` re-read in full** — the two
  buckets most likely to hide a usable link.
- **A deterministic stride sample of the large buckets re-read in full**: 20 of `anonymous_customer_share`
  (119), 18 of `named_entity_not_customer` (66), 8 of `receivables_only_not_revenue` (20), plus 8
  `segment_or_geography_share`, 8 `non_customer_percentage`, 6 `no_customer_relationship`, 4
  `boilerplate_or_risk_factor`.

**129 of 682 spans (18.9%) were re-read in full; the other 553 were adopted after passing the screen.**
`review_depth` records which is which per record, and the validator asserts that every accepted span was
re-read.

**Result: zero false negatives found.** The near-misses are all correct rejections on inspection — AMT's
AT&T Mexico dispute ($300M of tenant revenue, **dollars not percent**), CRWV's OpenAI master services
agreement (**a $6.5B commitment, prospective, no share of FY2025 revenue**), SWK's "two largest customers
~27%" (**aggregate, anonymous**), Ford Otosan (**ownership stake**), Intel/TSMC (**a supplier**). Zero
ambiguity across 682 remains a surprising claim, but on this evidence it survives scrutiny for the
*disposition* question. It did not survive scrutiny for anything else.

### A.5 Unproven — what this record does NOT establish

An honest "unproven" beats a confident wrong number. This record exists because a previous number was
asserted without one.

1. **Recall of the regex nets is unproven.** The manifest adjudicates the 682 spans the nets emitted. A
   named-and-weighted disclosure in a filing region no net matched would be invisible here, and the raw
   filing text is deliberately not committed (§12), so it cannot be checked offline. **Ruled out:** that a
   *rejected* span hides such a disclosure (screened + sampled, Appendix A.4). **Not ruled out:** that an
   un-emitted span does. Bounding it requires a probe re-run with a widened net and a candidate-set diff.
2. **Ticker correctness is evidenced, not proven.** Each `resolved_symbol` records the SEC-ticker-map
   evidence and the reasoning in `identity_note`. Two rest on judgment the map alone does not settle:
   `Rackspace → RXT` (the map lists "Rackspace Technology, Inc."; current listing status not
   independently verified) and the share-class picks (`T`, `ORCL`, `CMCSA`, `JPM`, `MS`, `NEE`, `TMUS`),
   which assume an `is_primary` flag per §7.2 that does not exist yet.
3. **DLR tenant row 20 is not adjudicated** — the span truncates mid-row. 19 of 20 rows are readable.
4. **Buckets C/D/E in §2 of the previous version (regex-approximate filer counts) are not reproduced here.**
   The manifest counts *spans and links*, not filers-per-bucket. The filer-level numbers this study now
   reports are the ones the validator derives.
5. **The sector / market-cap breakdown remains formally unmeasured**, as before.
