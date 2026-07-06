# Codex Adversarial Agent-System Review — 2026-07-06

Scope: Theme Scout, ResearchAgent scoring, PaperTrader sizing/execution, LearnerAgent weight/feature evolution. I reviewed the requested code paths and local migrations. I attempted live Supabase schema verification, but the configured Supabase MCP is pointed at a different/non-Kairos project: targeted `information_schema` queries returned none of the trading tables (`decision_observations`, `agent_signals`, `paper_trades`, etc.). Treat live-schema claims below as local-code/local-migration verified only unless separately checked against the real Kairos Supabase project.

## Overall verdict

Do not fully trust live signals yet. The core idea is sound, and several important safety upgrades are real: deterministic price fills, per-market paper pools, transactional paper-fill RPC, learner challenger lifecycle, and validation gates. But the current system is still structurally undermined by data-integrity gaps in three places:

1. Missing external data can still become neutral-looking evidence and stay included in scores.
2. Validation replay does not exactly match production score construction, so a challenger can be evaluated against a different scoring rule than the one that will run live.
3. Theme Scout remains LLM-first and, in local migrations, appears incompatible with the base `watchlist` schema.

The next build priority should not be “more agents.” It should be a single shared evidence/scoring contract used by ResearchAgent, validation, paper trading, and learner tooling, with hard abstain/skip behavior when evidence is thin.

## Component trust scores

| Component | Trust score | Reason |
|---|---:|---|
| Theme Scout | 25/100 | LLM candidate generation is not sufficiently verified, local migrations do not support the inserted `watchlist` row shape, and candidates can be added even when AV confirmation is empty. |
| ResearchAgent scoring | 50/100 | Prices/scores are no longer LLM-generated, and weight renormalization exists. But sentiment/insider/macro availability is still misclassified, macro reads the wrong table, and thin evidence can still produce a long signal. |
| PaperTrader sizing/execution | 70/100 | The preferred fill path is transactional and fail-closed on RPC errors. Remaining risk is sizing correctness: Kelly can floor a no-edge bet into a real position, NAV uses cost not mark-to-market, and NaN/invalid sizing inputs are not explicitly rejected. |
| LearnerAgent evolution | 58/100 | Challenger lifecycle and validation gate are much better than direct mutation. The weak point is evidence binding: validation uses a different score formula than production, and update requests are not cryptographically/mechanically tied to the correlation result that justified them. |

## Theme Scout

### Critical

- `app/api/agents/theme-scout/route.ts:148-165` inserts `watchlist` rows without `user_id`, while `supabase/migrations/001_initial_schema.sql:187-197` defines `watchlist.user_id uuid ... not null` and `unique(user_id, symbol)`. It also writes `source`, `theme`, `reason`, `auto_added`, `expires_at`, and `updated_at`, but I found no local migration adding those columns. Current behavior: the upsert can fail or no-op silently because the error is ignored. Why wrong: same-day theme discovery may not actually feed ResearchAgent. Fix: add/verify a committed migration for all Theme Scout columns, set the owner `user_id` explicitly, and check `upsert` errors.

- `app/api/agents/theme-scout/route.ts:131-137` merges LLM candidates with AV-confirmed candidates but does not require AV confirmation. If `screenForTheme()` returns `[]` because Alpha Vantage is rate-limited or returns no feed, the LLM tickers still survive. Why wrong: Theme Scout can seed the research universe with hallucinated or weakly related tickers. Fix: require deterministic validation before insertion: ticker exists, US equity, liquid, market cap threshold, and theme relevance evidence; otherwise quarantine as “suggested only.”

### Major

- `app/api/agents/theme-scout/route.ts:15-26`, `29-39`, and `42-60` collapse provider failures, rate limits, malformed JSON, and no data into `""` or `[]`. Current behavior: the final response may simply skip or proceed with LLM-only data; there is no durable evidence event saying the source failed. Fix: write a `pipeline_stage_events`/`agent_runs` detail with source status: `ok`, `rate_limited`, `timeout`, `malformed`, `empty`.

