# Feature Architecture: Score Formula Forward Shadow

## Free-tier read reuse

Fixed and mined evaluations share each market/horizon label read within an
invocation. The loader projects both all-scored and entry-candidate-long arrays
from the same immutable source rows using the existing entry predicate. Fixed
formulas still use the all-scored population; mined formulas still use only
entry candidates. Additional mined-only horizons are loaded once on demand.
Unused retention of all-market/all-horizon rows is removed. No weight, formula,
declaration boundary, label, cohort or adoption rule changes.

## Status
**Implemented and deployed (2026-10-15).** Measure-only. Nothing in scoring, gates, sizing or trading reads it. The additive paired-spread/HAC migration `20261015164628` is applied and its columns were verified in production. The implementation is on `main` (PRs #70, #71, and UI correctness follow-up #72); the scheduled evaluator and Learning panels are live.

## Why
`docs/audits/2026-10-14-us-book-vs-xlk-and-score-quality.md`: over 2026-07-06..10-13 the live US composite's top fifth underperformed in both halves of the window (-0.42%, -0.76% excess at 10 sessions) while a fundamental-only ranking was positive in both (+1.21%, +0.32%). The variant choice was made while looking at that data, so it cannot count as evidence. This feature makes it countable.

## Design
- **Pre-registration.** `score_variant_registry` holds the three formulas of `variant_set_v1` with a `declared_at` (2026-10-14 15:06:19 UTC) and is append-only (update/delete blocked). Changing a weight means a new set id.
- **No producer.** A variant score is a pure function of dimension scores already stored on every `decision_observations` row, so the evaluator recomputes it from stored data. Unavailable dimensions (availability mask) are EXCLUDED, never neutral-filled.
- **Forward vs hindsight.** `forward` = observations at or after `declared_at`, the only evidence. `hindsight` = earlier observations, shown for reference and labelled so on the Learning page.
- **Paired baseline.** Each variant is compared with the live `analyst_score` on exactly the same rows.
- **Variants:** `fundamental_only` (fundamental 1.0); `fundamental_sentiment` (0.30 / 0.20); `composite_ex_insider` (fundamental 0.30, technical 0.25, sentiment 0.20; macro omitted because it is one value per day and cannot rank).
- **Metrics (per market, horizon 5 and 10 sessions, benchmark-neutral returns):** per-session rank IC, mean excess of the top fifth and bottom fifth, spread, and Bartlett-kernel Newey–West t-statistics with a horizon-dependent lag to account for serial dependence from overlapping labels.
- **Descriptive evidence floor:** at least 20 qualifying sessions and 12 *rough non-overlap windows* (`sessions / horizon`) before a cell is called measured. This ratio is not an estimated effective sample size, does not correct for all serial dependence, and is not itself evidence of statistical power.
- **No adoption verdict in this evaluator.** Legacy `meets_adoption_gate` values are retained for storage compatibility but are now written false; neither a t threshold nor score IC/spread is a promotion gate. Three formulas × two horizons × two markets create 12 cells (before separate samples/series), and these rank/bucket metrics are not portfolio-level P&L. Adoption would require a separately pre-registered paired, cost-aware portfolio replay, multiplicity-aware inference, independent forward evidence, and explicit owner approval.
- **Schedule:** nightly 15:10 UTC (`kairos-score-variants-eval`), route `/api/agents/score-variants/evaluate`; viewer-safe read `/api/learning/score-variants`; panel `ScoreVariantsPanel` on the Learning page.

## Honest limits
- The earliest readable forward verdict is about three months away at h5 and six at h10; until then the forward table shows "insufficient evidence" by design.
- Three variants × two horizons × two markets is a multiple-comparison surface. HAC standard errors improve overlap handling but do not solve selection bias, cross-cell multiplicity, regime instability, or portfolio implementation costs.
- India has no sentiment, so `fundamental_sentiment` and `composite_ex_insider` will have few or no India rows; `fundamental_only` is the meaningful India test.
- A fix for the insider scorer (routine selling scored as bearish) is a separate shadow-first proposal, not part of this set.

## Production verification

The Learning-page evaluator last ran on 2026-10-15. The fixed-weight forward
shadow has no qualifying post-declaration sessions yet. Its hindsight rows are
displayed only as historical reference and remain below the predeclared sample
floor. The separate formula miner is frozen globally as
`formula_mined_v1_aab358160c2e3787`; it has no US complete-case candidate, and
the UI correctly says this is an empty slice—not an unrun search—and disables
the historical fit action. The paired spread columns are populated only for new
evaluations; historical rows are NULL by design. No scores, weights, gates,
paper positions, or live trading settings were changed.
