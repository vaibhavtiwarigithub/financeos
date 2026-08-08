# Implementation Result

Updated on 2026-08-08:

- Stage 1 tables and immutable historical evidence remain in place.
- `maricopa-sales` and `tcad-appraisal` are database-enforced as
  `contract_pending`; existing scopes were deactivated by
  `20260808194000_defer_unverified_property_valuation_sources.sql`.
- The scope API now rejects activation, and the bulk worker returns before
  credentials, scopes, or downloads for either source.
- The GitHub workflow retains only parser and disabled-source checks. It has no
  schedule or Supabase/encryption secrets.
- The valuation UI explains the source-contract block instead of offering a
  collection control.

Not implemented: new county collection, sale comparables, AVM, repeat-sales
index, or hedonic model. These require documented and permitted source
contracts first.
