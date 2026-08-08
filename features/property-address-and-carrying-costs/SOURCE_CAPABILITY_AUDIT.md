# Property Source Capability Decision

Status: **Design audit complete, no production code authorized.**
Decision date: 2026-08-08
Scope: automatic parcel linkage, property tax, insurance, and value history for
Austin, Phoenix, and Bengaluru. This document supersedes any unsupported claim
that an individual-property source is free, machine-accessible, or suitable for
an AVM.

## Decision

Build the owner-controlled value and carrying-cost ledger next. It is useful in
all three markets, needs no external collection, and creates an auditable
history of what Kairos knew and when.

Do **not** build an automatic parcel, tax-bill, or insurance-quote collector
yet. The verified official sources are useful reference systems, but none
currently establish a permitted, stable, free machine interface for all of
those property-level uses. A page a person can search is not permission to
automate it.

The existing US Census geocoder remains approved for address-to-geography only.
It returns a standardized address and broad geography, not a legal parcel
identity, tax account, title conclusion, or valuation.

## What Is Buildable Now

| Capability | Austin | Phoenix | Bengaluru | Decision |
|---|---|---|---|---|
| Encrypted owner address, ZIP/PIN/locality, and document reference | Yes | Yes | Yes | Already supported; keep raw address out of logs and LLMs. |
| Append-only owner value history | Yes | Yes | Yes | Build next. Owner estimate, documented appraisal, purchase price, county reference, and market-index reference are separate value types. |
| Append-only cost history | Yes | Yes | Yes | Build next. Tax, insurance, maintenance, HOA, and other costs require source/provenance and effective dates. |
| Exact carrying cost from owner tax/insurance bill or policy | Yes | Yes | Yes | Build next through owner entry or a reviewed owner upload; never infer a bill from a ZIP average. |
| Market-index reference series | FHFA Austin metro | FHFA Phoenix metro | RBI Bengaluru city HPI | Continue as market context only. It may rebase an owner-entered value into an explicitly labelled scenario, never produce an AVM. |
| Exact parcel identity from address | Not yet | Not yet | Not yet | Separate source-specific adapters only after explicit interface/terms/rate audit. |
| Exact current tax bill from a government system | Not yet | Not yet | Not yet | Owner bill/receipt remains the canonical property-specific record. |
| Insurance quote/premium | No | No | No | Quote requires insurer underwriting. Store owner policy/quote; show planning reference only when source geography matches. |

## City Findings

### Austin, Texas

**Verified sources.** TCAD publishes certified appraisal exports and export
layouts. Those are the correct source family for county *appraisal* attributes.
TCAD's interactive property-search page explicitly says it is not intended for
bulk transfer, so Kairos must not automate that search page. The Travis County
Tax Office provides account search and a tax estimator, but warns that estimates
are not exact and exclude changing law, exemptions, assessments, and tax
ceilings. Texas Department of Insurance publishes county-level market premium
information, but that is a planning benchmark, not a quote.

**Buildable after a narrow adapter review.** A monthly, server-side parser may
consume only the released certified export, retain only fields for a property
already linked by the owner, and record `county_appraised_value`,
`county_assessed_value`, tax year, release, and source hash. It must not use the
export to derive a market value or create a comparable-sales model. Before this
adapter is built, the current export's download terms, field layout, row volume,
and minimal-field selection must be captured in a source manifest.

**Blocked.** Do not automate TCAD search or the tax estimator, and do not show
an estimated tax as the owner's bill. Texas is a non-disclosure state: county
assessment is not a substitute for observed arm's-length sale prices. No Austin
AVM or comparable-sales pipeline is approved under the current sources.

### Phoenix, Arizona

**Verified sources.** Maricopa County exposes address/parcel search to people,
and its Assessor states that regular data users can arrange API GET access with
the Assessor. The Treasurer's system supplies tax-bill information once an APN
is known. Neither page is a published public API contract with rate limits,
machine-use terms, or a data licence suitable for automatic Kairos collection.

**Critical correction.** Maricopa's official data-sales page lists both its
Residential Master and Sales Affidavits as paid products. The existing valuation
architecture cites an ArcGIS R102 attachment as a public free sales feed. This
audit could not verify that attachment's licence or equivalence to the paid
Sales Affidavits product. Therefore the ArcGIS feed is **licence-unverified**:
no new use, expansion, or claim of free availability is approved until a human
review records the exact official publisher, licence, permitted private use,
schema, cadence, and machine-access terms. This is a documentation/activation
gate, not evidence that the existing data is invalid.

**Buildable later, conditionally.** An address-to-APN adapter can be designed
only after Maricopa provides or documents access appropriate for this private
use. It must match exactly one candidate, write only an HMAC of APN, preserve
match confidence/source/time, and require owner confirmation before any tax
lookup. The tax adapter may read a documented API only; it may not automate the
Treasurer payment/search page.

**Blocked.** No free, source-verified parcel-tax API; no automated sales feed;
no exact insurance premium. Arizona DIFI's homeowner material confirms that
coverage, limits, deductibles, property location, and home characteristics
affect premiums, so state trends cannot price an individual home.

### Bengaluru, Karnataka

