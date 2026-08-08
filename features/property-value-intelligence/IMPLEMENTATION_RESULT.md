# Implementation Result

Implemented on 2026-08-08:

- `property_value_observations`: encrypted, owner-only, append-only dated value
  evidence for purchase price, owner estimate, appraisal, sale, county
  reference, and owner comparable records.
- `property_value_references`: encrypted, owner-only, append-only provenance
  ledger for market-index-adjusted references and 1/3/5-year index scenarios.
- My Properties now includes Value intelligence, keeping source evidence,
  derived reference, and shadow scenarios visibly distinct.
- Austin and Phoenix derive only from FHFA price-index history when the owner
  records compatible dated evidence. Bengaluru returns not-applicable until an
  approved local price-index source exists.
- Every calculation records its formula, index dates and values, source key,
  model version, and unvalidated calibration state. A user explicitly selects
  which dated evidence point may become the reference base; recording an
  appraisal, estimate, or note never changes a derived reference by itself.
- Local BLS unemployment is optional context. An upstream outage preserves the
  existing observation history and records a typed unavailable result; it never
  changes a price scenario or makes FHFA/FRED collection appear failed.

Not implemented: a Zillow/Redfin-style AVM, property-level market-price claim,
listing scrape, MLS integration, automated comparable selection, or any lending
recommendation. Those remain blocked by the architecture's source and temporal
validation gates.
