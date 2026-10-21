# Learning presentation and recovery QA

Date: 2026-10-21. Scope: owner-requested arrangement repair, no scoring/trading change.

## Findings and repair

- Production Learning was approximately 13,403px tall at desktop width: unrelated
  large evidence tables preceded the actual learning history without clear groups.
  Six named disclosures and jump links now reuse every existing panel. Prediction
  Lab remains first. No row is filtered to make evidence appear better.
- Existing council/formula/strategy section fragments reveal the right group,
  including initial load and hash navigation. Panels remain mounted, preserving
  filters; this is not a claim that hidden panels stop their existing reads.
- Comparison tables have a 440px maximum scroll height, horizontal keyboard
  access and sticky headings. Long formula definitions and limitations expand.
- Non-JSON HTTP failures previously exposed JSON parser errors. Both comparison
  readers now show a safe message and permit manual retry. Stale aborted reads
  cannot repopulate an old market/horizon. No automatic inference or retry loop.
- Removed obsolete fixed schedules/slots/threshold and ten-trade unlock claims.
  Zero-percent win rates remain visible when trades exist. The global log and
  loaded-only weight history are labelled honestly.

## Verification

- TypeScript passed; focused 27 tests passed. New navigation contracts supplement
  browser interaction checks; source assertions alone are not end-to-end proof.
- Full suite: 4,098 passed, eight skipped, zero failures (local JSON report outside
  the repository). TypeScript, diff check and staged secret scan passed.
- Local production build passed all 78 pages; generated scratch config restored.
- Initial release `5fda31fd` is READY in production (`dpl_EFUYMWP6if9mF4DKGUT618fQVswc`).
  Default desktop height was 1,463px versus the earlier approximately 13,403px;
  every existing evidence owner remains accessible. All six jump links opened
  their groups. Initial deep links, back navigation and keyboard Enter worked.
- Real interaction exposed a same-fragment edge case: manually closing a group
  then clicking its existing URL fragment did not re-open it. The follow-up listens
  to unmodified fragment clicks as well as hashchange, with symmetric cleanup;
  its final deployed verification remains below.
- Synthetic non-JSON HTTP 504 displayed a safe error; manual Retry recovered
  with HTTP 200 and cleared the error. No database write or inference was used.
- Populated US h2 retained 94 comparison rows inside a <=440px region with no
  page overflow at 375/768/1440px. Weight and equity history tabs remained usable.
- Final follow-up deployment, India and feature-control checks are pending below.

## Remaining work is not silently completed

Read-only production recheck at approximately 22:37 UTC: India has 60 Oct 21
observations, latest 07:00 UTC, all preceding the new lineage release. US has 134
observations, latest 18:02 UTC, including 60 versioned rows. The latest stored
council evaluation remains Oct 20 at 23:47 UTC for both markets and h2/5/10/20,
all insufficient; the next 23:30 UTC scheduled evaluation has not occurred yet.
These are waiting for the natural producer/window, not a reason to forge data.

The Prediction Lab audit's remaining queue still applies: natural India lineage
and evaluator verification; calibrated inference; broader simulator/constructor,
lot-cost, purge and attribution-provenance parity; separately reviewed sealed
storage, paid prompt challengers, strategy OOS validation, program-specific paired
portfolio replay and later adoption. Their data/approval requirements cannot be
replaced by a UI change or invented historical evidence. This repair does not
claim that every historic feature request or broker lifecycle is complete.
