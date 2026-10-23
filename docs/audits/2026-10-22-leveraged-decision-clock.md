# Leveraged decision-clock repair

## Verified defect and scope

Main `7eb13ae9` retained a request-start clock across provider and database I/O
in SOXL, TQQQ, SQQQ and SOXS paper doors. A valid broker venue event arriving
during the request could then be rejected as future-dated. The same clock
pattern existed in the dormant shared live door, including sequential symbols.
Live failures returned as values, rather than thrown exceptions, could also
produce a `done` liveness row. Its live capital calculation also incorrectly
used quantity as a fallback for a missing price. These are implementation errors, not evidence
that the trading policy should be loosened.

Read-only production evidence: October 22's four L1 observations were complete,
with real Robinhood bid/ask and timestamped source observations. SQQQ's 16:40
UTC paper monitor succeeded, while 20:25 and 20:26 UTC checks reported
`data_unavailable`. SOXL/TQQQ entries declined non-long research signals; SOXS
declined excessive stop risk. Those policy refusals are not repaired into buys.

## Change

- Sample decision time after quote fetches, and after downstream entry evidence.
- Recheck the entry window after fetching and at final planning.
- Reuse existing quote-time, calendar, planner, exit-ladder and persistence code.
- Preserve market-event timestamps, 15-minute qualification, stale/future
  rejection, spread/geometry checks, monitor proof and combined sleeve cap.
- Refresh each live-loop symbol's clock; record returned live monitoring and
  reconciliation failures as errors so they cannot supply healthy liveness.
- Reject missing, nonpositive and nonfinite live holding prices/quantities
  before calculating lease headroom; never substitute quantity for price.
- No migration, new schedule, dependency, broker call, live toggle, portfolio
  mutation, score/weight or stop/target-policy change.

## Verification

The new route regression suite contains 55 tests with all provider, database and
broker I/O mocked. It covers every paper door's fresh post-request events,
stale/future/missing timestamps, stop decisions, original source provenance,
window expiry during fetch and downstream research, quote-age expiry, monitor-
proof expiry and authorization. Live tests cover sequential post-fetch clocks,
failure liveness, closed entry gates and missing/invalid versus valid holding
marks; broker mutation stubs throw if called. Live-entry unit fixtures alone
override the gate locally in the test; the default gate test uses the real gate.

Removing the paper repair made 28 of its 44 tests fail; restoring it passed all
44. The extended 55-test suite passes. Final full regression: 4,239 passed,
eight skipped, zero failures (514 passing test files and one skipped).
TypeScript and staged GitGuardian secret scans passed. Both the initial and
exact-final-source scratch builds passed all 78 pages, exit zero. Existing
Supabase Edge Runtime and Vite configuration warnings remain; no new build
failure. Generated tsconfig/next-env scratch references were restored, followed
by another successful TypeScript check. No production recovery is inferred
merely from a local test.

## Release verification

Runtime commit `973c7d8212152f31fea0b2ee2c4ace950b35ca46` is pushed to main;
the remote SHA was read back and matched. GitHub's production deployment
`7268197095` references that SHA, and Vercel deployment
`dpl_EvqjgPFkSFbbwTnFptm24T3cp92G` is READY with canonical production aliases.
Anonymous GETs to all four paper doors and the shared live door returned 401
after deployment. No authorized trading cron, broker order, provider quote
probe or real financial-record mutation was used as a release test. The working
tree was clean before this documentation-only release record.

## Remaining evidence boundaries

The current market is closed. The next natural scheduled check must confirm
post-deployment monitoring and natural alert recovery; the old failure is not
manually suppressed. A trustworthy point quote with no daily high/low cannot
prove a stop was not touched in an unobserved interval. Real broker resting-
stop, cancellation/fill-race and protective-order lifecycle proof remains
unestablished; live leveraged trading remains disabled. No real order is sent
to manufacture verification. This release does not claim profitable leveraged
signals, continuous protection or completed live readiness.
