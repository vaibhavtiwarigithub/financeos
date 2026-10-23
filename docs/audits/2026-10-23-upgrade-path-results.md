# Upgrade Path: result-pipeline repair

## Diagnosis

The complaint is justified, but collecting negative or inconclusive results is
not itself a failure. The implementation was obscuring three different problems:

1. A raw-label reader had a 20,000-row cap across all horizons. US exceeded the
   cap; consumers replaced the failed read with an empty array and reported no
   matured evidence. In reality, h10 has 6,629 labels across 81 dates, including
   986 entry-candidate observations. India has 1,985 across 79 dates, including
   661 entry-candidate observations. Neither date count is independent sample size.
2. Nine registry definitions lacked status adapters for one or both applicable
   markets, even though their existing source-health probes saw real rows.
   Existing council, formula, insider and event evaluation tables were not
   connected to their Upgrade Path cards.
3. Most performance-eligible paths do not have verified portfolio-level paired
   replay producers. Source collection cannot cure a missing comparison program.
   Analysis readiness was visually conflated with enablement readiness.

Other confirmed faults: a weekly allocation job inherited the daily replay's
96-hour liveness bound; India-inapplicable programs inflated the performance
denominator; exogenous-risk metadata still described actively populated source
ledgers as inert; earnings observations read an unordered capped page, showed
an old watermark, and treated different symbols reporting on one date as a
single event. Repetition warnings in coverage became a permanent collection
block as the universe grew.

## Implementation

- Extracted the existing collection-health reader; both owner-gated APIs reuse
  it. Upgrade Path requests only the selected market, and the UI no longer
  separately fetches the all-market audit.
- Applied service-only invoker RPC `get_upgrade_path_label_coverage(text)` in
  migration `20261023135524`. It aggregates all matured horizons in PostgreSQL
  and uses the existing explicit-context/legacy-source entry cohort. The raw
  h10 geometry read remains bounded and reports failure explicitly.
- Added a deterministic completion assessment: repair, implement a comparison,
  collect declared evidence, review analysis/results, parked, or inapplicable.
  Each card and the prioritized queue show exact next action, owner and review
  date. No state grants automatic activation.
- Read existing, exact market/set/batch council, formula-variant, insider and
  India event results. Show bounded previews and links to full Learning tables;
  failed, oversized or stale evaluations cannot become fresh results. No new
  inference or statistical recomputation is performed by these reads.
- Excluded inapplicable markets from completion and attribution denominators.
  Preserved synthetic-versus-Kairos attribution and ATR's two-block requirement.
- Added explicit per-job cadence overrides: weekly allocation assessment 240h,
  daily allocation replay 96h. Kept both schedules active and unchanged.
- Corrected exogenous source metadata to reflect existing Vercel collectors,
  without claiming official RBI/MoSPI coverage or enabling any regime reader.
- Ordered earnings' latest 1,000-row sample, disclosed its cap and used symbol
  plus report date for event identity. Moved repeated-observation caveats from
  collection blockers into visible inference warnings; inference gates unchanged.

## Production evidence inspected

- 35 definitions / 60 applicable market views.
- Before cadence repair: 33 fresh, 20 valid event-driven waits, six expected
  empty/inactive views, one false stale schedule. Existing source counts include
  council US 1,369 / India 511; setup experts US 18,402 / India 7,483.
- Latest council batch: 88 cells per market, all insufficient. The US fixed
  formula batch has 12 cells: three hindsight-descriptive, nine insufficient;
  all six forward cells are insufficient and no cell meets adoption. India has
  12 insufficient. Insider US has two insufficient; India event has 24
  insufficient. These are not adoption passes or portfolio-return improvements.
- Attribution ledger: 21 measured rows, all synthetic international allocation.
  No qualified Kairos paired-book result found. US ATR has 20 snapshots through
  October 22, with only one complete ten-session return block. The initial
  snapshot is not a return interval. Latest producer run collected successfully.

## Verification