- `lib/research-agent.ts:109-112` hardcodes the two screener buckets and `app/api/agents/theme-scout/route.ts:103-108` hardcodes generic LLM rules. Current behavior: the discovery layer does not evolve with regimes, learned feature IC, or recent false positives. Fix: separate “candidate discovery policy” from “scoring policy,” version it, and let validation measure candidate-source quality by source (`watchlist`, `theme`, `momentum`, `value`, `held`) before expanding it.

### Minor

- `app/api/agents/theme-scout/route.ts:118-124` parses the first JSON-looking block using regex. It is acceptable for a low-stakes advisory step, but fragile. Fix: use strict JSON-mode if provider supports it, then schema-validate `themes[].candidates`.

## ResearchAgent scoring

### Critical

- `lib/social-sentiment.ts:57-76` always returns a `SocialSentiment` object even when both StockTwits and Alpha Vantage return no usable data. Then `lib/data/scores.ts:140-147` converts the fallback `"Neutral"` label into a score of 50, and `lib/data/scores.ts:229` marks sentiment available via `!!socialResult`. `lib/research-agent.ts:793` then includes sentiment in weighted scoring. Failure scenario: Alpha Vantage quota exhausted + StockTwits unavailable → sentiment gets full weight as neutral evidence instead of being excluded. Fix: return `null` when both sources are missing, or add `has_underlying_data` and set `sentimentDataAvailable = st != null || av != null`.

- `lib/research-agent.ts:37-74` returns a non-null insider result with score 50 for “no data” and fetch failure. `lib/data/scores.ts:180-184` accepts that as a valid score, `lib/data/scores.ts:231` sets `insiderDataAvailable = !!insiderResult`, and `lib/research-agent.ts:795` includes insider. Failure scenario: Alpha Vantage insider endpoint rate-limits → insider remains included at full weight as neutral. Fix: have `scoreInsider()` return `{score:50, available:false, reason}` or `null` for unavailable/fetch-failed; include only when available.

- `lib/data/scores.ts:152-174` reads `danger_score` and `regime` from `macro_signals`, but `supabase/migrations/028_macro_signals.sql:2-9` defines `macro_signals` as per-indicator rows and `supabase/migrations/028_macro_signals.sql:15-24` defines `danger_score/regime` on `macro_regime`. Current behavior: the macro query should fail or return no rows, and macro falls back to 50 with “macro query failed.” Why wrong: the agent is not actually scoring current macro regime despite the product goal of working across market conditions. Fix: query `macro_regime` for latest `danger_score, regime, created_at`; optionally join latest `macro_signals` for evidence detail.

- `lib/research-agent.ts:861-862` falls back to `direction = "long"` when the LLM thesis parse fails and `analystScore >= threshold`. Combined with the availability bugs above, a thin/missing evidence run can still become a long signal. Fix: if LLM parse fails or required evidence availability is below a minimum, force `neutral` and log `abstained_thin_evidence`.

### Major

- `lib/research-agent.ts:778-814` renormalizes production scores across available dimensions, but `lib/validation/engine.ts:44-51` validates challengers by coalescing missing scores to 50 with fixed weights. Current behavior: validation does not replay the same scoring rule that production used. Why wrong: a challenger can pass or fail on an objective that is not the live scoring objective. Fix: factor a shared `computeWeightedAnalystScore(scores, availability_mask, weights, asset_class)` function and use it in both ResearchAgent and Validation Engine.

- `lib/india-data.ts:152-183` maps Yahoo fundamentals into AV-shaped fields and always sets `ov.Symbol = symbol` if quoteSummary exists. `lib/data/scores.ts:42-47` uses `overview.Symbol` as the data-available signal. Failure scenario: Yahoo returns a sparse quoteSummary with no usable valuation/margin/ROE fields → fundamentals are treated available and included. Fix: availability should require at least N real fundamental fields, e.g. `PERatio`, `ProfitMargin`, `ReturnOnEquityTTM`, `EPS`, or `QuarterlyRevenueGrowthYOY`.

- `lib/research-agent.ts:692-704` intentionally skips social, options, and insider for India. That is honest, but `lib/research-agent.ts:786-788` falls back to fixed weights when fewer than two dimensions are included. In bad India data conditions, one technical signal plus neutral defaults can still drive output. Fix: define per-market minimum evidence contracts. For India, require fresh candles plus at least fundamentals or sector/regime data before eligible long.

