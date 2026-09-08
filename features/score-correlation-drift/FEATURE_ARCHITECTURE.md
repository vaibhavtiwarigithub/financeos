# Score-Return Correlation Drift Detector (Stage A)

> Owner-approved 2026-09-08. **DETECTION ONLY, not causal attribution.**
> Stage B (paired-replay causal attribution) is explicitly out of scope and not
> built here.

## Problem

"We keep adding features — how do we know which feature made the correlation
between price and scores better or worse, so the app can tell if a feature
breaks it?"

## What this answers, and what it deliberately does not

This flags "a dimension's rank IC changed AFTER code_version X shipped".
It never claims "X caused it". Deploys ship weeks apart and the market regime
moves between them, so a before/after split across code_version is confounded
by construction — every surface (alert text, UI copy, this doc) must say
"changed after", never "caused by". A real causal claim needs a paired replay
(same market-local opportunities scored with and without the change) — that is
Stage B and is not built here; see `docs/arch/09-learning-loop.md`'s existing
"collaboration" finding type for why an unpaired comparison is already refused
elsewhere in this codebase (`unattributable_no_paired_shadow`).

## Reused, not reimplemented

`lib/learning/code-version-ic.ts` groups `decision_observations` (joined to
`observation_labels`) by `code_version` and calls the EXISTING
`buildDimensionFindings()` (`lib/learning/dimension-diagnostics.ts`) once per
group. That function already does the one thing that makes a rank-IC number
trustworthy: per-session Spearman IC (via `computeSpearmanIC`,
`lib/validation/feature-check.ts`), averaged, with the overlap-aware
`nEffective = sessions / horizonDays` floor and the eligible-long cohort
restriction (`lib/learning/entry-cohort.ts`). No second correlation
implementation was written — this file only groups rows and reads back the
numbers `buildDimensionFindings` already computes, so it cannot drift from
what the Dimension Rank IC panel or the learner report for the same rows.

`benchmark_neutral_return` falls back to `fwd_return` per row (both columns on
`observation_labels`, migration `060_observation_labels.sql`) — production has
real fwd_return-only rows (US h10: 11/2633; India h5: 64/934, h10: 53/786, h20:
91/515 — measured 2026-09-08) and dropping them would understate n for exactly
the small-sample cells this feature exists to police.

## Cohorts that never blend

- **Market.** US and India are always separate cells; never aggregated (per
  CLAUDE.md's Scoring Data-Truth Review Protocol, point 7).
- **code_version.** ~33-37% of `decision_observations` carry `code_version IS
  NULL` (US 2355/6298, India 599/1788 — measured 2026-09-08). Those rows are
  bucketed under `UNKNOWN_CODE_VERSION` and are NEVER used to anchor a
  regression boundary — an unknown version could span several real deploys, so
  treating it as one boundary would manufacture a false one. The UI never
  charts it either.

## Multiple-comparisons control

Up to ~50 code_versions x 6 dimensions x up to 6 horizons is a large
comparison surface. `applyMultipleComparisonsControl` (Benjamini-Hochberg)
runs only over cells that already cleared their own n/CI floor
(`measured_descriptive`); `insufficient_evidence` cells are excluded from the
correction entirely — they never get a p-value or a BH verdict, because there
is nothing to correct. This is the exact trap
`WORK_LOG.md` (2026-09-05) parked "Systematic Pattern Discovery" over: an
uncontrolled ~300-comparison table would manufacture roughly 15 "significant"
cells by chance alone at alpha=0.05.

Every cell without at least `MIN_PREDICTIVE_DATES` qualifying sessions AND
`MIN_EFFECTIVE_OBSERVATIONS` effective (overlap-corrected) observations —
both from `dimension-diagnostics.ts`, unchanged here — renders
`insufficient_evidence` with no IC, no CI, and no p-value. Never a number with
no support behind it.

## Rolling regression alert

`lib/learning/ic-regression-alert.ts::detectRegressions` walks each
`market x horizon x dimension` code_version series (chronological by
first-seen date, `UNKNOWN_CODE_VERSION` excluded) and flags the LATEST version
only if:

1. At least `MIN_PRIOR_VERSIONS_FOR_BASELINE` (5) prior `measured_descriptive`
   versions exist — with fewer, "historical variance" is a guess, not an
   estimate, and guessing a threshold is exactly what this exists to avoid.
2. The latest version's mean IC sits more than `WARN_SD_MULTIPLE` (2, `warn`)
   or `CRITICAL_SD_MULTIPLE` (3, `critical`) **historical standard
   deviations** of the prior versions below their mean. The threshold is
   derived from each dimension's own observed variance, not a picked absolute
   IC constant — a naturally noisy dimension needs a bigger absolute move to
   trigger than a stable one.

A firing alert calls `lib/system-health.ts::reportIssue` (existing
`agent_alerts` table, no migration) with `issueKey =
ic-regression:<market>:<dimension>:h<horizon>:<code_version>`, so a recurring
condition refreshes one open row instead of duplicating, and
`reconcileIssues` auto-resolves an alert whose condition is no longer active.
Detail text always states IC before/after, n before/after, the code_version
boundary, and the "changed after, not caused by" framing.

## Surfaces

- `app/api/agents/ic-regression-ledger/route.ts` — `GET` (owner-gated,
  read-only, computes the ledger + a pure non-writing regression pass) and
  `POST` (cron-secret or owner; recomputes and reconciles `agent_alerts` via
  `reconcileRegressionAlerts`). Same pattern as
  `app/api/agents/dimension-diagnostics/route.ts`.
- `components/dashboard/IcRegressionPanel.tsx` — mounted on
  `/dashboard/learning` (`LearningPage.tsx`, below the existing Dimension Rank
  IC panel). Per-dimension IC-over-code_version chart with 95% CI band,
  regression alert banners, and a table (n, mean IC, CI, nEff, BH
  significance, verdict). No statistic renders without its n.

## Explicitly not built (Stage B)

- Paired-replay causal attribution (same opportunities scored with/without a
  declared code change) — the only way to say a version CAUSED a change
  rather than preceded it.
- A persisted ledger table. The ledger is computed on read from
  `decision_observations` + `observation_labels` (both already indexed for
  this access pattern by the existing dimension-diagnostics query) — no
  migration was needed for Stage A, and adding persistence before the
  detection logic is validated would be premature.
- Wiring `POST /api/agents/ic-regression-ledger` into an actual cron
  schedule/`vercel.json`/GitHub Actions entry. The endpoint is written to the
  same cron-secret contract as `dimension-diagnostics`, but this repo's actual
  external trigger for that endpoint was not located in `vercel.json` or
  `.github/workflows/` during this change (see
  `docs/arch/05-crons-and-scheduling.md`), so wiring a new schedule without
  confirming the existing mechanism would guess at infrastructure this change
  did not verify. The route works correctly when called manually or by the
  owner's existing external scheduler; owner action needed to add the actual
  trigger.
