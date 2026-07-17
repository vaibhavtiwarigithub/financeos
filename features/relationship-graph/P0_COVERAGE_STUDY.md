# P0 Coverage / Identity Feasibility Study — Disclosed Customer Links (US)

> Status: **provisional KILL; do not build. Reproducibility rerun required for final sign-off.**
> Run date: 2026-07-16. Probe: `scripts/sec-customer-coverage-probe.mjs` (read-only, no DB writes, no money path).
> Scope: exactly the study authorized by `FEATURE_ARCHITECTURE.md` §11 (P0) and §17. No graph, no table,
> no scoring, no candidate emission, no migration was built.

## 0. The one question

> Can Kairos obtain point-in-time, correctly resolved, economically weighted disclosed-customer links,
> from free sources, for its actual US universe, at sufficient coverage to measure customer momentum honestly?

**Measured answer: no. 5 of 79 covered US filers (6.3%) yield a usable link.** The disclosure regime
systematically strips the customer's *identity* while keeping the *percentage* — and it strips it hardest
on exactly the highest-exposure links that would carry the most signal.

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
filing. The 5/79 result remains the operative product decision (do not build), but is **provisional** until
the enhanced probe output and per-candidate labels are committed as a bounded evidence artifact.

**Enhanced rerun:** 92/92 sample symbols processed in 202.6 seconds; sample-frame SHA-256
`b50dbd47e2161698b84c02dabb1c40c0f77eb9d6f146ca32aa887d5ab57b528e`; 79 domestic 10-Ks, 7 foreign
private issuers, 5 ticker-map misses, and 1 no-10-K case. The deliberately broad nets emitted 682
candidates (508 customer-concentration, 133 legal-suffix, 71 mega-cap-gazetteer hits; candidates may
carry multiple tags). Final sign-off requires preserving one bounded disposition per candidate hash;
raw filing text should not be committed.

## 2. Coverage — of 79 filers, who discloses a NAMED customer with a revenue share?

| Bucket | N | % of 79 | Confidence |
|---|---|---|---|
| **A. Named customer + per-customer revenue %** — usable for a sales-weighted factor | **5** | **6.3%** | hand-read |
| B. Named customer, but no usable per-customer % | 2 | 2.5% | hand-read |
| C. Revenue % disclosed, customer **anonymous** | ~22 | ~28% | regex-approximate |
| D. Explicit negative ("no customer ≥10%") | ~13 | ~16% | regex-approximate |
| E. No concentration disclosure / structurally N/A | ~36 | ~46% | regex-approximate |

Buckets C/D/E are regex-approximate and carry known errors (MU and INTC are anonymized-% cases the
negative-pattern mis-bucketed). **Only bucket A drives the verdict, and bucket A is hand-read.**

### Bucket A in full — the entire usable dataset

| Supplier | Named customer(s) and disclosed revenue share | 10-K filed |
|---|---|---|
| CHD (Church & Dwight) | Walmart Inc. **23%** | 2026-02-12 |
| SWK (Stanley Black & Decker) | The Home Depot **15%**, Lowe's **12%** | 2026-02-24 |
| AMT (American Tower) | T-Mobile **18%**, AT&T **17%**, Verizon Wireless **14%**, Telefónica **10%** | 2026-02-24 |
| CELH (Celsius Holdings) | Pepsi **43.2%**, Costco **10.8%** | 2026-03-02 |
| CRWV (CoreWeave) | Microsoft **67%** | 2026-03-02 |

That is **5 suppliers and 10 customer links** — the complete harvest from the entire covered universe.

### Bucket B — named but unusable

- **QCOM**: "revenues from Apple, Samsung and Xiaomi each comprised 10% or more of our consolidated
  revenues." Named, but a **floor, not a share** — no exposure weight exists. Per §7.3 (`exposure_pct`
  nullable, never guessed) and §14 ("missing exposure yields unavailable"), this cannot be sales-weighted.
- **BX**: BCRED / BREIT disclosed in **dollars, not percent**, and both are non-traded funds — no tradable
  instrument on the other end of the edge.