- Production RPC exists; SECURITY INVOKER, pinned empty search path; anon and
  authenticated EXECUTE denied, service role allowed. Real market counts read
  through the RPC and raw h10 status reader agree on the expected cohorts.
- Before/after security advisors unchanged: 113 informational service-only
  RLS/no-policy findings, seven existing search-path warnings, and the existing
  extension, authenticated-definer and leaked-password-protection warnings.
  This migration adds none; this is not a clean bill of health for the entire DB.
- TypeScript passed. Full suite: 4,328 passed, eight skipped, zero failed.
  Focused final repair suite: 71 passed. Isolated Next build generated all 78
  pages and exited zero; its generated TypeScript-path edits were restored.
  Focused coverage includes authorization before client creation, invalid
  market, separate batch/set/market, insufficient labels, stale/read/cap failures,
  no revival of US-only programs in India, ATR snapshot overlay before completion,
  synthetic labeling, per-job cadence and unchanged activation boundaries.
- Production build and browser/deployment results are recorded below after
  verification. No manual trading collector, paid model call, order, score,
  threshold, roster, risk setting or position was changed.

### Production-load correction

The first deployed browser check exposed a real statement timeout in the new
aggregate and older label-watermark reads. An isolated successful query was not
sufficient proof. `pg_stat_statements` confirmed watermark queries approaching
the existing eight-second timeout, and the raw h10 query also lacked its matching
index. Applied migrations `20261023142528` (fixed parameter-bound aggregate
replanning) and `20261023143422` (matured-at and horizon/id indexes). No timeout,
RLS, privilege or statistical gate was relaxed. The watermark now uses an
index-only scan; EXPLAIN measured 2.49ms. Warm US aggregate API reads measured
221ms with unchanged 27,720 all-horizon / 8,223 India totals. Cold transport and
other readers still require deployed end-to-end verification, not a guaranteed
latency claim.

The aggregate is read before the legacy status fan-out; collection probes run
in batches of four. A concurrency test verifies that bound. Read failures now
hide numerical progress rather than displaying zero labels or a zero-filled
progress bar. Migration filenames match the actual versions assigned by the
production runner, not the earlier locally generated timestamps.

The raw h10 reader also changed from OFFSET to immutable-id keyset pagination,
retaining the 20,000-row bound and refusing non-advancing cursors. After indexing,
direct API proof read all 6,629 US rows in 2.51s and all 1,985 India rows in
0.42s without error. This avoids rescanning every earlier joined row at each
successive page. The page does not start another same-market poll while a read
is in flight; changing markets still isolates responses by sequence.

### Deployment and UI evidence

Runtime `ac0104de` is on `main`; Vercel deployment
`dpl_6hgmtwN9Eev66tweH1hyHbJRqhx8` is READY with both canonical production
aliases. The final presentation change reuses `isRealIsoDate` and displays
calendar-only observations as `YYYY-MM-DD · session`, rather than converting
UTC midnight into the preceding local evening. It does not alter any timestamp,
stored label or scoring formula. Its deployment is checked before handoff.

The authenticated US page displayed the repaired completion queue and recovered
label coverage. Anonymous Upgrade Path and source-health GETs returned 401.
The browser bridge subsequently timed out twice while attempting India visual
parity verification. That check and a final screenshot are **not verified**;
no substitute synthetic image is presented as production proof. Both market
data reads, shared-component contracts and authorization tests passed directly.
Production rollout does not prove that missing performance programs are built.

## Work still required, not hidden as collecting

Verified paired portfolio producers remain missing for exit geometry,
score-exit policy, setup experts, capital rotation, challenger validation and
the downside-hedge experiment in their applicable markets. India ATR also lacks
its qualified paired source/corporate-action contract. Building these requires
the declared baseline/variant decisions, capital accounting, marks, costs and
versions—not a generic return calculation over selected winners. Other
operational collectors can produce useful diagnostics without being promised
portfolio P&L. Their missing result assessments are now explicit queue items.

This release repairs observability and result routing; it does not claim that
every experiment is finished, that any unmeasured path improves returns, or that
the remaining replay producers have been implemented.
