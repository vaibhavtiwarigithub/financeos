# Property Value Intelligence

## Status

Implemented through value evidence, index references, and index scenarios on
2026-08-08. This design replaces the ambiguous single owner-entered
`value` field with source-labelled property value evidence and an explainable
market-index reference. It does **not** authorize a Zillow/Redfin-style AVM
until market-specific data and validation gates are satisfied.

## Problem

`My Properties` currently stores one owner-entered value as of a chosen date.
That value can be a purchase price, an appraisal, a tax assessment, or an
opinion, but the system cannot tell which. A historical chart of that mixed
field is not a defensible estimate, cannot explain a change, and cannot be
calibrated against an eventual sale.

The owner needs three distinct answers:

1. What is known about this property from explicit evidence?
2. What does that evidence imply when rebased by an auditable local market
   index?
3. What are the 1-, 3-, and 5-year bear/base/bull scenarios, why do they differ,
   and how accurate has the system historically been?

## Product Decision

Build a **Property Value Intelligence** surface with three strictly separated
layers:

| Layer | Output | May claim | Must not claim |
|---|---|---|---|
| Value evidence | Purchase, appraisal, sale, owner estimate, tax reference, owner comp | What an identified source says at a date | Current market value |
| Indexed reference | Rebased range from one admissible base value plus one market index | "Market-index-adjusted reference" and exact formula | AVM, comparable-sale estimate, appraisal |
| Forecast | 1/3/5-year market-index bear/base/bull ranges | Scenario range with assumptions and confidence | Exact future property price or investment return |

The interface must never collapse these outputs into one number. No LLM may
produce a value, alter a range, select evidence, or write an observation. An
LLM can only summarize an already-computed result with its evidence IDs.

## Current Capability By Market

| Market | Evidence now | Indexed reference | AVM / exact estimate |
|---|---|---|---|
| Austin | Owner purchase/appraisal/estimate and FHFA metro HPI | Yes, if the owner chooses a dated base value | No. Texas has no permitted, machine-readable arm's-length sales contract in this product. County assessment remains a tax reference. |
| Phoenix | Owner evidence and FHFA metro HPI | Yes, if the owner chooses a dated base value | No until a permitted parcel/sales source is activated, sufficient historical observations exist, and temporal validation passes. |
| Bengaluru | Owner purchase/appraisal/estimate | Not until an RBI/NHB source has a documented reusable export/API contract | No. No approved property-level sales/comparable source. |

No US series is used for Bengaluru. USD and INR are never summed or compared as
one book.

## Data Model

### `property_value_observations`

Add an owner-only, append-only encrypted ledger. Public metadata is deliberately
minimal: `id`, `asset_id`, `owner_id`, `market`, `currency`, `observed_on`,
`kind`, `provenance`, `created_at`, and `supersedes_id`. Amount, source URL,
document reference, comp notes, appraisal company, and rationale stay inside a
versioned AES-256-GCM payload.

Allowed `kind`:

- `purchase_price`
- `owner_estimate`
- `documented_appraisal`
- `observed_sale`
- `county_appraised_reference`
- `county_assessed_reference`
- `owner_comparable`

Allowed `provenance`:

- `owner_entered`
- `owner_document`
- `official_reference`

Market-index results and scenarios are derived records in
`property_value_references`; they are never written back into the evidence
ledger as if they were an observation.

Triggers and grants must block update, delete, and truncate. A correction writes
a new observation with `supersedes_id`; it does not rewrite history.

### `property_value_references`

Append-only deterministic output ledger for indexed references and forecast
scenarios. It binds every result to:

- asset, market, currency, and result kind;
- selected evidence observation and its amount/date;
- source observation IDs and index values at the base and cutoff dates;
- formula/model version and input fingerprint;
- cutoff, horizon, lower/base/upper values, and coverage state.

This table is not a cache and cannot be edited in place. A newly computed result
supersedes the old result while preserving prior reasoning.

## Deterministic Calculations

### Market-index-adjusted reference

Only available when the selected base evidence and a compatible local price
index are both present:

```
indexed_reference = base_amount * (index_at_cutoff / index_at_base)
```

The UI shows base amount/date/type, source, both index values, formula, index
publication date, and an uncertainty band. The band starts wider than a point
forecast and is based on observed historical forecast error only once a market
has ten matured outcomes; before then it displays `unvalidated` rather than
inventing calibration.

The reference is unavailable, not zero, if no compatible index exists, the base
predates the series, currency differs, or the index is stale.

### 1/3/5-year scenario range

The forecast targets the **market index**, then translates the range to the
chosen base evidence only as a labelled scenario. It does not forecast an exact
parcel price.