- `lib/chart-data.ts:62-97` and `lib/chart-data.ts:118-165` still use `execClaude` subprocess prompts to fetch historical candles. Even if the prompt asks Claude to call a tool, this remains an indirect, hard-to-verify price-data path. Fix: replace with direct data adapters only: Massive/Robinhood/Alpha Vantage for US, Yahoo/NSE for India; store provenance and reject malformed candles.

### Minor

- `lib/data/scores.ts:55-58` has `else if (pe > 40)` before `else if (pe > 60)`, so the `>60` branch is unreachable. Fix: check `pe > 60` first.

- `lib/data/technicals.ts:102-128` uses fixed RSI/EMA thresholds for every regime. This is acceptable as a baseline, but not “best trading agent in any economic market.” Fix: make thresholds part of the strategy genome and validate them per regime.

## PaperTrader sizing/execution

### Critical

- `lib/risk/sizing.ts:20-28` clamps negative/zero Kelly to the floor size instead of zero. In `app/api/agents/paper-trade/route.ts:281-290`, if a calibrated model predicts no edge (`pWin` low or payoff invalid), `kellyFraction()` returns 0 and `positionSizePct()` still returns the floor. Current behavior: a “no edge” calibrated result can still create a position. Fix: return 0 when `kellyFraction <= 0`; only apply a floor after a separate positive-edge gate.

### Major

- `app/api/agents/paper-trade/route.ts:301-314` does not explicitly validate `sizedPct`, `fillPrice`, `maxSpend`, or `qty` as finite positive numbers. If upstream model coefficients, percentiles, config values, or prices produce `NaN`, the `qty < 1` guard does not catch `NaN`. Fix: before fill/RPC, require `Number.isFinite(sizedPct) && sizedPct > 0`, same for `fillPrice`, `maxSpend`, `qty`, `totalCost`.

- `app/api/agents/paper-trade/route.ts:160-162` computes constructor NAV from `qty * avg_cost`, not current price. Current behavior: exposure and size caps are based on cost basis, not mark-to-market NAV. Why wrong: after large moves, position sizing can understate or overstate current exposure. Fix: use latest `current_price` if fresh, or quote each open position per market; mark positions stale if not repriced.

- `app/api/agents/paper-trade/route.ts:328-363` uses the transactional RPC path, which is good, but `app/api/agents/paper-trade/route.ts:365-423` still has a legacy multi-step fallback if the RPC is absent. Current behavior: if migration 071 is missing in an environment, a crash can leave partial event/trade/position/cash state. Fix: fail closed when `execute_paper_fill` is missing in production; allow fallback only in explicitly marked local/dev mode.

- `lib/risk/percentiles.ts:19-41` silently returns `null` on any query failure, causing PaperTrader to fall back to fixed stop/target. That is safe enough, but invisible. Fix: emit a stage event such as `dynamic_rr_unavailable` with the reason, so the briefing tells the user whether sizing used learned risk or static profile defaults.

### Minor

- `app/api/agents/paper-trade/route.ts:148-154` reads portfolio limit columns from `cfg`, but the earlier config query at `app/api/agents/paper-trade/route.ts:55-58` does not select those columns. Current behavior: limits always fall back to defaults unless Supabase returns extra fields not selected. Fix: include `max_gross_exposure_pct`, `max_sector_exposure_pct`, `max_name_exposure_pct`, `max_portfolio_vol_pct`, and `max_avg_pairwise_corr` in the select.

## LearnerAgent weight/feature evolution

### Critical

- `lib/validation/engine.ts:44-51` validates weight challengers with fixed weights and `null -> 50`, while production scoring in `lib/research-agent.ts:778-814` excludes unavailable/inapplicable dimensions and renormalizes weights. Current behavior: the validation result is not a faithful replay of the strategy that would run live. Fix: use the same weighted-score function and the recorded `availability_mask`/asset applicability from `decision_observations`.