**Verified sources.** BBMP's GEPTIS/Palike systems maintain property-tax
identifiers and tax information, but public access is registration/mobile-linked
and subject to view limits; no public machine API or reusable bulk licence was
verified. RBI publishes a quarterly Bengaluru city HPI from registration data.
The Karnataka e-Aasthi/Kaveri systems are owner-directed government services,
not an approved application data feed.

**Buildable now.** Keep encrypted address/locality/PIN, owner-entered tax
receipts, Khata/PID references, insurance policies, and purchase/appraisal
values. RBI Bengaluru HPI can be a city-level, quarterly reference line.

**Blocked.** Automated PID resolution, tax-bill retrieval, registration/EC
collection, and property-level comparable or AVM data. Do not automate Kaveri,
e-Aasthi, GEPTIS, BBMP tax pages, or private portals. An owner may later upload
a document; Kairos may extract selected fields only after a separate privacy and
document-processing design is approved.

## Value And Cost History Contract

The next feature adds two append-only owner-only ledgers. They extend the
existing encrypted `property_assets` vault; they do not change market
observations, property forecasts, or Investing data.

### `property_asset_value_observations`

Required fields: asset ID, market, currency, observed date, entered date,
amount, value type, provenance, source reference/hash, and immutable creation
metadata.

Allowed `value_type` values:

- `purchase_price`
- `owner_estimate`
- `documented_appraisal`
- `county_appraised_reference`
- `county_assessed_reference`
- `observed_sale`
- `market_index_reference`

The UI keeps these series visually separate. A market-index reference must show
the base value and index release used. It is a scenario/reference, not "current
property value." A later correction adds a new observation with a
`supersedes_observation_id`; it never rewrites history.

### `property_asset_cost_observations`

Required fields: asset ID, market, currency, cost category, cadence, effective
start/end dates, annualized amount, provenance, confidence/state, source
reference/hash, and immutable creation metadata.

Allowed categories: `property_tax`, `home_insurance`, `maintenance`, `hoa`,
`utilities`, `management`, and `other`.

Allowed provenance: `owner_bill`, `owner_policy`, `owner_quote`,
`county_reference`, `official_area_benchmark`, and `planning_assumption`.

The monthly payment surface uses the most recent applicable observation by
effective date and exposes its provenance. If no tax or policy exists, it says
`missing`, not `$0`. Area benchmarks may appear only in a clearly separate
planning-assumption control and can never overwrite owner evidence.

## Required Safety Gates Before Any Automated Adapter

1. Source manifest: canonical URL, owner, exact fields, licence/terms review
   date, permitted use, cadence, rate limit, and retention rule.
2. No credential sharing, login automation, CAPTCHA handling, browser scraping,
   or payment/tax-estimator automation.
3. Address/APN/PID stays encrypted or keyed; never persist it in logs, URLs,
   analytics, provider-call ledgers, or LLM prompts.
4. Exactly-one-match policy: zero/multiple matches require owner confirmation;
   no fuzzy auto-link.
5. Download only after a property is selected; no county-wide cache or source
   archive retention.
6. Every imported number carries source, tax year/effective date, collection
   time, and `reference` versus `bill` semantics.
7. All computed payments default to `insufficient_inputs` when a required cost
   is unknown; no silent zeroes.

## Recommended Build Order

1. Build the encrypted, append-only value and cost ledgers plus edit-as-new-
   observation UI. This is market-neutral, immediately useful, and fully within
   current data rights.
2. Add owner document references/import design, starting with tax bill and
   insurance policy metadata. Extraction itself is a later gated feature.
3. Add Texas county-level insurance benchmark only as an opt-in planning input,
   with county/year/source displayed. Do not add an Arizona or Bengaluru
   equivalent until source coverage is verified.
4. Re-audit Phoenix's ArcGIS source and request/document approved Maricopa API
   access before modifying any parcel/tax worker.
5. Re-audit TCAD export terms and implement a minimal private appraisal-
   reference adapter only if the source manifest passes.
6. Keep Bengaluru property-specific automation blocked while using RBI city HPI
   and owner evidence.

## Official Sources Reviewed

- US Census Geocoding Services API: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
- TCAD public information and certified exports: https://traviscad.org/publicinformation/
- TCAD property search restrictions: https://traviscad.org/propertysearch/
- Travis County tax-estimator limitations: https://tax-office.traviscountytx.gov/properties/taxes/customized-estimates
- Texas homeowners insurance market data: https://tdi.texas.gov/general/texas-homeowners-insurance-market-overview.html
- Maricopa Assessor data-sales catalogue: https://www.mcassessor.maricopa.gov/page/data_sales/secured_data/
- Maricopa Assessor tax/API guidance: https://mcassessor.maricopa.gov/faq/faq-property-tax.php
- Maricopa Treasurer parcel tax system: https://treasurer.maricopa.gov/parcel/ParcelSearch.aspx/TaxBill.aspx
- Arizona DIFI homeowner insurance guidance: https://difi.az.gov/consumers/homeowners-insurance
- BBMP GEPTIS and property-tax systems: https://site.bbmp.gov.in/departmentwebsites/BBMPIT/geptis.html
- RBI Bengaluru HPI release and DBIE path: https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=51771
- FHFA HPI datasets: https://www.fhfa.gov/house-price-index?tab=HPI+Datasets
