# Feature Architecture: LLM Event Extraction Shadow (sentiment / macro tags)

## Status
**Part implemented 2026-10-13 (owner chose defaults): India, `deepseek-flash`, existing feeds.** Built: snapshots (`india_news_snapshots`), macro series, company macro-exposure betas, and the extractor `/api/agents/llm-events` (tables `llm_event_*`, kill switch `llm_event_config`). NOT built: IC / partial-IC / council-correlation evaluator (needs ~20 dated sessions), LLM filing-text exposure tags, any UI. Original proposal: 2026-10-13 after the owner asked whether LLMs can supply sentiment or macro data for the Fundamentals page and whether that overlaps the LLM council.

## Feature Purpose
Measure whether LLM-extracted structured event tags from *supplied real text* (news items, filings) carry forward-return information beyond the existing sentiment/macro dimensions and beyond the council. Measure-only; never feeds a score, gate, or trade.

## Questions It Answers
- Does an LLM-tagged event (type, direction, magnitude) predict benchmark-neutral forward returns (rank IC, t-stat, ESS ≥ 12 gate) in India, where GDELT tone is the only sentiment input?
- Is the signal incremental to the composite and to the council median (partial IC), or just a restatement?

## Scope
- Shadow dimension `llm_events` per symbol per research observation, India first (US optional later).
- Input: only text already fetched by the app (GDELT/Yahoo/NSE headlines, filings) with URL + published_at. Model sees the text, never asked to recall facts.
- Output per item (strict JSON, validated): `event_type` enum, `direction` -1..+1, `magnitude` 0..1, `horizon` enum, `quote` (verbatim span that must exist in the input), `source_url`. Rejected if quote not found in input or published_at after the observation timestamp (look-ahead guard).
- Symbol-level aggregate computed deterministically from validated items (no model-written score).
- Run through the existing subscription-worker/DeepSeek path with a cheap model; budget guard and `llm_call_log` as for the council.
- Evaluation reuses the council IC machinery (cohort key, availability-aligned labels, ESS gate), plus partial IC controlling for composite and council median.

## Non-Goals
- No change to composite, eligibility, sizing, exits, rotation, paper or live orders.
- Not added to the council packet (avoids double-counting; the council already sees sentiment/macro values).
- No LLM macro *forecasting* (survey-beating claims are leakage-prone). No model-memory facts.
- No Fundamentals-page column until the IC gate is passed.

## Current Behavior
US sentiment = StockTwits + GDELT + Alpha Vantage news; US macro = weekly MacroSentinel. India sentiment = GDELT tone (`lib/india-news.ts`), India macro = NSE FII/DII + curated RBI calendar (`lib/india-macro.ts`). Council is shadow-only and sees these dimension values.

## Proposed Flow
1. After India research, collect headline/filing texts per symbol (existing fetchers; persist raw text + hash + published_at).
2. Extraction job (cheap model, lean prompt, temperature 0) → validator (schema, quote-in-text, no future dates).
3. Deterministic aggregation → `llm_event_scores` row (immutable, unique per observation).
4. Weekly evaluator: IC, t-stat, ESS, partial IC vs composite and council; Learning page panel (owner + viewer, stored rows).
5. Decision gate: only after ≥ 20 sessions with ESS ≥ 12 AND positive partial IC does a separate proposal consider any score use.

## Data Architecture (proposed)
- `llm_event_items` (observation_id, symbol, market, source_url, published_at, text_hash, event_type, direction, magnitude, horizon, quote, model, cost) — immutable.
- `llm_event_scores` (observation_id unique, symbol, market, score, n_items, as_of) — immutable.
- `llm_event_ic_runs` mirroring `llm_council_ic_runs`.
- Migration must be verified applied to prod before dependent code ships.

## Prompt Design: minimising overlap with the council

The council is a holistic judge: it sees aggregated dimension values and returns a 0–100 score. Overlap is cut on three axes, then measured.

| Axis | Council | Event extraction (this feature) |
|---|---|---|
| Input | Frozen packet: scores, fundamentals, technicals, sentiment/macro *values* | ONE raw document (headline/filing excerpt) + its published_at. No scores, no price, no other dimension, no ticker history |
| Task | "Forecast the stock" (judgment over everything) | "What does this text report?" (reading comprehension, per document, documents never mixed) |
| Output | Score + rationale | Fixed-taxonomy tags + verbatim quote. No score, no "bullish/bearish stock" call |

Rules for the extraction prompt:
1. **Blind to the market view.** Never pass price, composite, council score, or existing sentiment. Without them the model cannot echo them, so correlation with the council can only come from real shared information.
2. **Describe, don't predict.** Direction means "effect on the company's earnings/cash flow *as stated or directly implied by the text*", not "will the price rise". Magnitude is a text-grounded bucket (guidance change %, deal size vs revenue when given), else `unknown`.
3. **Text-only grounding.** "Use only the text. If a field is not stated, return null." A quote that is not a verbatim substring of the input voids the item. Cuts memory-based answers and look-ahead.
4. **Closed taxonomy.** event_type enum (guidance, earnings surprise, M&A, regulatory/legal, management change, capital raise, contract win/loss, macro/policy exposure, other). Free-text sentiment words are not accepted.
5. **One document per call, temperature 0.** No cross-document synthesis; aggregation is deterministic code. Synthesis is the council's job.
6. **Novelty is code, not opinion.** Dedup by text hash and syndication cluster; age-decay by published_at. The model is never asked whether the market already knows.
7. **Macro handled as exposure tagging, not forecasting.** For a macro/policy item the model only tags *which channel* the text says touches the company (rates, FX, input costs, demand, regulation) and the stated sign. No "what will RBI do".
8. **Optional leakage control (evaluation variant).** Replace company name/ticker with `[COMPANY]` in a shadow arm to test whether results survive without memory cues.