### The decisive pattern: percentage disclosed, identity withheld

US GAAP (ASC 280-10-50-42) requires disclosing the **fact and amount** of a ≥10% customer — **not the name**.
The spec warned not to assume every 10% customer is named. The probe confirms issuers overwhelmingly take
the anonymity option, verbatim from the filings:

| Issuer | Disclosed exposure | Customer identity |
|---|---|---|
| NVDA | one customer **22%**, another **14%** of total revenue | "one direct customer" |
| ENPH | one customer **39%** of net revenues (48% in 2024) | "one customer" |
| AMAT | two customers **19%** and **15%** of net revenue | "two customers" |
| MU | one customer **17%** of total revenue | "one customer" |
| INTC | three largest customers **43%** of net revenue | "our three largest customers" |
| FFIV | **Customer A 15.8%**, **Customer B 17.5%** | literally lettered |
| FSLR | **Customer #1 11%**, **Customer #2 10%** | literally numbered |
| RGTI | **Customer A–E**, up to **42%** | literally lettered |
| AVGO | top five end customers **~40%** | "top five end customers" |
| SMCI | four customers each **≥10%** of net sales | "four customers" |

**This is structural, not a parsing gap.** No extraction quality, LLM, or engineering effort recovers a
name the filer never wrote. And note *which* issuers these are: the semiconductor/hardware complex — where
supplier→customer economics are strongest and where Cohen-Frazzini would bite hardest — is precisely where
identity is universally withheld.

### Sector / market-cap breakdown

**Formally UNMEASURED.** Sector and market-cap fields were not fetched (doing so would spend provider calls
beyond the bounded probe — an invariant of this study). The qualitative pattern from the issuer identities
is nonetheless consistent and evidenced by the lists above:

- **Names appear** almost only where the customer is a famous big-box retailer or a single hyperscaler —
  consumer staples and industrials selling into Walmart / Home Depot / Lowe's / Costco / Pepsi (CHD, SWK,
  CELH), a tower REIT with 4 carrier tenants (AMT), one AI-cloud reseller (CRWV).
- **Names are withheld** across semis/hardware (NVDA, AMAT, AMD, AVGO, MRVL, MU, INTC, SMCI, FSLR, ENPH).
- **No customer exists to disclose** across banks, utilities, insurers, retailers, and consumer platforms
  (BAC, AXP, WFC, GS, DUK, NEE, TJX, HD, LOW, AMZN, TSLA) — a correct "no link", not a data gap.

## 3. Identity resolution — the make-or-break test

Tested the **exact customer strings as they appear in the filings** against SEC `company_tickers.json` with
a deterministic normalizer (lowercase, strip punctuation and legal suffixes, exact match then substring).

**Bucket A's 10 customer strings:**

| Result | N | % | Strings |
|---|---|---|---|
| **Resolved** to exactly one US-tradable issuer | **6** | **60%** | Walmart Inc.→WMT, The Home Depot→HD, Lowe's→LOW, Pepsi→PEP, Costco→COST, Microsoft→MSFT |
| **Ambiguous** | 2 | 20% | T-Mobile → 4 share-class tickers (TMUS/TMUSZ/TMUSI/TMUSL); AT&T → collides with LSCC, H, WTS |
| **Unresolved** | 2 | 20% | Verizon Wireless (a *subsidiary*, not an issuer); Telefónica (foreign issuer) |

**Three failure modes worth recording, all observed live:**

1. **A silent false positive.** "Blackstone Private Credit Fund" resolved to **BX = Blackstone Inc.** by
   substring match. That is **wrong** — BCRED is a separate non-traded BDC, not its manager. A naive
   resolver invents an edge between a fund and its sponsor. This is the exact failure §6.1 and §3
   ("fail closed on ambiguity") are written to prevent, reproduced on the first try.
2. **Suffix stripping destroys short names.** Normalizing "AT&T Inc." strips the legal suffix and leaves
   `at`, which is a substring of Lattice Semiconductor, Hyatt, and Watts Water. The most famous customer
   in the sample is unresolvable by the obvious algorithm.
