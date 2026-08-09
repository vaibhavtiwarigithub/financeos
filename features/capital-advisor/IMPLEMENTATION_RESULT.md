# Capital Advisor Implementation Result

Implemented: 2026-08-08

## Shipped

- New owner-only `/capital-plan` workspace, reachable from both Investing and
  Property through the three-way workspace switch.
- AES-256-GCM encrypted Capital Profile, immutable profile snapshots, area
  watches, and immutable decision-run records.
- Deterministic partial-mortgage-prepayment comparison. It separates gross
  scheduled-interest savings, an owner-declared tax assumption, prepayment
  penalty, term reduction, and the hard cash-floor check. It never assumes a
  lender recast and never initiates a payment.
- Read-only property-versus-market scenario comparison. Both return ranges are
  owner-entered and clearly remain assumptions; cash floor, liquidity, and
  concentration prevent a higher midpoint from becoming a false recommendation.
- Weekly database-only area-watch snapshots after Property collection. These
  read existing observations only, use no new provider calls, and record
  `metro_only` or `contract_pending` rather than producing a ZIP/PIN/locality
  forecast without an approved source contract.
- A sealed future narrator envelope in `lib/capital-advisor/narrator.ts`.
  It contains no address, lender identifier, account number, execution
  instruction, or authority to alter the deterministic decision state.

## Deliberately Not Activated

- No live broker, bank, lender, or payment integration.
- No automatic property search, scraping, AVM, exact ZIP/PIN ROI claim, or
  Bengaluru-local conclusion. Current market evidence is metro-level only where
  the Property source contract is active.
- No LLM narrative call, allocation mutation, or auto-learning policy. The
  sealed envelope exists so a future narrator cannot receive raw private data or
  write back to a calculation. Outcome learning remains blocked until real,
  timestamped owner outcomes exist.
- No cross-currency ranking. A Capital Profile is explicitly USD or INR and a
  comparison uses one chosen currency only.

## Verification

- `npx tsc --noEmit`
- `npx vitest run tests/capital-advisor.test.ts` (4 tests)

## Required Before Expanding

1. Apply and verify `20260808223000_capital_advisor_foundation.sql` in the
   production Supabase project.
2. Obtain an approved aggregate source contract before enabling ZIP/PIN/locality
   collection or alerts.
3. Define matured-outcome semantics and a minimum sample before a shadow policy
   can be evaluated. A narrator must remain explanation-only.