- 1 year: persistent-trend baseline plus historical volatility band.
- 3 and 5 years: same baseline compounded only within an explicit cap and wider
  uncertainty; no apparent precision from decimal projections.
- Current numeric driver: local price-index momentum and its observed volatility.
  Mortgage-rate and local-unemployment series are collected as labelled context,
  not model features, until a predeclared point-in-time shadow proves a
  market-local improvement against this baseline. Missing inputs are named.
- No national mortgage or labour measure may become a local property fact.
- The owner may run a separate manual assumption scenario, but it is never
  written to the forecast-evaluation ledger as a Kairos forecast.

Every forecast records a cutoff and later compares itself only with a subsequent
published index observation. Historical replay must use only information
available by the cutoff date.

## UI

`My Properties` gains a **Value evidence** panel:

- Add purchase price/date separately from a current owner estimate.
- Add an appraisal, sale, county reference, or owner comparable with a source
  label and optional encrypted evidence link.
- Show a timeline with separate visual series; a county reference never joins
  a sale-price line.
- Replace the ambiguous `Your value` label with a clear evidence-type selector.

Each property also gains a **Value intelligence** card:

- Latest evidence, indexed reference, and forecast state appear as separate
  rows.
- "Why this changed" lists changed source observations, selected base evidence,
  index movement, model version, and missing inputs.
- 1Y, 3Y, and 5Y tabs show bear/base/bull paths, input date, freshness, formula,
  and calibration status.
- `unavailable`, `insufficient_evidence`, `unvalidated`, and `not_applicable`
  are first-class states.

No value card is shown for a property until the owner chooses an evidence base.
No recommendation to buy, sell, refinance, or borrow follows from a range.

## AVM Gate

A per-property "Kairos Estimate" is prohibited unless all are true for the
exact market/property class:

1. A documented, permitted source for recent arm's-length sales and relevant
   property attributes is active.
2. The data has point-in-time release/version semantics and recorded revision
   handling.
3. The model is trained and tested with temporal, geography-aware splits; no
   random split or post-sale feature leakage.
4. It beats an index-rebased baseline out of sample with published median and
   tail error by market/property class.
5. At least ten matured forward outputs establish range calibration, and an
   ongoing error monitor can retire the model.
6. The result is labelled estimate/range, never appraisal or lender-ready value.

Austin and Bengaluru fail gate 1 today. Phoenix fails gate 1 while Maricopa
collection remains `contract_pending`.

## Delivery Sequence

1. Migration and encrypted append-only evidence ledger; migrate the current
   generic owner value as `owner_estimate` without overwriting history.
2. Evidence-type UI, source labels, immutable timeline, and import linking.
3. Deterministic index-rebased reference for Austin/Phoenix only, with a
   provenance-rich API and unavailable states.
4. Persisted 1/3/5-year shadow scenario ledger and forecast-vs-index maturity
   job; wire the existing Forecasts & Learning calibration surface.
5. Owner-comparable import workflow, still no automatic listing/MLS scraping.
6. Market-specific AVM only after the hard gate above. This is deliberately not
   scheduled by calendar.

### Data-use rule

Free data already available to Austin/Phoenix is not automatically a better
forecast feature. FHFA price history is the current numeric baseline. FRED
mortgage rates and BLS local unemployment are retained as separate,
market-local context. The running BLS collector retains its tested recent
window; a longer historical intake needs its own reliable provider contract and
release-vintage check before it can support an accuracy claim. A candidate may
replace the baseline only after a predeclared rolling-origin, no-look-ahead
comparison improves both error and interval calibration on the same market.

## Acceptance Criteria

- A purchase price is never displayed as a current estimate without its type and
  date.
- Every derived reference is reproducible from stored evidence/index IDs and a
  versioned formula.
- A missing/stale index produces unavailable, never a fabricated value.
- Austin, Phoenix, and Bengaluru remain isolated by market and currency.
- No LLM, securities route, broker, score, agent, or money path reads any new
  table.
- Append-only/RLS/grant/trigger tests, dated-formula tests, no-look-ahead
  forecast tests, owner-route tests, and mobile/desktop visual tests pass.

## References

- Zillow describes its value estimate as a model using public records, MLS,
  home characteristics, prior sales and trends, and explicitly says it is not
  an appraisal: https://www.zillow.com/zestimate/
- Redfin describes MLS access, nearby recent sales, home/neighbourhood inputs,
  market coverage thresholds, and that its estimate is not an appraisal:
  https://www.redfin.com/redfin-estimate
- Current Kairos source boundary:
  `features/property-address-and-carrying-costs/SOURCE_CAPABILITY_AUDIT.md`
