# Time-Review Exit Shadow — Implementation Result

Implemented: 2026-09-03

## Current status correction (2026-09-27)

The unconditional time stop was removed by owner decision on 2026-09-10. The
legacy P1 “next-session sale vs +5/+10 hold” baseline no longer matches the
current data-driven exit policy. Its immutable rows are historical descriptive
labels only; they do not establish current-policy benefit, matched portfolio
P&L, or Upgrade Path readiness. The scheduled route still records P0 review
observations but no longer matures new P1 outcomes. Upgrade Path classifies this
program as `operational_only` until a new, owner-approved variant is defined
against the actual current exit policy. No time-based exit was restored.

## Outcome

The original measure-only implementation captured immutable review observations
and matured hypothetical +5/+10 outcomes. Current status is described above:
P0 observation collection remains descriptive, while the scheduled route no
longer matures the retired P1 comparator. The unconditional time stop was
removed on 2026-09-10 and is not active.

## What shipped

- `time-review-v2` deterministic classifier with fail-closed score, direction,
  profitability, high-water drawdown, initial-stop-distance, active-stop, and
  target vetoes.
- Exact position/session idempotency and immutable market-local observation and
  outcome ledgers.
- Historical incumbent-next-session versus +5/+10-session outcomes with
  benchmark return, MFE/MAE, retained-stop result, and replacement-candidate
  attribution. These immutable rows do not match the current exit policy.
- v2 stores modeled incremental sell friction separately from gross per-position
  incremental return. The earlier v1 ledger hardcoded this field to zero, so its
  rows remain immutable but are excluded from v2 progress/readiness; neither
  version is portfolio-level net-P&L attribution.
- Upgrade Path treats this program as operational-only. Historical review and
  outcome rows cannot advance performance readiness or establish P&L benefit.

## Production proof

- Migration `time_review_exit_shadow` applied to FinanceOS Supabase project
  `dionkikgdmlaotvtbnfr`.
- Both tables have RLS, owner-only SELECT policies, narrow grants, and UPDATE /
  DELETE rejection triggers.
- Rolled-back transaction proved observation insertion, duplicate-key refusal,
  outcome insertion, and both append-only guards; zero synthetic rows remained.
- Supabase security advisors reported no finding for either new table. The only
  table-specific performance notices were expected unused-index INFO notices on
  the still-empty observation ledger.

## Verification

- Mutation test: inverting the exact-horizon predicate failed three detectors.
- Focused: 26 tests passed.
- Full suite: 2,449 passed, 7 skipped.
- `tsc --noEmit`: passed.
- Isolated Next.js production build: passed.

## Still gated

The earlier 20-session readiness gate and hypothetical-next-session comparator
are retired. No time-based exit was restored. Any future policy change requires
a new approved architecture, a comparator based on the current exit system, a
sealed market-local portfolio replay, and explicit owner approval. Live use
requires a separate approval.
