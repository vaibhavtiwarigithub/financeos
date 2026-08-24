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