- `app/api/agents/learner/route.ts:389-406` accepts LLM-supplied `n_trades` and `confidence` for `update_signal_weight` and only checks they meet numeric gates. It does not bind the mutation to a specific `query_score_correlation` result, source, dimension, horizon, or sample size. Failure scenario: the LLM can call `update_signal_weight` with `n_trades:10` even if the relevant correlation had fewer usable pairs or came from the weaker fallback. Fix: have `query_score_correlation` return an evidence token/result id; require `update_signal_weight({ evidence_id })`; server checks `n`, `source`, `dimension`, `market`, horizon, and effect size itself.

### Major

- `app/api/agents/learner/route.ts:269-307` correctly tries the observation ledger first, but `app/api/agents/learner/route.ts:307-336` falls through to `paper_trades_fallback` if the ledger query fails. Current behavior: if migrations are missing or schema drifts, learning can continue on the weaker filled-trades-only dataset instead of stopping. Fix: once the ledger is expected in production, fail closed for weight changes when ledger is unavailable; allow fallback only for read-only diagnostics.

- `app/api/strategies/versions/route.ts:64-82` has a validation gate, but `app/api/strategies/versions/route.ts:83-89` allows `force_unvalidated:true`. Current behavior: governance can bypass the statistical gate. That may be intentional for an owner override, but it should never be routine. Fix: require an explicit UI confirmation, journal the exact user id, reason, and diff, and show a persistent “unvalidated champion” badge.

- `app/api/validation/feature-check/route.ts:41-68` can promote features from proposed to quarantined/active based on fold IC, but those active features are not clearly wired into production scoring. Current behavior: the system “discovers” features, but ResearchAgent still mainly reweights five fixed dimensions. Fix: add a governed feature-to-genome integration step: active feature → shadow strategy → validation → promotion.

### Minor

- `app/api/validation/feature-check/route.ts:101-105` only exposes numeric fields from `features.<dim>`. Many useful evidence fields are strings/labels and are ignored. Fix: support explicit whitelisted encodings, e.g. `regime.trend == up`, sector one-hot, availability flags.

- `lib/validation/engine.ts:60-61` uses `Math.log(1 + ret)` without guarding `ret <= -1`. Rare for long-only equities but possible with bad labels or split-adjustment errors. Fix: reject/flag labels where `ret <= -0.99` or where split adjustment is missing.

## Cross-cutting findings

### Live schema verification is currently not trustworthy

- The Supabase MCP available to Codex returned a non-Kairos schema and targeted queries for Kairos trading tables returned `[]`. This means an external reviewer cannot currently verify the live production schema through the advertised MCP path. Fix: reconnect the FinanceOS Supabase MCP/project reference and add a read-only `/api/admin/schema-check` or script that checks required tables/columns against a committed manifest.

### External API failure handling is inconsistent

- Good: price fills fail closed when quote is unavailable (`app/api/agents/paper-trade/route.ts:181-194`).
- Weak: sentiment and insider failures become included neutral scores.
- Weak: macro currently reads the wrong table.
- Weak: Theme Scout source failures are not recorded in a durable quality ledger.

### Too many parameters are being watched without enough evidence contracts

The current five-dimensional score is acceptable as a first baseline, but “more parameters” will hurt unless every parameter has:

1. an availability flag,
2. a freshness timestamp,
3. a source/provenance,
4. an abstain rule when unavailable,
5. an out-of-sample validation path,
6. a retirement rule when live IC decays.

Right now the system has pieces of this, but not one enforced contract across all agents.

## Recommended fix order

1. Fix score availability semantics: sentiment, insider, macro, India fundamentals. Missing data must be excluded or force abstention, not become included neutral evidence.
2. Replace validation scoring with the exact same scoring function ResearchAgent uses, including `availability_mask` renormalization.
3. Fix Theme Scout schema/user ownership and require deterministic ticker validation before watchlist insertion.
4. Change Kelly sizing so no-edge returns zero, and add finite-number gates before every fill.
5. Make LearnerAgent mutations evidence-bound: `update_signal_weight` must reference a server-created correlation/validation evidence id.
6. Add a schema contract check against live Supabase before every deploy/cron registration.

