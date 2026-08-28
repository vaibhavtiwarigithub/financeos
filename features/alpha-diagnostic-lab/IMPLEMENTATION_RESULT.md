# Alpha Diagnostic Lab — implementation result

> Status: **v2.2 measurement repair complete and production-flow verified**
>
> Date: 2026-08-28. Influence: `none` — no money path reads this feature.

## Outcome

The independent review's measurement defects are repaired. The Lab now measures
the declared eligible-long cohort, preserves the actual opening book and event
quantities, uses A2's exact dated statistic in A8, separates initial from current
risk geometry, fingerprints dataset content, and renders missing data as missing.

The original P0 production interpretation is **superseded**. In particular, the
claim that India selection ranked well and sizing destroyed the edge came from
the all-scored cohort, not the cohort that could actually enter.

## What changed

| area | v2.2 contract |
|---|---|
| A0 | checks duplicate/missing NAV components and benchmark coverage; permits only leading cash-only inception rows |
| A2 | eligible-long filtering before symbol/date dedup; all-scored is context-only; stable pagination prevents the 1,000-row PostgREST cap |
| A3/A5/A7 | distinct entry-date samples; missing outcomes are excluded with explicit coverage, never coerced to zero |
| A4 | matched h10 MFE/MAE; missing excursions are `unavailable`, not `neither_touched` |
| A6 | starts from the first untainted EOD mark/performance intersection; seeds persisted mark quantities; preserves partial exits and same-session round-trip causality; rejects unmatched events |
| A8 | exact A2 rows and mean daily Spearman IC; outcomes permuted within date; h10 overlap floor and seeded 2,000-draw placebo |
| A9 | reports initial-stop and current-stop R:R separately; locked-profit trailing stops remain visible |
| lineage | non-null metric/deploy version plus order-stable content fingerprints over all source ledgers |
| UI | eligible cohort is the headline; all-scored is labelled context; NULL is `—`; date units and replay rejection reasons are explicit |

No migration and no package were added. No scoring, eligibility, sizing,
volatility, stop, target, horizon, exit, paper/live state, proposal, order, or
broker behavior changed.

## Production-flow proof

The owner/cron POST route was executed locally against the production ledgers.
It wrote only `alpha_diagnostic` experiment rows.

| market | run id | eligible-long h10 IC | dates | all-scored IC (context) | A6 | verdict |
|---|---|---:|---:|---:|---|---|
| US | `624b3c85-965d-4e89-8bee-b06729a89160` | -0.0768 | 21 | -0.0101 | descriptive, 0 rejections, opening delta 0 | `collect_more` |
| India | `d9de3886-b4f8-4ecc-a54c-c9333dc83144` | -0.0083 | 17 | +0.1046 | descriptive, 0 rejections, opening delta 0 | `collect_more` |

A8 is `insufficient_evidence` in both markets because 17–21 qualifying dates at
h10 do not clear the overlap-adjusted 60-date floor. A6 currently estimates the
equal-size arm at +0.21 percentage points versus actual in the US and +0.91
points in India over only 7 and 9 mark sessions, respectively. Those values are
descriptive and do not authorize a sizing rule.

Two live-flow failures were found and repaired before completion:

1. same-session entry/exit lots were ordered as exits first and rejected; they
   now carry explicit causal ordering while ordinary exits remain exit-first;
2. `.limit(20000)` still returned only the server's 1,000-row maximum; the
   decision ledger now uses stable bounded pagination.

## Verification

- Focused adversarial and contract suites passed.
- Full Vitest suite: **2,216 passed, 7 skipped, 0 failed**.
- `npx tsc --noEmit`: passed.
- `npm run build` (Next.js production build): passed.
- Production-shaped SQL independently reproduced the cohort reversal and exact
  opening reconciliations.
- Final live route rows report `influence: none`, A0 pass, A6 zero rejections,
  and `collect_more` for both markets.

## Deliberate refusals / remaining evidence gaps

- A1 remains insufficient because the full funnel projection is not persisted.
- A4 refuses barrier ordering when both stop and target were touched and refuses
  classification when MFE/MAE are unavailable.
- A2/A8 refuse a verdict below the overlap-adjusted date floor.
- The current A6 window is too short for a policy conclusion.
- Historical closed positions cannot recover stop/target geometry that was never
  persisted. A9 is therefore an initial-vintage view of retained data.

Architecture:
`features/alpha-diagnostic-lab/MEASUREMENT_INTEGRITY_REPAIR_ARCHITECTURE.md`.
