# Prospective paper stop/target history — October 27, 2026

Owner approved atomic append-only recording after the first ladder release. This follow-up completes that approved slice. It does not change trading policy, position sizing, orders, current financial rows or existing historical trades.

## What is recorded

Migration `20261027150134_paper_position_plan_history.sql` adds a compact event ledger and AFTER INSERT/UPDATE capture triggers on the existing paper position table. Entries, actual level changes, null target removal and identity/epoch changes are captured within the same transaction as the position change. Price-only and no-op updates add no rows. All US/India paper roles are covered, including leveraged positions; crypto/live books are outside this approval. History survives closing/deleting the current position row.

Fourteen current baselines were captured at 15:01 UTC / 10:01 AM America/Chicago: six US and eight India. Existing financial positions were not updated. These are current observations, never a reconstruction of earlier changes. The migration serializes seeding/capture under a short position-table lock with a five-second lock timeout and thirty-second statement timeout. Reapply does not duplicate baselines.

## Reader and chart

The existing authenticated position-history endpoint batches verified open position IDs, enforces market scope and paginates the new ledger with a 10,000-row cap. The builder checks exact symbol/role/opened-at epoch, latest creation/reset, old/new continuity and reconciliation to the current plan. Read failure, malformed evidence or a race remains unavailable; a cap is disclosed. Current snapshots never prove a historical change time.

The existing share/price ladder now draws recorded stop/target steps from the first saved observation forward. Event details show old → new values, target removal as none, and recording-start/current provenance. Earlier history remains explicitly unknown. Share counts and realized sale P/L are unchanged from the verified prior feature.

## Verification

- Actual PostgreSQL 17 isolated migration/proof passed: US/India/leveraged inserts, crypto exclusion, unchanged/price-only updates, stop movement, target removal, epoch resets, shared transaction rollback, simulated audit-write failure rollback, close retention, update/delete/truncate refusal and ACL/RLS. Reapply preserved six synthetic audit rows. Reproduce only in a disposable database using the two tests/sql setup/proof files and this migration; never production financial fixtures.
- Production catalog: 12 columns, RLS enabled, two enabled capture triggers, two enabled immutability triggers, no anon/authenticated SELECT, service SELECT only and no service INSERT, zero missing current baselines. Migration history name/version matches the checked-in filename.
- Production default sequence USAGE grants were detected and removed by forward migration 20261027150520_paper_plan_event_sequence_acl.sql. All anon/authenticated/service sequence usage and direct capture-function execution checks are false. An additional isolated service-role position insert/update still captured both events with these grants revoked (	ests/sql/paper-position-plan-sequence-proof.sql).
- Security/performance advisor rule groups and counts unchanged before/after. Existing unrelated findings remain; this does not claim all advisors are clean.
- 36 focused tests, all 4,523 regression tests (eight skipped, zero failures) and TypeScript passed. Secret scan, remote-main/deployment SHA and production browser proof are recorded in WORK_LOG at delivery.
- No manual trading cron, broker order action, extra model inference, paid service or historical financial rewrite is used for verification. A naturally occurring level change is awaited as forward production evidence; none is manufactured.

## Rollback

A renderer/read defect can revert the consumer while leaving the small append-only ledger intact. If capture demonstrably causes unexpected position-write failures, stop affected automation through the existing controls and investigate; restore capture with a reviewed forward migration rather than deleting evidence or bypassing financial gates. An audit-write failure deliberately rolls back its associated position update, preserving the approved atomicity requirement.

## Production delivery proof

Runtime eab3fd153877cb741aa3520597c3ccf027a0d9c matched remote main. Vercel dpl_5FFawDck72LdcWgHrqSpd9cPZPTv was READY and aliased the canonical production URL. Authenticated UI/API200 verified six US and eight India recorded histories, private/no-store responses, real baseline provenance and recording-start labels. No console errors or overflow at375/768/1440. A browser-response-only before/after and target-removal fixture rendered its marker and expanded details, then was removed and actual data restored. The production ledger still contains exactly fourteen genuine baselines and no manufactured changes. The first naturally scheduled level update remains forward evidence to inspect; local SQL proof and enabled production capture are verified without pretending such an update already happened.
