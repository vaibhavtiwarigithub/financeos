# Guardian exact-stop outcome scorecard — release verification

Date: 2026-10-22. Tier: standard feature QA, Chrome, US and India.

## What is measured

Live Portfolio → Recommendations & Guardian scorecard → Do Guardian’s suggested
stops help? One shared component exposes separate 2/5/10/20-session stop-versus-
hold outcomes. The suggested stop, quantity, issue timestamp and measurement
contract are frozen. Mean, median, notional-weighted and monetary differences
include upside sacrificed, not just losses avoided. All are modeled scenarios,
not realized portfolio profit or causal attribution.

The common reference is the next regular session's open; daily bars cannot
observe the remaining issue-day intraday path. Gaps fill at the worse of the open
and stop. An illustrative 10 bps extra sell cost is disclosed. Source stop-rule
lineage is unrecorded, not invented. Missing prices, known corporate actions,
unsupported calendars, legacy advice and overlapping revisions are not graded.
Frozen first matured windows are not silently restated. Real responses require
an unambiguous linked broker fill; arming and holding reductions are not fills.

## Evidence

- Migration `20261022214835_guardian_exact_stop_outcomes` applied and queried in
  the production tracker. All three columns, both capture triggers, RLS,
  invoker/search-path settings and service-only execution grants verified.
- Rollback-only synthetic database test proved capture at current time rather
  than old fill time, ledger append-only denial, matching-plan deduplication,
  plan revision capture, same-stop deduplication and recommendation append-only
  denial. Zero synthetic ledger/recommendation rows remained afterward. No
  broker order or real holding was created.
- Repeated capture under `service_role` itself, and negative fixtures for an
  agentic buy, manual sell and baseline: only genuine manual-buy advice can be
  captured. All transactions rolled back; zero fixtures remained.
- Security-advisor categories/counts unchanged before/after: 113 service-table
  no-policy informational findings, 7 existing search-path warnings, and one
  each existing extension, authenticated-definer and password-protection warning.
  These are not represented as repaired by this feature.
- Initial runtime `f849d86f` deployed READY with production aliases assigned:
  `dpl_8bymEgVk6QVZq7vCszX4oFBrDPKM`.
- Invoked the existing measurement-only endpoint once. At 22:06 UTC both market
  `agent_runs` were `done`; US persisted `guardian_exact_stop_v1` with all four
  horizon cells marked legacy, null performance, and unknown execution. India
  correctly recorded zero suggestions/zero matured cells. No producer alert.
- Active existing nightly schedule verified as `30 22 * * *`. No new schedule,
  model call, order, stop setting or live enablement was added.
- Anonymous requests to both owner scorecard APIs returned 401.
- Authenticated Chrome verified both market headings and horizon controls.
  US showed the historical stop with unknown frozen quantity and no fabricated
  return. India explicitly distinguished no app suggestions from broker GTTs.
  At 375px, the 680px table scrolled inside a 300px region; page width was 371px.
  At 768px and 1440px there was no page overflow; no console errors observed.
- Standard private-dashboard smoke: one H1, language en, no missing image alts.
  Search-engine schema/canonical/social-card requirements are not applicable to
  this authenticated financial dashboard. Cross-browser QA was not performed.
- TypeScript and focused regression passed (42 tests); final full regression:
  4,184 passed, 8 skipped, zero failures. Staged secret scans passed.
- Production local scratch build completed all 78 static pages, exit 0. The
  first normal build hit the known OneDrive `.next` readlink EINVAL; the fresh
  scratch build avoided it. Generated tsconfig/next-env references were restored;
  no scratch path is committed. Existing Supabase Edge Runtime warning remains.
- Staged secret scans passed. All implementation commits are pushed to main.

## Remaining evidence, not unfinished measurement code

Production currently has one unversioned historical US stop and no app stop
suggestions for India. There is no defensible historical average benefit yet.
Forward suggestions and full horizons must occur naturally before results exist.
Full India stop suggestion/approval/execution is a separate unbuilt program;
this release deliberately does not manufacture it or widen trading permissions.
No confirmed real broker fill was generated to test the scorecard. Its strict
matching and partial-fill behavior are covered by synthetic fixtures only.

Mobile review identified the US panel being buried below legacy ideas. Follow-up
`e3800edf` puts it first, matching India, improves measurement text contrast and
keeps versioned advice out of the legacy-only references section. This deployment
is READY (`dpl_3k5GXcFKwaiWy3nxTyDcteE6XqgT`); authenticated desktop verification
confirmed the exact-stop outcome table precedes the generic recommendation table.
`0242a4d4` further distinguishes expected corporate-action exclusions from a
failing producer and freezes those completed excluded windows, avoiding both
permanent false health warnings and repeated raw-price requests. Its final
deployment is READY (`dpl_6J2fSbg5LnwAFjMABnQh3guQWRP9`, aliases assigned to
`0242a4d4`). The older experiment is explicitly labelled “Generic buy-idea
stop-rule experiment” and “not actual Guardian suggestions,” rather than implying
that 135 hypothetical ideas are genuine stop-advice outcomes. No stop is revised.
