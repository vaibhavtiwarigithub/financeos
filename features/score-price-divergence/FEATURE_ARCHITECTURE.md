# Score / Price Divergence — Feature Architecture

Status: **Implemented** (owner-approved 2026-09-08; production evidence collection active)

## Problem

Kairos records score history and the price used at each research decision, but the
owner cannot see them on one chart. The legacy rescore job also judges only the
latest signal per symbol, resets its clock whenever a new signal arrives, assumes
the US calendar, and writes unstructured global prose into `learning_log`. That
cannot reliably answer whether conviction is falling while price keeps rising.

## Scope

1. Upgrade the existing Research Journal **Score Tracker**. With one selected
   symbol it plots the recorded decision price on a right axis and composite,
   fundamental, technical, sentiment, macro, and insider scores on a 0–100 left
   axis. Multiple selections retain the existing composite comparison.
2. Join price and scores through immutable `decision_observations`, scoped by
   market and canonical research session. Never join by symbol alone.
3. Replace the legacy latest-signal heuristic with a market-local, append-only
   measurement shadow. It identifies opposing five-session moves:
   score down at least 5 points while price rises at least 2%, or the inverse.
   Three-session events are diagnostic context only.
4. Mature h5/h10/h20 benchmark-neutral outcomes from existing
   `observation_labels`. Expose evidence to LearnerAgent and Upgrade Path, but
   grant neither automatic score nor money-path authority.

## Integrity rules

- US and India are always separate.
- Use `features.technical.as_of` as the research session when present; otherwise
  the observation timestamp is explicitly labelled as a fallback, not silently
  presented as an exchange close.
- Within a symbol/session, use the latest observation deterministically.
- Compare only observations with the same `score_source`, `scoring_version`,
  availability mask, and applied weights. A methodology change is not alpha.
- Require a positive finite `price_at_decision` and deterministic score source.
- The evidence ledger is append-only. Historical score rows are not rewritten.
- Readiness requires at least 30 primary events across 20 distinct end sessions,
  with both h5 and h10 outcomes. Readiness means review, never activation.

## Data model

- `score_price_divergence_runs`: daily market-local heartbeat and counts.
- `score_price_divergence_events`: immutable window endpoints, deltas, dimension
  attribution, provenance fingerprints, and primary/diagnostic classification.
- `score_price_divergence_outcomes`: immutable horizon outcomes copied from the
  canonical observation-label ledger.

All tables use owner-read RLS, service-role insert, and update/delete/truncate
guards. The event natural key makes scheduled retries idempotent.

## Runtime and UI

- `POST /api/agents/score-price-divergence?market=us|india` runs after label
  maturation each weekday and appends a heartbeat even when it finds no event.
- The old `/api/agents/rescore-check` route remains as a compatibility alias but
  now requires explicit market scope and returns structured evidence.
- Upgrade Path shows freshness, primary-event count, matured evidence and gates.
- LearnerAgent may summarize the ledger. It cannot mutate a weight from this
  evidence alone.

## Explicit non-goals

No change to scoring formulas, eligibility, sizing, target/stop/ladder geometry,
time stops, paper/live execution, or broker behavior. No causal claim is made
from a divergence: rising price can make valuation scores fall mechanically.

## Acceptance criteria

1. A single-symbol Score Tracker visibly overlays actual recorded price and all
   selectable score dimensions; multi-symbol comparison still works.
2. Same ticker in the other market cannot enter either chart or evidence.
3. Daily rescoring does not reset the measurement window.
4. Duplicate observations in one session collapse deterministically.
5. Version/mask/weight changes break the comparison window.
6. Empty and stale runs are visible, never reported as clean evidence.
7. Full tests, typecheck, production build, and a real owner-authenticated UI/API
   exercise pass before completion is claimed.
