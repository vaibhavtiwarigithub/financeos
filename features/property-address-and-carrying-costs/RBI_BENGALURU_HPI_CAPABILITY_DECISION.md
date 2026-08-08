# RBI Bengaluru HPI Collector Capability Decision

**Decision date:** 2026-08-08
**Status:** `manual_only`; no collector, source adapter, cron, or database change

## Verified facts

RBI publishes an all-India and city-wise quarterly House Price Index. Bengaluru
is one of the covered cities, and RBI directs readers to the Database of Indian
Economy (DBIE), Real Sector -> Price & Wages -> Quarterly, for the time series.
The series is appropriate only as a **Bengaluru city-level price-index
reference**. It is not a locality, PIN, parcel, rent, tax, listing, or
property-value feed.

Official sources:

- RBI HPI release and DBIE path: https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=51771
- RBI DBIE portal: https://data.rbi.org.in/
- RBI HPI methodology reference: https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx

## Why no adapter was added

As of this review, the official public material verifies publication and the
interactive DBIE destination, but does **not** provide all of the contract
required by Kairos' collector architecture:

1. a documented, unauthenticated, machine-readable endpoint or published file
   URL for the Bengaluru series;
2. documented request parameters, rate limits, revision semantics, and stable
   field definitions; and
3. explicit automated reuse terms for scheduled application collection.

Calling an undocumented DBIE endpoint, replaying browser requests, or parsing
the DBIE page would violate the Property source policy. A successful one-off
request would not turn that into a supported data contract.

## Activation gate

`RbiBengaluruHpiAdapter` may be introduced only after an RBI-published source
manifest records all of the following:

- canonical download/API URL and RBI publisher;
- CSV/JSON/XML schema containing city, period, index value, base/rebasing and
  revision/publication fields;
- Bengaluru selector and quarterly cadence;
- automated-use licence/terms, attribution and retention requirements; and
- rate limit and failure/revision handling.

The adapter must emit only `price_index` observations for `bengaluru`, retain
the RBI publication/version metadata, write through the existing append-only
`property_market_observations` ledger, and remain isolated from Investing. It
must never infer an individual property value or replace owner evidence.

## Current product behaviour

The Property source registry deliberately keeps `rbi-hpi` as `manual_only`.
The Data Sources page can link the official portal, while Bengaluru uses owner
evidence for property-specific values and costs. This is an honest coverage
state, not a collector failure.
