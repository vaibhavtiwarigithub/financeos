# Property Owner Evidence Intake

Status: Implemented 2026-08-08.

## Purpose

An owner can preserve the text of a property-tax notice or an insurance quote/policy inside the Property workspace, without turning an uploaded document into an unverified price, quote, tax bill, recommendation, or automatic payment calculation.

## Boundary

- New route/page only: `/property/imports` and `/api/property/owner-evidence`.
- Does not modify `MyPropertiesWorkspace.tsx`, `/api/property/assets`, the shared shell, market data collection, valuation, forecasts, scores, agents, broker access, or any trading path.
- Existing generic `/api/property/imports` is deliberately unchanged. This new surface cannot break future comps, rent-roll, or lender-quote imports.
- Existing `property_imports` storage is reused. No migration is needed.
- Records are append-only by product policy. This phase has no delete, edit, file upload, OCR, extraction, or LLM processing.

## Contract

Only `tax_notice` and `insurance_quote` are accepted. The server verifies the owner, validates a bounded label/date/market/text payload, computes a content hash for deduplication, then encrypts the text with the existing AES-256-GCM property vault before insert. The metadata list intentionally excludes `encrypted_content` and `content_hash`; previously stored text is never replayed to the browser.

The user-facing form states that a document is evidence only. Tax and insurance values remain owner-entered in the private property record until a future source-specific, auditable extraction design is approved.

## Acceptance

- Unauthenticated or non-owner callers cannot read or write evidence.
- A missing encryption key rejects writes with no plaintext fallback.
- The UI supports all shared property markets but never cross-sums or converts money.
- Content is capped at 1 MB and exact source text does not enter logs, URLs, or browser lists.
- Tests reject unsupported types, invalid dates, and unknown markets.
