# Instrument-Aware Scoring — Implementation Result

**Implemented by:** Codex / GPT-5
**Date:** 2026-08-24
**Commit:** `b2c226d1` plus documentation/ledger hardening follow-up
**State:** P0/P1 live in measurement; P2-P5 evidence-gated

## Shipped

- `instrument-taxonomy.v1` deterministically separates operating companies,
  ADRs, banks, REITs, broad/sector/thematic/fixed-income funds, bullion funds,
  miner funds, metal producers, royalty/streaming companies, known India ETFs,
  leveraged/inverse funds, and unknowns.
- ResearchAgent stores family, exposure, benchmark, taxonomy version and score
  mode inside the immutable decision snapshot.
- Metal-family measurements record dated FRED real-yield/dollar inputs and
  settled GLD/SLV/GDX return relationships. They contribute zero score points.
- `instrument_family_observations` is an append-only measurement ledger. RLS is
  enabled; browser writes are denied; UPDATE, DELETE and TRUNCATE are blocked by
  grants/triggers while service-role INSERT remains available.
- Curated historical metal/fund rows were taxonomy-backfilled without inventing
  unavailable feature values.
- The owner-only diagnostics route collapses repeated symbol-session rows and
  substitute vehicles to independent exposure-sessions before readiness counts.
- The Research Journal shows the observed family/exposure and timestamped
  family evidence, explicitly separated from the actionable v1 score.
- An uncapped v1 family shadow row records whether the universal ETF cap destroys
  rank information. It cannot create a fill or modify policy.

## Verified production baseline

The backfilled US cohort has 37 independent gold-bullion exposure-sessions, 23
gold-miner-fund sessions and 23 silver-fund sessions. Cap-at-65 saturation is
approximately 47%, 61% and 61% respectively. India has no qualifying historical
curated ETF cohort in the new ledger. Every family therefore remains below the
60 independent-exposure-session floor.

## Approved deviations and deferrals

- No family composite was invented before feature-level forward evidence exists.
- No v1 score, threshold, paper selection, sizing, exit or live-money behavior
  changed.
- Exposure-level vehicle selection, family-local walk-forward evaluation,
  exploratory paper sleeves and promotion remain P2-P5. They cannot be declared
  complete merely because their code could be written; the forward observations
  and owner decision are part of the acceptance contract.

## Verification

- Focused tests: 14 passed.
- Full suite: 2,044 passed; 7 skipped.
- Next.js production build: passed.
- Supabase migrations `20260824183930`, `20260824185010`, and
  `20260824190302`: applied and directly verified.
- Production Vercel deployment: Ready.

## Owner-approved applicability correction (2026-10-20)

The owner later explicitly approved correcting structurally invalid dimensions
so they do not contribute to a symbol's composite. This is separate from
promoting any family-specific shadow feature. The shared
`dimension-applicability.v1` contract now gates both evidence-only collection
and the five-dimension availability mask, persists per-dimension state/reason in
the existing decision feature JSON, and labels the states in Research Journal.
It corrects India-listed ETF ordering and prevents a present-but-disabled India
feed from entering the score. This can change research scores/paper eligibility
for affected instruments; it does not change base weights, thresholds, sizing,
exits, order controls, or live flags. India funds with only one applicable
dimension still abstain under the existing minimum-two-dimension rule.

Shipped to `main` in commit `ba81cb8e`. Vercel production deployment
`dpl_EHbZoDnMbgYKL9LErb5Gr88dkY2t` completed `READY` and owns the main
FinanceOS production aliases. Focused tests: 27/27; full suite: 4,047 passed,
7 skipped. Source-only TypeScript check passed with stale `.next/types` excluded;
Vercel's production build also completed type checking and prerendered all 78
static pages. GitGuardian staged secret scan found no secrets. No migration was
needed. Pre-correction and post-correction score observations must remain
separate by code version.

## US long/inverse macro direction challenger (2026-10-28)

Reused the read-only Learning macro outcome route and existing matured
`observation_labels`. The bounded comparison covers SPY, QQQ, SOXX, SOXL, TQQQ,
SOXS and SQQQ. It reports the persisted bullish-oriented `macro_score` and a
separately named exposure-oriented score (unchanged for long exposure, inverted
for SOXS/SQQQ) against absolute instrument returns. Family benchmark-neutral
rows remain separate. Session grouping uses the frozen technical bar's
`as_of` date, not a potentially weekend decision-write date; instrument rows
can still be measured if the benchmark mark is missing. No formula, weight,
score, position, prompt, model, schema, or trade behavior changed.

Read-only production evidence demonstrates why this should be measured but
not promoted: the Oct 23 SOXL record had composite 46, macro 65, technical 20,
`new_entry_allowed=false`, and a later matured h2 absolute return of +23.00%;
SOXS on the same session had composite 80, the same macro 65, technical 100,
`new_entry_allowed=false`, then returned -20.59%. The separate natural Oct 27
SOXL door run rejected a $49.01 minimum at $0.000509 paper cash. These are two
specific postmortem observations, not evidence for changing either the scoring
or leveraged-entry policy. Current horizon-spaced symbol samples are sparse;
the read-only audit is in `docs/audits/2026-10-28-soxl-inverse-timing.md`.

Focused tests passed (macro evidence 6/6; symbol council route 1/1). Full
verification and release status must be recorded in `WORK_LOG.md` before this
change is treated as complete.
