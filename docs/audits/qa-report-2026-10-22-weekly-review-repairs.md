# QA: confirmed weekly-review repair batch

Date: 2026-10-22 (America/Chicago). Scope: six accepted repair areas from the
independently triaged partial weekly review. This is not a full application audit.

## Implementation

- One current-session newest-assessment reader shared by paper, legacy proposal,
  autonomous live and autonomous shadow. Downgrade/neutral/completed assessments
  defeat older pending highs before buy filtering; held top-ups stay separate.
- Atomic service-only research publication, with a per-market/symbol transaction
  lock, rollback of supersession on insert failure and server-side deadline check.
  No untagged legacy fallback, historical score rewrite or backfill.
- One shared 20-second capacity-refresh budget, two workers and existing five-name
  leases. Abort checkpoints prevent later research phases; already dispatched
  provider work may finish/cache. Expired work cannot publish executable signals.
- Protective cancellation requires an atomic owner and final zero-fill cancellation.
  Unknown/canceling state blocks another sell. A canceled stop plus an uncompleted
  exit is recorded for reconciliation; the stop's terminal canceled status remains
  true. No blind replacement, live flag change or claim of broker lifecycle proof.
- System Health does not hide broker reconciliation/order faults as owner actions.
  Legitimate login/reconnect/PC actions stay separate; critical notices remain failures.
- Vault responses have an explicit masked allowlist/no-store header; owner writes
  require same-origin JSON. The approved removal of the redundant PIN is preserved.
- The existing shortlist explanation now includes newer capital-rotation decisions.

## Verification completed before release

- Initial focused run exposed five expected old-contract/mock mismatches. Updated
  expectations to newest assessment (not historical maximum), shared reader and
  cancellation compare-and-swap. No failing test was simply skipped.
- Full suite after repairs: **4,155 passed / eight skipped / zero failed**.
- Pure in-memory mutations of recency and broker classification produced the
  incorrect behavior and were detected by the same invariant checks. No source
  mutation was left behind. The first probe needed ES2022 transpilation for Map
  iteration; that harness error was corrected, not reported as an app failure.
- TypeScript passed; isolated Next build compiled and generated all 78 static pages,
  exit zero. Only existing webpack cache/Supabase Edge Runtime warnings. Generated
  scratch tsconfig/next-env references restored. A final deployed build remains
  the authoritative check for the last small source follow-up.
- Confirmed all four active equity paper-trade cron callers use 120,000 ms HTTP
  timeout; no cron schedule or timeout was changed.
- Additive migration applied as **20261022133418_atomic_research_signal_publish**.
  Verified SECURITY INVOKER, fixed search_path, service-role EXECUTE only, no
  anon/authenticated EXECUTE. Security advisor categories/counts unchanged.
- Rollback-only production fixture exercised publish/downgrade, deadline refusal,
  failed-insert rollback, US/India isolation and stage revalidation. The initial
  fixture incorrectly assumed research_packet_id had an FK; inspected actual
  constraints and used the existing mandate_id FK instead. Corrected fixture
  passed; follow-up count proved **zero synthetic signals remain**.
- Tests use mocked model/broker collaborators. No paid research, real order,
  protective placement/cancellation, account setting or portfolio mutation was
  triggered for verification.

## Release and smoke checks

Pending final push/deployment identity and canonical smoke verification. Keep
runtime status distinct from local verification; do not declare this deployed
until the exact runtime commit is READY with the canonical aliases assigned.

## Remaining boundaries

The broader 83-commit/277-file audit remains partial. Separate hypotheses about
worker identity, feed homogeneity and Guardian parity are not verified defects.
Year-boundary calendar extension remains dated maintenance. No formula/threshold,
model roster, rotation gate, risk cap or live-enable change is part of this batch.
Natural scheduled producer timing and a real broker stop/cancel/fill lifecycle
remain runtime/owner-authorized evidence, not established by mocked tests.
