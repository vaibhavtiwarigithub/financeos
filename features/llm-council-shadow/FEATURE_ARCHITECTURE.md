# Multi-LLM Research Council and Scorecard

**Status:** Owner-approved to build on 2026-09-30. Shadow-only until evidence and a later explicit decision permit a trading integration. This supersedes the deferred annotation-only proposal dated 2026-08-20.

## Purpose

For selected, already-researched symbols, collect genuinely independent model forecasts, let the selected models challenge and revise those forecasts for a bounded number of rounds, and produce a reproducible composite score plus an orchestrator-written synthesis. Preserve exactly what each model saw, its source timestamps, model identity, token usage, and cost. Then compare every model's score and the composite with realized, benchmark-neutral returns at multiple forward horizons.

This is a testable research lane, not a claim that an LLM ensemble improves returns. It does not fetch facts from model memory as if current, and it does not change stock dimensions, eligibility, sizing, rotation, paper orders, protective orders, or live trading.

## User controls and cost guardrails

An owner-only Settings panel controls the council:

- master enabled switch; default **off**;
- 2–3 enabled model participants (any subset of configured supported providers);
- one orchestrator model, independently selectable and allowed to also be a participant;
- debate rounds from 0 through 3;
- maximum 1–5 symbols per market per day and a hard daily USD budget;
- explicit “shadow / not used for trading” status.

At least two participants from distinct providers with resolvable provider keys are required to run. The scheduler samples eligible decisions up to the configured cap, orders deterministically, and stops before exceeding its cost estimate/budget. It processes one symbol per invocation to keep work bounded, with five spaced market-local invocations as the default capacity. Each provider call has a 12-second deadline and the route has a 300-second ceiling. No fallback model can silently stand in for a selected participant: if the router returns a different model, that participant is marked failed for this forecast. Actual model identity and billed usage are recorded for every attempt, including failures through the existing `llm_call_log`.

Estimated calls per symbol are `participants × (1 + debate_rounds) + 1 orchestrator`. Settings shows this estimate before enabling. Initial defaults after owner enables are 2 participants, 1 round, 5 symbols/market/day, and a $2/day cap. These defaults are conservative starting controls, not a performance recommendation.

## Data and forecast contract

The pipeline runs after a canonical `decision_observations` row exists and only for immutable entry-candidate observations with `entry_eligible=true` and `direction='long'`. It freezes the decision-time `features`, dimension and composite scores, price/date/currency, and source provenance. It enriches that snapshot only from already-stored, point-in-time-safe relationships: `symbol_profiles` only if `updated_at <= decision_ts`; peer `decision_observations` only on the same market/session and `ts <= decision_ts`; peer `price_cache` marks only when their session date is no later than the decision date; and analyst EPS-consensus vintages only when both `available_at` and `snapshot_at <= decision_ts`. The snapshot labels these as app-provided peer/consensus evidence and explicitly distinguishes analyst consensus from company-issued forward guidance. This release does not fetch new news, competitor fundamentals, or management guidance; missing/stale fields remain missing/stale rather than being invented from model memory.

The independent prompt requests JSON with a numeric **0–100 outlook score**, confidence, a concise thesis, bull and bear cases, key risks, and evidence citations. A score means relative expected attractiveness over the next **10 market sessions**, not a price target or return percentage. That same score is evaluated against h2, h5, h10 and h20 outcomes to test horizon portability; those are separate evaluation cells, not four scores retroactively invented by the model. Facts must cite an existing path in the supplied snapshot and its recorded as-of date (or `unknown`). A model may state uncertainty; parse errors, unsupported scores, stale-only evidence, and provider errors do not get coerced into a numeric prediction.

Each model first scores independently, without seeing other model outputs. In every configured debate round, it sees peer scores and cited arguments from the preceding stage and may revise its score with an explicit change rationale. The orchestrator sees the original evidence and final participant reports and writes a synthesis, disagreement summary, and risks. The displayed **composite score is the median of valid final participant scores**, not an unconstrained number invented by the orchestrator. The orchestrator's narrative is not scored as another participant.

## Point-in-time integrity and evaluation

The frozen run stores the exact decision observation ID, input JSON/hash, source timestamps, prompt/config version, requested and actual models, stage scores/rationales, call status, token counts, provider-reported/router cost, and final synthesis. Run/prediction records are append-only. Later labels live only in evaluation joins; future returns are never added to the frozen prompt snapshot.

Mature `observation_labels` at h2, h5, h10, and h20 are joined to each forecast. For each model and the composite, the evaluator computes **per-session Spearman rank IC** against `benchmark_neutral_return`; it does not pool all symbols as independent observations. It reports raw observations, qualifying sessions (minimum five symbols per session), the existing overlap adjustment `nEffective = qualifyingSessions / horizonDays`, and a t-stat computed from the per-session IC series using that effective sample size. Under `nEffective < 12`, IC may be shown descriptively but inferential classification/t-stat is null and the row says `insufficient_evidence`. Missing/matured labels, cohort exclusions, and provider/model fallbacks are visible.

The primary prediction is each participant's initial independent score; revised/debated scores and the median composite are separate series. This prevents the system from crediting “independent skill” to a model only after it has copied peers. Every evaluation is descriptive until there are enough independent windows; no result is a causal proof.

## Security and money-path isolation

- All reads/writes use server-side service credentials; owner endpoints require `requireOwner`, scheduled endpoints require `verifyCronSecret`.
- API keys remain in the existing encrypted key vault and are never returned to the UI or written to council rows.
- RLS denies browser writes; only owner-scoped reads are exposed through the authenticated API. Service role performs writes.
- A coupling test forbids council table/score imports from the scoring, paper/live execution, sizing, exits, rotation, promotion, and learner decision modules. The current release adds no consumer to those systems.
- Enabling the council only enables measurement. A later trading integration requires a separate architecture decision and out-of-sample evidence review.

## Delivery sequence

1. Versioned settings and append-only run/forecast/turn/evaluation schema; test auth and database constraints.
2. Bounded shadow collector with independent calls, up to three debate rounds, consensus median, exact provenance, and hard call/cost caps.
3. Scheduled evaluator over matured h2/h5/h10/h20 labels using the shared cohort and IC methodology; persist each model/composite/horizon result.
4. Settings controls and council dashboard: latest score/rationale/as-of date per symbol, dissent, model identity, calls/tokens/cost, and IC evidence maturity.
5. Tests: malformed output, provider fallback, stale/missing evidence, idempotency, disabled config, cap enforcement, owner/cron auth, label maturity, cohort integrity, horizon overlap floor, and proof no trading consumer exists.

## Deliberately not included

No autonomous web research, no new paid data-source calls, no LLM edits to deterministic dimension scores, no model-generated price targets/stops, no trade decisions, no automatic provider/model rotation, no prompt-learning from future labels, and no live/paper money-path coupling. Each would need independent evidence and approval.

## Prior draft reconciliation

The 2026-08-20 draft's recommendation to defer and its binary disagreement-only success test no longer match the owner's explicit 2026-09-30 request. Its essential safety boundary (no money-path consumer) remains. This document implements model-level scores and horizon-specific rank-IC/t evidence instead of treating “agreement vs disagreement” as sufficient evaluation.
