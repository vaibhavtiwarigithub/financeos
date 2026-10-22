# Recent qualified candidates — implementation and release verification

Owner approved the five-session / 20-name plan on October 21, 2026 (Chicago).

## Implemented

- Shared US/India research shortlist, original/latest signal lineage and scores,
  fixed five-regular-session retention, 20 active names per market, serialized
  admission/eviction and shared bounded refresh leases.
- Research scheduler prioritizes up to five stale retained names without raising
  candidate caps. Paper and enabled autonomous-live entry runs can refresh five
  stale candidates with available slots before reading fresh signals. Two attempts
  per candidate/session; ordinary provider and research budgets still apply.
- No stale-signal revival. Fresh live selection uses latest assessment first,
  market-local day boundaries, complete pagination and current indicative entry
  plan. Downgrades, neutral decisions, missing plans and rank rejection defeat old
  highs. Active batch-relative rank gates defer isolated refresh to full-cohort
  scheduled research, not a gate bypass.
- One owner-only Candidates waiting panel on paper and both live market pages:
  original/latest scores, last research time, sessions remaining, refresh state
  and book-specific attempts. Visible-page one-minute read-only refresh; manual
  retry; shared responsive table. No Buy button, inference or broker calls in GET.
- Leveraged/inverse ETFs and crypto excluded through existing instrument policy.
  Existing holding top-ups, discovery provenance, risk, eight-name/cash controls,
  broker eligibility, live arming and protective-order requirements unchanged.

## Verified locally and in database

- Full regression: 4,131 passed, eight skipped across 510 test files (509 passed,
  one skipped). Focused lifecycle/freshness tests passed, including rank-policy
  read failure, newest-score downgrade and positive session-validation contracts.
- Production migration `20261022030420_recent_qualified_candidates` applied and
  verified in the tracker. RLS enabled; one owner read policy; RPCs SECURITY
  INVOKER with fixed search_path, service-role execute only. Neither anonymous
  nor authenticated users can execute either RPC. Security advisor counts are
  unchanged from baseline; no new shortlist finding.
- Rollback-only integration transaction exercised admission, score decrease,
  immutable expiry, stale-write rejection, duplicate lease denial, invalidation,
  renewed episode history, non-renewal after expiry, 20-name cap, weakest-name
  eviction, NULL eligibility rejection and independent India namespace.
  Follow-up reads found zero shortlist rows and zero synthetic agent signals.
- Initial ordinary local build failed with OneDrive EINVAL/readlink against an
  existing .next artifact. Fresh isolated .next/shortlist-build-20261021 completed
  successfully, generated all 78 static pages and exited zero. Only existing
  webpack cache and Supabase Edge Runtime warnings. Restored generated source
  references in next-env.d.ts/tsconfig.json; do not commit scratch configuration.

## Release and UI

Initial runtime `43a48138` is on origin/main and deployment
`dpl_FyxDRZdUE1NHbB6awawVabPmf5Lx` is READY. Canonical authenticated API checks
returned 200 for US/India × paper/live, with the five-session/20-name policy and
an honest empty launch state; invalid market returned 400. Paper Portfolio
renders Candidates waiting with no desktop page overflow. Source follow-up
retains intermediate blocked attempts after later research (rather than joining
only first/latest signal IDs); four API tests cover authorization, validation,
history continuity and missing admission evidence.

Authenticated canonical UI checks found the panel on all four US/India paper/live
views with no desktop page overflow. Anonymous API access returned 401. Browser-only
two-candidate fixtures (never written to the database) verified original/latest
score downgrade, stale-refresh state and blocker text at 375/768/1440px. The table
scrolls within its region at 375px without page overflow. Injected API failure
displayed an alert and manual retry recovered; handlers were removed and the real
zero-row state restored. Symbol links use the existing symbol-detail route rather
than an unsupported Fundamentals query parameter. Cleanly separated from this
feature: India Guardian returned its existing 503; no claim to repair that service.

The local main branch and origin/main include the implementation and follow-up
history fix; final shipping checks require a READY deployment, canonical API/UI
confirmation and a clean checkout. No extra research or trade call is needed just
to populate a demonstration row. Secret-pattern scans found zero staged matches.

## Evidence boundaries

Collection starts with new research after deployment. No historical membership,
score or P&L backfill, broker order, risk relaxation or live enablement was used
for verification. Actual next-session refresh/fill and paired forward performance
remain natural-run evidence, not established by these synthetic lifecycle tests.
This release does not promise higher returns or claim all other app issues fixed.