Overlap is then *measured*, not assumed: (a) Spearman correlation of `llm_events` vs council median and vs sentiment dimension, reported on the IC panel; (b) partial IC controlling for both; (c) if the correlation with the council median exceeds ~0.6 after 20 sessions, or partial IC ≈ 0, the dimension is redundant and gets retired.

## Macro and sentiment data strategy (added after production check, 2026-10-13)

Production facts (decision_observations, last 30 days; availability read from `availability_mask`):
- **India:** sentiment available 0 / 1379, macro available 0 / 1379. The India composite is fundamental + technical only. FII/DII flows and GDELT tone only ground thesis text; they do not score.
- **US macro:** available 3287 / 3684, but only **2 distinct values (71, 73)** in 30 days. `macro_regime` is one market-wide weekly verdict (8 FRED series; latest 2026-10-12 yellow, danger 29, 8/8 indicators; 2 of the last 10 weeks were thin 3–4/8 coverage). A constant cannot rank symbols, so cross-sectional IC for macro is undefined by construction.
- **US sentiment:** available 3608 / 3684, 68 distinct values, p10/p50/p90 = 50/67/77 (positively skewed; StockTwits retail bullish bias), 2% exactly 50.

Principles:
1. **Numbers come from authoritative series, never from LLM memory.** The LLM only converts supplied text into tags.
2. **Macro must become symbol-specific to be a dimension.** Score = market regime (series) x company exposure. Exposure sources: rolling beta of the stock/sector to the factor (rates, FX, oil, India VIX), or company-stated exposure tags extracted once per filing by the LLM (rates, FX, commodity input, export share, regulation) and cached per quarter. This is the strongest LLM macro use: cheap, cacheable, low look-ahead, not a forecast.
3. **Sentiment is layered, not one number.** Retail crowd (StockTwits), news tone (GDELT / Alpha Vantage), and LLM event tags are separate columns evaluated separately, combined later by evidence-weighted shrinkage (as `scoreSentiment` already does for sample size), not by an LLM judge.
4. **Reliability ladder:** official series > structured vendor feeds > crowd data > LLM tags from supplied text > LLM judgment. A lower rung never overrides a higher one.

Build order (each step shadow + measured before any score use):
1. Diagnose why India sentiment and macro are masked unavailable even though GDELT tone and NSE FII/DII fetchers exist (policy exclusion vs fetch failure; read the code path and prod evidence before changing anything).
2. India macro series ingestion, no LLM (RBI policy rate, CPI, India VIX, USDINR, 10Y G-sec, Brent, FII/DII); verify each source is reachable from Vercel before committing to it.
3. Company macro-exposure tags (LLM, per filing, cached) + rolling betas, giving per-symbol macro = regime x exposure for both markets.
4. Event extraction (this feature's core).
**Step 1 result (2026-10-13, read-only):** India sentiment/macro unavailability is a deliberate policy exclusion, not a fetch failure (`applicableDimensions` in `lib/research-agent.ts`; the GDELT scoring path was retired for zero output; macro is US-FRED only). The replacement `india-news-evidence` shadow (`kairos-india-news-shadow`, daily 12:15 UTC, `MAX_SYMBOLS=20`) collects Google News RSS headlines and NSE corporate announcements into `evidence_cache_v2`. Production state: 75 symbols, one row per symbol (upsert overwrites, so NO point-in-time history is kept), 48/75 (64%) have headlines (avg 3.2), 12/75 (16%) have NSE events, only 2 and 9 rows refreshed in the last 2 days. Consequences for this feature: (a) these feeds are the natural extractor input, so no new feed is needed; (b) before any evaluation the shadow must append immutable dated snapshots, otherwise IC can never be computed; (c) coverage must rise (rotation over 20/day leaves most symbols stale).

Macro evaluation uses time-series / interaction tests (regime x exposure), not plain cross-sectional IC.

## Cost / Limits
Short texts, ~300 tokens in/out per item; cap items per symbol (e.g. 5) and symbols per day; hard daily USD cap in config; kill switch default off.

## Files Likely To Change
New: `lib/llm-events/*`, `app/api/agents/llm-events/{cron,evaluate}/route.ts`, migration, tests. Edit: `lib/shadows/registry.ts`, `lib/auth/roles.ts` (viewer-safe read route), Learning IC panel, `docs/arch/03,04,05`, `public/agent-diagrams/system-map.json`, `WORK_LOG.md`.

## Must Not Change
Composite scoring, council tables/routes, paper trader, risk gates.

## Acceptance Criteria
- Extraction rejects any item whose quote is absent from input or dated after observation.
- Zero reads of `llm_event_*` by trading code (test enforces).
- Producing rows for ≥ 1 India session end-to-end, with a prod row read and a silence alert (stale-check) proven.
- IC panel shows n/ESS/t-stat and partial IC; no claim of edge below the gate.

## Open Decisions for Owner
1. India-only first, or US too? (Recommend India only.)
2. Extraction model: DeepSeek Flash API (≈ cents/day) vs subscription workers (quota-limited). Recommend DeepSeek Flash.
3. Text sources: reuse existing GDELT/Yahoo/NSE fetches only (recommended) vs add new feeds.

## Approval
Pending. Reply "Approved, implement" (with answers to the 3 decisions, or "defaults") to start.
