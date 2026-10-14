# Feature Architecture: Score Formula Forward Shadow

## Status
**Approved and implemented 2026-10-14** (owner chose "Build forward shadow"). Measure-only. Nothing in scoring, gates, sizing or trading reads it.

## Why
`docs/audits/2026-10-14-us-book-vs-xlk-and-score-quality.md`: over 2026-07-06..10-13 the live US composite's top fifth underperformed in both halves of the window (-0.42%, -0.76% excess at 10 sessions) while a fundamental-only ranking was positive in both (+1.21%, +0.32%). The variant choice was made while looking at that data, so it cannot count as evidence. This feature makes it countable.

## Design
- **Pre-registration.** `score_variant_registry` holds the three formulas of `variant_set_v1` with a `declared_at` (2026-10-14 15:06:19 UTC) and is append-only (update/delete blocked). Changing a weight means a new set id.
- **No producer.** A variant score is a pure function of dimension scores already stored on every `decision_observations` row, so the evaluator recomputes it from stored data. Unavailable dimensions (availability mask) are EXCLUDED, never neutral-filled.
- **Forward vs hindsight.** `forward` = observations at or after `declared_at`, the only evidence. `hindsight` = earlier observations, shown for reference and labelled so on the Learning page.
- **Paired baseline.** Each variant is compared with the live `analyst_score` on exactly the same rows.
- **Variants:** `fundamental_only` (fundamental 1.0); `fundamental_sentiment` (0.30 / 0.20); `composite_ex_insider` (fundamental 0.30, technical 0.25, sentiment 0.20; macro omitted because it is one value per day and cannot rank).
- **Metrics (per market, horizon 5 and 10 sessions, benchmark-neutral returns):** per-session rank IC, mean excess of the top fifth and bottom fifth, spread, overlap-adjusted t.
- **Evidence gate (same discipline as the LLM council):** at least 20 sessions and 12 effective windows (sessions / horizon) before a cell is called measured. Roughly 60 forward sessions at h5 and 120 at h10.
- **Adoption gate (recorded in the shadow registry):** gate met, spread t >= 2.4 (Bonferroni for 3 variants), spread above the live composite, positive top-fifth excess, US and India separately, then separate owner approval and the existing challenger-promotion path. This feature never activates anything.
- **Schedule:** nightly 15:10 UTC (`kairos-score-variants-eval`), route `/api/agents/score-variants/evaluate`; viewer-safe read `/api/learning/score-variants`; panel `ScoreVariantsPanel` on the Learning page.

## Honest limits
- The earliest readable forward verdict is about three months away at h5 and six at h10; until then the forward table shows "insufficient evidence" by design.
- Three variants x two horizons x two markets is a multiple-comparison surface; the t >= 2.4 requirement addresses the variant count only.
- India has no sentiment, so `fundamental_sentiment` and `composite_ex_insider` will have few or no India rows; `fundamental_only` is the meaningful India test.
- A fix for the insider scorer (routine selling scored as bearish) is a separate shadow-first proposal, not part of this set.