3. **Encoding corrupts non-ASCII names.** "Telefónica" survived HTML extraction as "Telef nica" and matched
   nothing. Foreign customer names are lost by the text pipeline before resolution even starts.

Ambiguity 1 and 2 are fixable (an `is_primary` instrument flag per §7.2, a hand-built alias gazetteer).
But fixing them raises resolution on a denominator of **10 links**. Resolution is not the binding
constraint — **coverage is**. Applying §3's fail-closed rule to the ambiguous and unresolved cases leaves
**6 clean links from 5 suppliers.**

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

**Verdict on PIT: solved, and free.** It is the only leg of the study that passes. It is also worthless on
its own, because there are 5 links to timestamp.

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

Cost is **not** the reason to stop. Storing only source-span hashes (§12) would be a few KB. This is cheap.
It is simply cheap and empty — 169 MB fetched to obtain 5 links.

## 7. Verdict — PROVISIONAL KILL for the current universe

**Do not build P1. Do not build the ledger, the tables, or the extraction pipeline.**

Reasoning, in order of weight:

1. **n = 5 cannot be measured.** The pre-registered experiment (§9.1) is a *cross-sectional* sales-weighted
   factor requiring rank IC/ICIR with overlapping-horizon correction, plus stability across time, sector,
   issuer size, and relationship age (§9.2). With 5 suppliers there is no cross-section. Even EdgeIC's
   preliminary `nObs >= 12` diagnostic — which §9.2 explicitly calls *too weak* to promote on — is
   unreachable. Building P1/P2 would produce a dashboard that can never emit a verdict.
2. **The regime removes the links that matter.** GAAP requires the amount, not the name, and issuers take
   the anonymity option on the highest-exposure links (NVDA 22%, ENPH 39%, AMAT 19%, MU 17%, INTC 43%,
   FFIV/FSLR/RGTI lettered). No build effort recovers an unwritten name. This is the assumption §17 named
   as the single riskiest — and it failed.
3. **What survives is a concentrated retail bet, not a graph.** 4 of the 5 usable suppliers lead to
   big-box retail (WMT, HD, LOW, COST, PEP). A "customer momentum" factor over this set is a correlated bet
   on ~5 mega-cap retailers wearing a graph's clothing — precisely the false precision §17 warns against.
4. **Naive resolution silently fabricates edges.** The BCRED→BX false positive appeared on the first
   attempt. Fail-closed handling (§3) is correct and drops the usable set further, to 6 links.
5. **The weights are ~6.5 months stale** and refresh annually.

**A "no" here is the cheap, successful outcome.** This study cost 167 free requests and ~3 minutes of wall
clock, and it retires a multi-phase build (P1 ledger + P2 edge lab + P3 shadow) that would have spent weeks
to arrive at an unmeasurable n=5. Per §17: retain the existing peer-move display and stop.

### What would have to change to revisit (falsifiable preconditions)

- **A ~10x larger covered universe.** At the measured ~6.3% named-with-% rate, reaching even 30–50 links
  needs roughly **500–800 covered US issuers**. Kairos covers 79. Universe expansion is the precondition;
  it is not on the roadmap, and this feature is not a reason to put it there.
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
- It does **not** measure extraction precision against a labeled fixture set (§11 P0 item 3) — that work is
  moot given coverage, and was not run.
- It does **not** evaluate FinancialDatasets' `segmented_financials`, which per §5.3 describes product/business
  segments, not customer identity, and is not a substitute source for this question.

## 8. Reproducibility

```bash
# Read-only. No DB writes, no keys. Set your own contact string.
SEC_UA="Your Project (you@example.com)" \
  node scripts/sec-customer-coverage-probe.mjs --out sec-probe-results.json
```

Emits one record per issuer: exact sample-frame hash, CIK, company, form, accession, `filingDate`,
**`acceptanceDateTime`**, `reportDate`, document URL, filing SHA-256, and candidate spans tagged by recall
net. Candidates still require a separate human label; the script never promotes regex output to truth.

**Artifacts:** no database table was created (none was needed). No migration. No provider spend.
No money-path surface was touched.
