# WORK_LOG.md — Active Task Tracker

> **All agents check this before starting work. Claim your task. Update when done.**
> Format: `| Task | Agent/Model | Status | Date | Notes |`

---

## Status Key
- `planned` — approved, not started
- `in_progress` — actively being worked on (DO NOT start if another agent claims this)
- `blocked` — waiting on dependency or Vaibhav decision
- `review` — done, needs Vaibhav or Reviewer check
- `completed` — shipped

---

## 🔴 In Progress

*(nothing currently)*

---

## ✅ Session 2026-07-06 (Learning-core Phase 3 — genome, feature registry, shadow decisions, regime features, governance rewiring)

> Completes the full learning-core roadmap (Phases 1–3 + all P0s + Execution Gateway paper-stage). See **Decision 37**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Typed strategy genome | Claude | 2026-07-06 | Migration 063 (`strategy_versions.genome`, `agent_signals.genome_hash`) + `lib/validation/genome.ts` (hard-bounded validation, diff counting, hashing). Genome-less rows unaffected. |
| Feature registry + whitelisted compiler | Claude | 2026-07-06 | Migration 064 (`feature_registry`) + `lib/validation/feature-compiler.ts` (from-scratch tokenizer/parser/evaluator — `+ - * /`, `log/abs/min/max/lag` only, no eval/no dynamic code). New `propose_feature` learner tool. |
| Feature IC-check job | Claude | 2026-07-06 | `lib/validation/feature-check.ts` (Spearman rank-IC + Fisher-z significance, pure/tested) + `app/api/validation/feature-check` (weekly cron) — promotes proposed→quarantined→active, auto-retires decayed features. |
| Shadow decisions | Claude | 2026-07-06 | Migration 065 (`shadow_decisions`, extends `strategy_versions.state` with `shadow_paper`). ResearchAgent records what up to 3 shadow versions would decide alongside the champion's real decision — no fills, no cash. Off by default. |
| Regime features | Claude | 2026-07-06 | `lib/validation/regime.ts` (trend/vol-tercile vs SPY/^NSEI, pure/tested) appended to every observation's `features.regime`. No hard bull/bear switch. |
| Governance rewiring | Claude | 2026-07-06 | Learner auto-guard now trips on champion health (drawdown>15%/90d peak, calibration drift>0.25, data-availability<60%/10 obs) instead of a raw win-rate streak. Confirmed it only ever gated `update_signal_weight` — other tools unaffected. |
| 85 tests passing, tsc + build clean | Claude | 2026-07-06 | 5 new test files this session alone (genome, feature-compiler, feature-check, regime + existing suite). |

---

## ✅ Session 2026-07-06 (Execution Gateway — Alpaca paper orders + fixed a discovered Trade Queue bug)

> Built the paper-stage of the Execution Gateway (spec Part A) and, in the same change, fixed a pre-existing (empty-table, no real-data-loss) bug: the Trade Queue UI read a dead `trade_queue` table while Approve/Reject/the Gateway all use `trade_proposals`. See **Decision 36**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Alpaca order adapter | Claude | 2026-07-06 | `lib/brokers/alpaca-orders.ts` — submit/get/cancel, reuses the existing vault-key pattern from `lib/brokers/alpaca.ts`. |
| broker_orders lifecycle + routes | Claude | 2026-07-06 | Migration 068. `POST /api/broker/orders` (human-click only, live gated on trading_enabled) + `/sync` (30-min cron, position reconciliation + alert). |
| Fixed trade_queue/trade_proposals mismatch | Claude | 2026-07-06 | Repointed the Smart Money page's query to the real table (`trade_proposals`) and the correct pending status (`pending_review`). Approve/Reject now actually functional; both tables confirmed empty in prod, so no real data was ever affected. See Decision 36. |
| "Send to Alpaca (paper)" UI | Claude | 2026-07-06 | Button on approved proposals in the Trade Queue history table. Confirm dialog, paper-env only from this UI. |
| system-map.json — GATEWAY node | Claude | 2026-07-06 | New node; REALORDER description clarified as Robinhood-specific. |

---

## ✅ Session 2026-07-06 (Learning-core Phase 2 — Validation Engine + calibrated Kelly sizing + transactional fill RPC, all verified live)

> Validated live via the reconnected Supabase MCP: migrations 061/062 applied, `execute_paper_fill` RPC tested end-to-end (disposable signal, all 5 writes landed atomically, then fully reversed). See **Decision 35** (Validation Engine + sizing) and **Decision 34** (transactional-fill RPC + the pre-existing signal_id bug it uncovered).

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Transactional paper-fill RPC | Claude | 2026-07-06 | `execute_paper_fill` (migration 071) — claim-reverify → event → trade → position → cash → signal-flip in ONE transaction, row-locked. Verified live end-to-end; falls back to the legacy multi-step JS sequence if absent. See Decision 34. |
| P0: cron-gap detector, vitest suite, Portfolio Constructor | Claude | 2026-07-06 | All three P0 app-improvements from the learning-core spec completed and verified (47 tests passing across 8 files by end of session). |
| Validation Engine | Claude | 2026-07-06 | `lib/validation/engine.ts` (migration 061 `validation_experiments`) — deterministic walk-forward replay, 1000-draw block bootstrap (seed 42), pass rule: p_improvement>=0.80, CI floor, n_effective>=12, >=3/5 folds won. See Decision 35. |
| Fail-closed promotion gate | Claude | 2026-07-06 | `promote_champion` now HTTP 412s without a passed validation experiment (journaled `force_unvalidated` override exists, not the default path). See Decision 35. |
| Calibrated P(win) + Kelly sizing | Claude | 2026-07-06 | `lib/validation/calibration.ts` (migration 062 `model_artifacts`) — logistic regression replaces raw analyst_score as the sizing input; half-Kelly via `lib/risk/sizing.ts`, capped at the flat position_size_pct. Dormant until 60+ matured observations/market. |
| Dynamic MAE/MFE R:R | Claude | 2026-07-06 | `lib/risk/percentiles.ts` — stop/target from the ledger's actual outcome-percentile distribution, replacing the fixed 7%/20% profile constants. Signal-provided values always win. |
| Learner auto-fires validation | Claude | 2026-07-06 | `update_signal_weight` fires `/api/validation/run` the moment a challenger is created — evidence is usually ready before a human looks at the Strategy Registry. |
| Weekly fit-calibration cron | Claude | 2026-07-06 | New `app/api/validation/fit-calibration` route, Fridays 4:45 PM ET (before the 5 PM learner). |
| system-map.json — VALIDATE node | Claude | 2026-07-06 | New node between CHALLENGER and PROMOTE; TRADER + PROMOTE descriptions updated to reflect the gate + Kelly sizing. |

---

## ✅ Session 2026-07-06 (Supabase MCP reconnected — migrations applied, critical fill-event bug fixed)

> Reconnected Supabase MCP gave direct schema access for the first time in several sessions. Applied all pending migrations (060, 069) and one urgent live fix: **`paper_order_events.signal_id` was `bigint` while `agent_signals.id`/`paper_trades.signal_id` are `uuid`** — every paper fill's order-event insert had been failing since migration 034 (confirmed: zero rows ever in `paper_order_events`). Fixed live (migration 070, lossless — table was empty) and verified end-to-end: restarted the stale production server, re-ran ResearchAgent, confirmed `decision_observations` now writes real per-candidate feature rows. See **Decision 34**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Applied migration 060 (observation_labels) | Claude | 2026-07-06 | Previously blocked by Supabase SQL-editor Redis/RLS-dialog issues; applied directly via reconnected MCP. |
| Applied migration 069 (portfolio_limits) | Claude | 2026-07-06 | `strategy_config` gains max_gross/sector/name_exposure_pct, max_portfolio_vol_pct, max_avg_pairwise_corr — Portfolio Constructor limits. |
| Fixed paper_order_events.signal_id type bug | Claude | 2026-07-06 | Migration 070. Long-standing bug (predates this session) silently failing every fill's audit-event write. See Decision 34. |
| Verified end-to-end on live DB | Claude | 2026-07-06 | Restarted stale `next start` server (was serving a pre-session build), re-triggered research, confirmed decision_observations populates with real feature blobs (5 dims × N candidates per run). |
| Confirmed migrations 057/058 already live | Claude | 2026-07-06 | Multi-market + India screen cache both confirmed applied from earlier sessions. |

---

## ✅ Session 2026-07-06 (Learning-core Phase 1 — decision ledger + matured horizon labels)

> An independent architecture review (Codex) found LearnerAgent's dataset statistically untrustworthy: signal→trade join by symbol (collision-prone), label = policy P&L on filled-longs-only (selection bias, mixes alpha with beta/holding-time/exits), no valid out-of-sample evaluation. This is the keystone fix everything else (validation engine, calibrated sizing, genome, shadow A/B — see `features/learning-core/`) is built on. See **Decision 33**.
> **⚠️ OPEN ITEM: migrations `059_decision_observations.sql` + `060_observation_labels.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP permission-denied this session. Everything is guarded/additive: the app behaves byte-for-byte unchanged until they land, then the ledger starts accruing automatically.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migrations 059/060 — decision ledger + labels | Claude | 2026-07-06 | `decision_observations` (append-only via trigger; one row per scored candidate, filled or rejected — raw `computeScores().evidence`, availability mask, weights used, score, action) + `observation_labels` (forward 2/5/10/20-trading-day `fwd_return`/`benchmark_neutral_return`/MAE/MFE, written only after horizon maturity). **NOT auto-applied — user must run both in the Supabase SQL editor.** See Decision 33. |
| ResearchAgent — observation write | Claude | 2026-07-06 | `lib/research-agent.ts` writes a `decision_observations` row for every scored candidate (fail-soft if 059 absent). Captures the full raw feature blob at zero refactor cost — future-proofs Phase 3 feature discovery. See Decision 33. |
| Label-maturation cron | Claude | 2026-07-06 | New `app/api/agents/label-maturation/route.ts` (nightly, 6:00 PM ET) matures each horizon once enough calendar time has passed; US prices from `price_cache`, India from `fetchIndiaCandles`; benchmark = SPY (US) / `^NSEI` (India); 10bps cost haircut on `fwd_return`. Registered in `run-agents.ps1` + `register-tasks.ps1`. See Decision 33. |
| Walk-forward dataset builder | Claude | 2026-07-06 | `lib/learning/dataset.ts` — `loadLabeledDataset` (ledger×labels join) + `walkForwardFolds` (pure function: purge = drop train rows whose label window overlaps the test window; embargo = skip a horizon's worth of time after each test window). Read-only; Phase 2's validation engine consumes it. See Decision 33. |
| LearnerAgent — ledger-first correlation + personal-history quarantine | Claude | 2026-07-06 | `query_score_correlation` now reads the ledger FIRST (all scored candidates, horizon-aligned, benchmark-neutral — not just fills/policy-P&L), tagged `source: "observation_ledger"` with an explicit INTERIM caveat; falls back to the legacy paper-trades path (now correctly joined by `signal_id`, not symbol) while the ledger is thin. `query_trade_decisions`/`semantic_search_decisions` (10yr personal history) now return `role: "behavioral_evidence_only"` — cannot satisfy `n_trades` or justify `update_signal_weight`. System prompt updated to state this explicitly. See Decision 33. |
| system-map.json — LEDGER node | Claude | 2026-07-06 | New `LEDGER` node (RESEARCH → LEDGER → LEARNER) documenting the ledger's role as the ground truth for the learning/evolution roadmap. See Decision 33. |

---

## ✅ Session 2026-07-05 (Phase 5 — India parity: global switcher + support registry + direct NSE feeds)

> India goes from paper-trading/self-learning (Phase 4) to **first-class across the whole dashboard**, behind a global market switcher, with an honest per-page coverage badge. Direct NSE feeds lift the two remaining free-data ceilings (full-market scan + India insider/options), failing soft to Yahoo/NIFTY-100. See **Decision 32**.
> **⚠️ OPEN ITEM: migration `058_india_screen_cache.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP was permission-denied this session (`057` already applied by the user). Guarded code degrades to US-only until 058 lands.
> **⚠️ OPEN ITEM: NSE feeds may be geo-blocked from a US IP** — `lib/nse-data.ts` fails soft, so full-market scan + India insider/options degrade to their Yahoo/NIFTY-100 fallback with an honest note when NSE is unreachable.
>
> **Follow-up (2026-07-05):** the four remaining **partial** India panels were brought to **full** parity — Markets (real sector heatmap `fetchIndiaSectors` + NIFTY-50 breadth), Risk Analytics (real beta-vs-NIFTY, 1y daily-candle regression; `computeRiskMetrics` now async), Strategies (real India fit-scores from `signal_score_history` market='india'), Earnings (market-wide NSE results calendar `fetchNseEarnings`, Yahoo per-symbol fallback). New adapters: `fetchIndiaSectors` (`lib/india-data.ts`), `fetchNseEarnings` (`lib/nse-data.ts`); `market-support.ts` flipped all four to `full`. Genuine remaining US-only bits: Markets TradingView/macro-sentinel tiles, Strategies Algo Library; NSE feeds may geo-block from a US IP (graceful fallback). See Decision 32.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Global market switcher + per-page support footer | Claude | 2026-07-05 | `lib/market-context.tsx` (`MarketProvider`/`useMarket()` → `us\|india`, persisted to `localStorage` + `mkt` cookie) in the `DashboardShell` header, **hidden unless `market_focus` includes India**; server pages read the `mkt` cookie. `lib/market-support.ts` maps route → `{level: full\|partial\|us-only\|india-only, note}` as the single source of truth → a coverage badge at the bottom of every page. See Decision 32. |
| Markets panel — India | Claude | 2026-07-05 | India via Yahoo: NIFTY / SENSEX / BankNifty / India-VIX, plus a real sector heatmap (10 NSE sector indices via `fetchIndiaSectors`) + market breadth (NIFTY-50 advancers/decliners). Level: **full** (upgraded from indices-only 2026-07-05; TradingView/macro-sentinel tiles remain US-only). See Decision 32. |
| Risk Analytics panel — India | Claude | 2026-07-05 | Per-₹ book, VaR vs NIFTY, plus real portfolio **beta vs NIFTY** (1y daily-candle covariance/variance regression, value-weighted; `computeRiskMetrics` now async). Level: **full** (upgraded from partial 2026-07-05; was "beta coming soon"). See Decision 32. |
| Backtest panel — India | Claude | 2026-07-05 | Yahoo `.NS` candles, alpha vs NIFTY. Level: **full**. See Decision 32. |
| Scanner panel — India | Claude | 2026-07-05 | Full NSE market via nightly cache; NIFTY-100 live fallback. Level: **full**. See Decision 32. |
| Strategies panel — India | Claude | 2026-07-05 | Real India **fit-scores** computed from its signals' dimension scores (`signal_score_history` market='india'). Level: **full** (upgraded from partial 2026-07-05; was empty "US only" state; Algo Library remains US-only). See Decision 32. |
| Earnings panel — India | Claude | 2026-07-05 | Market-wide NSE results calendar (`fetchNseEarnings` via NSE event-calendar) with per-symbol Yahoo fallback. Level: **full** (upgraded from partial/tracked-names-only 2026-07-05). See Decision 32. |
| Smart Money panel — India | Claude | 2026-07-05 | Signals + trade queue both markets; India insider + option-chain PCR/OI live from NSE. Level: **full**. See Decision 32. |
| NSE direct feed adapter | Claude | 2026-07-05 | `lib/nse-data.ts` — cookie-handshake adapter for NSE's free JSON: full equity list (`EQUITY_L.csv`), insider (`corporates-pit`), option chain (`option-chain-indices`/`option-chain-equities`). **This lifted the two earlier ceilings** (full-market scan + India insider/options). Fails soft (NSE geo-throttles some non-India IPs) → callers fall back to Yahoo/NIFTY-100 with an honest note. See Decision 32. |
| Scanner cache + migration 058 | Claude | 2026-07-05 | Migration `058_india_screen_cache.sql` (new table) + nightly cron `POST /api/scan/india/refresh` scores the full NSE list in 600-name oldest-first slices; Scanner reads the cache, falls back to live NIFTY-100. **NOT auto-applied — user must run 058 in the Supabase SQL editor.** See Decision 32. |
| Market-scoped agents + India crons | Claude | 2026-07-05 | `research`/`paper-trade`/`position-monitor` accept `?market=us\|india`; US 9 AM tasks pinned to `?market=us` (no longer double-process India). India Task Scheduler tasks (PC clock = ET, all post-NSE-close 15:30 IST = 06:00 ET): scan-india-refresh 5:30 AM, research-india 6:15 AM, position-monitor-india 6:35 AM. See `scripts/run-agents.ps1` + `scripts/register-tasks.ps1`. See Decision 32. |
| Guarded rollout + system-map.json | Claude | 2026-07-05 | Pre-058 (missing column/table) every India-parity path degrades to US-only, never 500s. `system-map.json` updated with NSE nodes (full equity list, insider, option chain) feeding the scanner cache + Smart Money. See Decision 32. |

---

## ✅ Session 2026-07-05 (Phase 4 — multi-market learning: per-currency pools + per-market champions)

> Market is now a **tag** (us | india), not a fork — one app, panels filter by market, currencies NEVER summed. Supersedes Decision 29 (India was score-only): India now paper-trades in its own ₹ pool, closing the India learning loop. See **Decision 31**.
> **⚠️ OPEN ITEM: migration `057_multi_market.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP was permission-denied this session (no psql/DATABASE_URL). Guarded code runs unchanged until 057 lands; India activates automatically once the `market` column + ₹ pool row exist.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 057 — market as a tag across the paper stack | Claude | 2026-07-05 | `market` column added to `paper_portfolio`/`paper_positions`/`paper_trades`/`paper_performance`/`agent_signals`/`signal_score_history`; `paper_performance` unique key `(date)` → `(date, market)` so each market keeps its own NAV curve. New India ₹ pool seeded at ₹1,000,000; `strategy_versions` gains `market` and India is seeded as a CLONE of the US champion (prior). **NOT auto-applied — user must run it in the Supabase SQL editor.** See Decision 31. |
| PaperTrader — per-currency fills | Claude | 2026-07-05 | `app/api/agents/paper-trade/route.ts` fills EACH signal into its market's pool in native currency: US via `getQuote` (AV/Robinhood USD), India via free Yahoo `.NS` (INR). Sizing = `position_size_pct` of THAT pool's cash. India now produces closed outcomes → **closes the India learning loop** (previously scored but never paper-traded). See Decision 31. |
| PositionMonitor — per-market exits | Claude | 2026-07-05 | `app/api/agents/position-monitor/route.ts` monitors/exits per market in native currency (India prices via Yahoo), crediting each close back to its own pool. See Decision 31. |
| LearnerAgent — per-market champion weights | Claude | 2026-07-05 | `app/api/agents/learner/route.ts` analyzes ONE market's cohort per run (US today) and proposes challengers ONLY for that market's champion — a bad India run can never shift US scoring. India diverges from its US-clone prior once it clears the same 10+ closed-trade phase gate. See Decision 31. |
| ResearchAgent — reads market-matched champion | Claude | 2026-07-05 | `lib/research-agent.ts` reads the champion weights for the symbol's market rather than a single global champion. See Decision 31. |
| Settings — `market_focus` trimmed + non-destructive gate | Claude | 2026-07-05 | `market_focus` reduced to US + India only (Europe/Asia/Crypto/Global removed as noise). Toggle is NON-destructive: India ON → NIFTY scoring + ₹ fills + India learning cohort; India OFF → stops NEW India research/fills but KEEPS open India positions monitored-to-close + all history/weights (re-enable resumes). Real Kite holdings/execution unaffected by the toggle. See Decision 31. |
| Portfolio UI — market selector | Claude | 2026-07-05 | Portfolio/paper surfaces gain a per-market selector so US ($) and India (₹) NAV curves and positions are viewed independently and never blended into one number. See Decision 31. |
| Guarded rollout + system-map.json | Claude | 2026-07-05 | Every path is pre-057-safe: with no `market` column / single pool, behavior is byte-for-byte the old US-only app. `system-map.json` updated to split the paper pool + learner per market. See Decision 31. |

---

## ✅ Session 2026-07-05 (India — Zerodha Kite + Yahoo multi-market integration)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Phase 1 — Kite auth (daily one-click login) | Claude | 2026-07-05 | `lib/kite.ts`, `app/api/kite/login\|callback\|status`. Kite Connect v3: login → `request_token` → SHA256-checksum exchange → `access_token` stored in `api_key_vault` as `KITE_ACCESS_TOKEN`, treated as expired if not generated today (Kite tokens expire 6 AM next day, SEBI rule). Verified live — real `/user/profile` returns the user's name. Settings → Agents shows a "Zerodha Kite · India" connection card. See Decision 30. |
| Phase 2 — India scoring on free Yahoo data | Claude | 2026-07-05 | `lib/india-data.ts`, `lib/india-universe.ts`, `research-agent.ts`, paper-trade route. Indian NSE (`.NS`) stocks run the SAME 5-dimension pipeline as US, but data is FREE Yahoo Finance (Kite Personal tier has no market data) — chart endpoint for price+candles (no auth), cookie+crumb `quoteSummary` for fundamentals, mapped into the AV-OVERVIEW shape the scorer expects. Candidates from a static NIFTY-50 list. US-only inputs (social/options/insider) skipped → neutral baseline, flagged in score-detail. Wired off `profiles.market_focus` including "India". Verified: RELIANCE.NS scored on real Yahoo fundamentals (P/E 21.85, ROE 9.1%, rev +12.5% → fundamental 73) over 124 real candles. **India is scored + tracked but NOT paper-traded** — INR pricing would corrupt the single-USD paper pool; `PaperTrader` excludes `asset_class="india"`. See Decisions 28, 29. |
| Phase 3 — real Kite execution + holdings | Claude | 2026-07-05 | `lib/kite.ts` additions, `app/api/kite/portfolio`, `app/api/kite/order`, `app/dashboard/india` page + nav. Real NSE/BSE holdings read (verified: 5 real INR holdings from the live account) and real order placement (`POST /orders/regular`, product `CNC`). Human-in-the-loop safety: authenticated-user-only (never cron/agent), requires explicit `confirm:true`, writes a `decision_journal` audit row; `/dashboard/india` uses a two-step confirm with a "REAL MONEY" warning that never fires on first click. Reads/orders degrade to a "reconnect" state when the daily token is stale. See Decision 30. |
| system-map.json + docs updated for India | Claude | 2026-07-05 | Added YAHOO/INDIA/KITE nodes to `system-map.json`; India / multi-market section in ARCHITECTURE.md; Decisions 28–30 in PROJECT_DECISIONS.md. Recorded data-source reality: US = Alpha Vantage + FinancialDatasets + Massive; India = free Yahoo (`.NS`) for data + Zerodha Kite for execution/holdings; no direct non-US equity beyond India. |

---

## ✅ Session 2026-07-05 (closed-loop learning, score history, exit de-confliction, Langfuse agent-loop tracing)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Closed-loop learning — ResearchAgent consumes champion weights | Claude | 2026-07-05 | `processSymbol` in `lib/research-agent.ts` now reads the promoted champion's `weights_snapshot` first (normalizing both key formats — seed `{fundamental:0.3}` vs challenger `{fundamental_weight:0.3}`), falling back to static `PROFILE_WEIGHTS` then `signal_weights` only when no champion is promoted. Loop was OPEN (promoted weights were never read); now CLOSED. `research_packets.raw_data` records `_using_champion_weights`. See Decision 24. |
| Score history — `signal_score_history` table + ScoreTrajectory | Claude | 2026-07-05 | Migration 054: append-only per-symbol score history (analyst_score + 5 dimensions, direction, source, created_at; RLS + `(symbol, created_at desc)` index; never mutated after insert). ResearchAgent appends best-effort per score (no-ops until migration applied) and injects a `SCORE TREND` note into the thesis prompt. New `GET /api/charts/score-history?symbol=X` feeds the symbol-detail chart (previously starved of data). PRD-specced, never built. See Decision 25. |
| LearnerAgent Phase B backstop de-confliction | Claude | 2026-07-05 | Phase A (smart `llm_exit` re-score) and Phase B (blunt >7-day time cutoff) raced; crude Phase B usually won. Phase B now skips any position already carrying the `llm_exit` flag and its cutoff moves 7 → 14 days, making it a last-resort backstop. `app/api/agents/learner/route.ts`. See Decision 26. |
| Langfuse tracing extended to `runAgentLoop` | Claude | 2026-07-05 | The multi-step tool-calling loop (LearnerAgent, MentorAgent) was invisible in Langfuse (only `llm_call_log`); now wrapped in a Langfuse trace/generation span (system prompt in, final text out, tokens, cost, tool-call trail as metadata). Extends Decision 15. LangChain/LangGraph still unused — loop stays hand-rolled against Anthropic/DeepSeek SDKs. See Decision 27. |

---

## ✅ Session 2026-07-04 (late — bug sweep: sector chart, briefing, live account, paper prices, privacy mode)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Sector chart pagination fix + Massive 500-bar cap discovery | Claude | 2026-07-04 | `bc07c7a` — `next_url` wasn't followed on 1Y+ periods; fixed, then found a real provider limit: Massive free tier caps aggs responses at ~500 bars, no pagination beyond that |
| Sector chart replaced with real TradingView widget | Claude | 2026-07-04 | `77f371f` (Symbol Overview embed — didn't hydrate reliably) → `9f81fd5` (final: reused `TradingViewChart` tv.js Advanced Chart component from symbol detail page, tab switcher across 11 sector ETFs). Removed `components/charts/SectorLineChart.tsx` + `app/api/charts/sector-history/route.ts`. See Decision 21. |
| Weekend briefing recap | Claude | 2026-07-04 | `909bcc4` — weekend-specific editor's-note prompt synthesizing last 7 days + week ahead, replacing the bland "nothing to do" daily prompt |
| Newsletter history wiring | Claude | 2026-07-04 | `909bcc4` — `sendBriefingEmail` now also inserts into `newsletters` table on send; Intelligence → Newsletter tab was always empty before this |
| Market Synthesis cache-poisoning fix | Claude | 2026-07-04 | `909bcc4` — only cache synthesis result to `briefings` on success, not on transient Massive failure |
| Live Robinhood account $0/$0 fix | Claude | 2026-07-04 | `359b2c6` — upsert (not insert) on `live_account_snapshots`; added missing `.eq("account_id", "965848641")` filter everywhere reads lacked it; verified against real Robinhood app |
| Stale paper position prices fix (META stuck at entry price) | Claude | 2026-07-04 | `9165958` — `position-monitor` + `learner` routes queried nonexistent `closed_at` column, silently no-op'd every run since written; fixed queries, fixed `opened_at` column name, fixed stray polygon.io endpoint, rewrote close logic to match real schema (delete `paper_positions` row, close matching `paper_trades` row) |
| Alpha Vantage day-cache wired into batch quotes | Claude | 2026-07-04 | Same commit `9165958` — `getBatchQuotes`/`fetchAVQuote` were uncached, burning the 25/day AV quota on every Live Portfolio load |
| Live Portfolio false "-100% total loss" fix | Claude | 2026-07-04 | Same commit `9165958` — `q?.price ?? fallback` never triggered on explicit `price: 0`; now falls back to avg cost honestly |
| Briefing "Learning Log" query fix | Claude | 2026-07-04 | Same commit `9165958` — was querying nonexistent columns on `learning_log` (that table is the learner's own weight-mutation audit log); switched to querying recently-closed `paper_trades` |
| Privacy Mode (new feature) | Claude | 2026-07-04 | Eye-icon toggle masks live-account dollar figures on Dashboard home + Live Portfolio, default-hidden, resets on remount; master switch in Settings → Preferences (localStorage). `components/dashboard/PrivacyMask.tsx`. See Decision 22. **Uncommitted as of this entry.** |
| execClaude/MCP tool-calling architecture audit | Claude | 2026-07-04 | **NOT FIXED — flagged only.** `execClaude` cannot call MCP tools (no API key, no MCP config); every "tool call" it makes is trusted text output. Found in `research-agent.ts` screener, `mentor/evaluate`, and — highest severity — the real-money order paths `agents/trader` + `agents/trade/approve`. Requires explicit user sign-off before fixing. See Decision 23 and ARCHITECTURE.md "Known Architecture Risk" section. |
| ARCHITECTURE.md dashboard nav map | Claude | 2026-07-04 | Added full nav-item-by-nav-item map (path, what it shows, backing API/tables) so an external reviewer can test every page against documented behavior |

---

## ✅ Session 2026-07-01 (latest — Kairos rename + wiring)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Platform rename FinanceOS → Kairos | Claude | 2026-07-01 | layout.tsx title, package.json, DashboardShell sidebar brand + tagline "Right signal. Right moment." |
| BOM + encoding corruption fix | Claude | 2026-07-01 | PS5.1 corruption fixed across 14+ files; curly quotes, em dashes, emoji sequences all cleaned; build restored clean |
| market_focus wired to ResearchAgent | Claude | 2026-07-01 | `gatherSymbols()` queries profiles.market_focus; non-US regions append region ETFs (India/Europe/Asia/Crypto/Global); marketFocus passed to thesis LLM prompt |
| Learner schedule: weekly (Fridays only) | Claude | 2026-07-01 | Cron-triggered learner now skips Mon–Thu; only runs Fri 5 PM; manual triggers unrestricted |
| Cron script updated: trader + schedule | Claude | 2026-07-01 | Added `trader` endpoint; corrected schedule comments (08:00 brief → 09:00 research → 09:45 trader → 16:15 pos-monitor → 16:30 brief → 17:00 nav → Fri learner) |
| market_focus multi-select chip UI | Claude | 2026-07-01 | Settings page: chip buttons US/India/Europe/Asia/Crypto/Global; comma-separated text in DB |
| Weekend + holiday skip in research cron | Claude | 2026-07-01 | research/cron and learner routes skip weekends + 2026 US holidays |
| Newsletter wired: EDGAR, proposals, weights | Claude | 2026-07-01 | 3 new data queries + 3 new email sections; deployed as v4 |
| ARCHITECTURE.md + WORK_LOG updated | Claude | 2026-07-01 | Full session 2026-07-01 documented |

---

## ⚠️ Known Pending

| Item | Priority | Notes |
|---|---|---|
| Server restart required | HIGH | Running `npm start` with old build. `Ctrl+C` then `npm start` to apply Kairos rename + all July 2026 changes |
| TraderAgent → Robinhood place_equity_order wire | HIGH | Approve button in SmartMoney updates DB status but does NOT call `place_equity_order` on account 605420650 |
| InfoTooltip wiring across dashboard pages | MED | `components/dashboard/InfoTooltip.tsx` exists but not wired to individual cards |
| Schedule: Task Scheduler tasks need creating | MED | Windows Task Scheduler tasks documented in `scripts/run-agents.ps1` but not yet created as scheduled tasks |

---

## ✅ Session 2026-07-01 (continued)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Apply migration 035 — evidence_records | Vaibhav + Claude | 2026-07-01 | Applied. evidence_records (immutable), corporate_actions, macro_signals (vintage_at, indicators_json) |
| Apply migration 036 — strategy_registry | Vaibhav + Claude | 2026-07-01 | Applied. strategy_versions, experiment_runs, agent_signals←version_id, paper_performance←spy_nav/alpha; seeds v1.0.0 champion |
| Apply migration 037 — trader_proposals | Vaibhav + Claude | 2026-07-01 | Applied. trade_proposals (HARDCODED 605420660), decision_journal |
| SEC EDGAR Form 4 insider trades | Claude | 2026-07-01 | `/api/markets/edgar-insiders` — SEC.gov CIK lookup + Form 4 XML parse; writes notable buys to evidence_records; SmartMoneyPage "Form 4 (EDGAR)" tab with lazy-load table |
| knowledge/event-patterns/ population | Claude | 2026-07-01 | Created `event-patterns/macro-events.md` (Fed/CPI/NFP/ISM/auctions + agent scoring adjustments), `event-patterns/earnings-patterns.md` (PEAD/SUE/red flags/sector patterns), `signal-library/proven-signals.md` (10 signals + anti-signals + correlation matrix); KNOWLEDGE_INDEX updated |

---

## ✅ Session 2026-07-01 (latest)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Phase 0: `lib/data/quotes.ts` — deterministic quote adapter | Claude | 2026-07-01 | AV GLOBAL_QUOTE → price_cache fallback; freshness/stale detection; `computeFillPrice` (ask + 0.05% slippage) |
| Phase 0: `lib/data/technicals.ts` — RSI/EMA from candles | Claude | 2026-07-01 | Pure-math RSI(14), EMA(20/50) from OHLCV; `scoreTechnicals()` → 0-100 |
| Phase 0: `lib/data/scores.ts` — `computeScores()` | Claude | 2026-07-01 | All 5 scores deterministic: fundamental from AV OVERVIEW, technical from candles, sentiment from social, macro from macro_signals table, insider from AV transactions |
| Phase 0: `lib/data/evidence.ts` — evidence write helpers | Claude | 2026-07-01 | `writeEvidence`, `writeBatchEvidence`; SOURCE_TIERS map; fire-and-forget inserts to evidence_records |
| Phase 0: Migration 034 — paper_order_events | Claude + Vaibhav | 2026-07-01 | **Applied.** Append-only immutable event log; UPDATE/DELETE blocked by trigger; price provenance columns on paper_trades |
| Phase 0: `processSymbol` rewrite in research-agent | Claude | 2026-07-01 | LLM no longer generates scores; fetches AV OVERVIEW + candles → computeScores() → LLM writes thesis+direction only (512 tokens, Groq) |
| Phase 0: paper-trade route price upgrade | Claude | 2026-07-01 | Replaces execClaude/MCP price fetch with `getQuote()` + `computeFillPrice()`; writes immutable fill event to paper_order_events; SPY benchmark alpha tracking; decision journal entries |
| Phase 1: `lib/data/evidence.ts` + Migration 035 — evidence_records | Claude | 2026-07-01 | Migration **NOT YET APPLIED**. evidence_records table (append-only immutable); corporate_actions table; macro_signals altered (vintage_at, indicators_json) |
| Phase 1: `/api/agents/corporate-actions` — splits/dividends sync | Claude | 2026-07-01 | AV SPLITS + DIVIDENDS for held + watchlist symbols; upserts corporate_actions; GET filters by symbol/type/since |
| Phase 2: Migration 036 — strategy_registry | Claude | 2026-07-01 | **NOT YET APPLIED.** strategy_versions table; experiment_runs table; agent_signals ← strategy_version_id; paper_performance ← spy_nav/spy_return_pct/alpha_pct; seeds v1.0.0 Phase0-Baseline as champion |
| Phase 2: `/api/agents/backtest` — JS backtest engine | Claude | 2026-07-01 | Replays agent_signals vs price_cache candles; eligibility gate (Sharpe≥0.5, win_rate≥40%, drawdown<25%, min 20 trades, expectancy>0); persists to experiment_runs; SPY alpha |
| Phase 2: `/api/strategies/versions` — champion/challenger governance | Claude | 2026-07-01 | GET: list versions + nested runs; POST: promote_champion, retire, reject, or create new version |
| Phase 4: `/api/journal` — decision journal CRUD | Claude | 2026-07-01 | GET: filter by symbol/type/resolved; POST: create entry or resolve with outcome; links signal→fill→outcome |
| Phase 5: Migration 037 — trader_proposals | Claude | 2026-07-01 | **NOT YET APPLIED.** trade_proposals table (30-min expiry); decision_journal table; account_number default 605420650 |
| Phase 5: `/api/agents/trader` — TraderAgent proposals + approval | Claude | 2026-07-01 | HARDCODED AGENTIC_ACCOUNT=605420650; builds proposals from qualifying signals; approve/reject; expiry check; account mismatch safety block; kill-switch re-check at approval |
| AgentsPage — Experiments tab (🔬) | Claude | 2026-07-01 | Strategy versions list (champion badge, state, experiment metrics); Run Backtest button → /api/agents/backtest; results grid with gate pass/fail and failure reasons |
| AgentsPage — Proposals tab (⚡) | Claude | 2026-07-01 | Pending proposals list; Approve/Reject buttons; price drift warning (>3%); expiry countdown; risk check badges; "Generate Proposals" trigger |

## ✅ Session 2026-06-30

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 032 — asset_class on agent_signals | Claude + Vaibhav | 2026-06-30 | `asset_class` column; seeds ETF/metal symbols; index |
| Migration 033 — learner controls | Claude + Vaibhav | 2026-06-30 | `learning_priors` (15 Bayesian priors), `learner_config` (per-dimension toggles), `signal_weights_history` (rollback snapshots); `mutations_paused`/`pause_reason` on `learner_runs` |
| LearnerAgent full rewrite — true DeepSeek tool-use agent | Claude | 2026-06-30 | 9 tools: read_priors, query_learner_config, query_signals_with_outcomes, query_score_correlation, query_macro_context, read_past_learnings, write_hypothesis, update_signal_weight, finish; auto-guard blocks mutation if last 3 runs win_rate < 35%; phase gate: requires 10+ closed trades |
| Learner Controls tab + Weight History tab in AgentsPage | Claude | 2026-06-30 | Per-dimension learn_from/allow_mutation toggles + min_confidence; weight history table with rollback + factory reset |
| `/api/agents/learner-controls` route (GET/PATCH/POST) | Claude | 2026-06-30 | GET: config + last 30 snapshots; PATCH: update dimension config; POST: rollback or factory_reset |
| Metals basket cap fix in research-agent | Claude | 2026-06-30 | Metals (GLD/SLV/GDX/IAU) were cut by 10-symbol cap; fixed to append unconditionally after cap |

---

## ✅ Session 2026-06-29

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Dynamic exit price management | Claude | 2026-06-29 | migration 026; `price_target`, `stop_loss`, `highest_price`, `target_updated_at`, `exit_reason` on `paper_positions`; trailing stop = max(original_stop, highest_price × 0.93) |
| Risk profile system | Claude | 2026-06-29 | migration 027; `risk_profile`, `score_threshold`, `position_size_pct`, `stop_loss_pct`, `target_pct` on `strategy_config`; Conservative/Balanced/Aggressive presets; `/api/settings/risk-profile` GET/PATCH; Settings → Agents tab card |
| Visual Agent Mermaid diagrams | Claude | 2026-06-29 | `components/dashboard/AgentDiagram.tsx`; clickable flowcharts per agent; color-coded by node status; click → detail drawer; 7 JSON files in `public/agent-diagrams/` |
| TradingView CSV watchlist import | Claude | 2026-06-29 | Import CSV button + modal in WatchlistPanel; `EXCHANGE:TICKER,Description` format; batch POST with progress |
| Signal backtest tab | Claude | 2026-06-29 | AgentsPage backtest tab; joins agent_signals to paper_trades by symbol+date ±3 days; shows Hit Rate, Misses, Open, Avg Return |
| Position Monitor | Claude | 2026-06-29 | `/api/agents/position-monitor/route.ts`; TradingPage card + Run button; scheduled weekdays 4:15PM |
| Insider transactions in ResearchAgent | Claude | 2026-06-29 | `scoreInsider()` in `lib/research-agent.ts`; Alpha Vantage INSIDER_TRANSACTIONS; 90-day buy/sell ratio; injected as pre-fetched context in LLM prompt |
| Smart Money Trades in MarketsPage | Claude | 2026-06-29 | `/api/markets/insider-trades/route.ts`; Alpha Vantage insiders + House Stock Watcher congressional trades; Insiders/Congress tabs |
| LLM Cost Monitor | Claude | 2026-06-29 | `/api/admin/llm-costs/route.ts`; queries `llm_call_log`; burn rate, projected daily, per-model breakdown, 24-bar hourly chart; Settings → Agents tab; DashboardHome banner if projected daily > $2 |
| Mentor nav + judgment score chart | Claude | 2026-06-29 | Mentor link restored in DashboardShell sidebar (🎓 under Learn); `/api/mentor/scores/route.ts`; MentorPage Recharts LineChart; reference lines at 50/70/90 |
| MacroSentinel recession agent | Claude | 2026-06-29 | `/api/agents/macro-sentinel/route.ts`; 8 Alpha Vantage indicators; weighted danger score 0-100; GREEN/YELLOW/ORANGE/RED regimes; advisory-only; migrations 028; MarketsPage gauge + signal table; DashboardHome colored banner; Mondays 8AM |
| Mermaid build fix | Claude | 2026-06-29 | Downgraded mermaid v11→v10; fixes ESM/webpack incompatibility with es-toolkit; build passes |
| Windows Task Scheduler — 7 tasks | Claude | 2026-06-29 | ResearchAgent weekdays 9AM, PaperTrader 9:30AM, PositionMonitor 4:15PM, LearnerAgent Mondays 6AM, ThemeScout Sundays 8PM, DeepSeekAgent weekdays 9AM, MacroSentinel Mondays 8AM |

---

## 🟣 Review

| Task | Agent/Model | Status | Date | Notes |
|---|---|---|---|---|
| Governed agentic quant platform architecture | Codex (Architect) | review | 2026-06-27 | Canonical spec written; awaiting Vaibhav review before implementation planning |

---

## 🟡 Planned (Approved, Ready to Build)

| Task | Assigned To | Status | Date | Notes |
|---|---|---|---|---|
| Signal backtest validation | Builder | planned | — | Run `/api/agents/backtest` after signals accumulate; verify gate metrics |
| knowledge/event-patterns/ population | Builder | planned | — | Fed decision patterns, earnings behavior feeds LearnerAgent |
| Mobile push notifications for proposals | Builder | planned | — | Phase 5; low priority until proposals flow is exercised |

---

## 🔵 Blocked

| Task | Blocked By | Notes |
|---|---|---|
| LearnerAgent weight mutation (Phase 1 gate) | 10+ closed paper trades | Auto-guard + phase gate built; waiting on paper trading data |
| Experiments tab metrics | Migration 036 not applied | spy_nav/spy_return_pct/alpha_pct columns missing until 036 applied |
| Proposals tab | Migration 037 not applied | trade_proposals + decision_journal tables missing until 037 applied |
| TraderAgent actual Robinhood order | Proposals tab approved proposal | Route is built; Robinhood MCP call must be triggered from UI after user approves |

---

## ✅ Completed

| Task | Agent | Completed | Notes |
|---|---|---|---|
| PRD.md written | Claude | 2026-06-01 | Full spec in PRD.md |
| AGENTS.md written | Claude | 2026-06-01 | Multi-agent coordination layer |
| Knowledge base created | Claude | 2026-06-01 | 6 files, see knowledge/ |
| Robinhood MCP connected | Vaibhav + Claude | 2026-06-01 | 6 accounts found, agentic: ••••0660 |
| Robinhood accounts read | Claude | 2026-06-01 | get_accounts called successfully |
| Design system migration | Claude | 2026-06-27 | fo-* tokens, shadcn components, DashboardShell rewrite |
| Governed agentic quant platform architecture | Codex | 2026-06-27 | Canonical spec; see PROJECT_DECISIONS.md |
| LLM Router (Claude/DeepSeek/Groq routing by task) | Claude | 2026-06-29 | lib/llm-router.ts; routes by task type, cost tier |
| Groq Llama 3.3 70B free tier integration | Claude | 2026-06-29 | Added to router after DeepSeek; free-tier slot |
| DeepSeek R1 integration | Claude | 2026-06-29 | Cheaper chat/summarize tasks; API key in vault |
| Multi-paper-account comparison (agent_label system) | Claude | 2026-06-29 | Tracks which LLM produced each signal; P&L by model |
| LLM call log + admin history page | Claude | 2026-06-29 | Cost + token tracking per model; /dashboard/activity |
| API key vault (PIN protected) | Claude | 2026-06-29 | /dashboard/settings; encrypted key storage |
| Earnings calendar → Massive API (no LLM) | Claude | 2026-06-29 | Direct API, no LLM cost on calendar fetch |
| Markets overview → Massive API (live index quotes) | Claude | 2026-06-29 | Direct API, real-time quotes |
| Features page | Claude | 2026-06-29 | /dashboard/features; timeline of all shipped features |
| Social sentiment (StockTwits + Alpha Vantage) | Claude | 2026-06-29 | Sentiment signals for ResearchAgent screener |
| Strategy classification engine (7 strategies) | Claude | 2026-06-29 | Momentum, GARP, Value, Dividend, Growth, Macro, Contrarian |
| DeepSeek research agent variant | Claude | 2026-06-29 | Parallel agent; produces signals for LLM P&L comparison |
| Symbol detail page (candlestick, agent signals, chat) | Claude | 2026-06-29 | /dashboard/symbol/[ticker]; EMA/SMA/volume overlays |
| Symbol navigation from Portfolio, Markets, Activity | Claude | 2026-06-29 | Clickable tickers link to symbol detail page |
| Sector line chart (multi-sector performance) | Claude | 2026-06-29 | SectorLineChart component; multiple sectors on one chart |
| DB migration 010 (llm_call_log, agent_labels) | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| DB migration 011 | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| price_cache table (on-demand candle caching) | Claude | 2026-06-29 | Caches Massive API candle responses |
| Bell dropdown fix (position: fixed) | Claude | 2026-06-29 | Sticky header stacking context — fixed to viewport |
| Watchlist toggles (migration 020 + PATCH API) | Claude | 2026-06-29 | research_enabled, alert_on_signal, alert_on_earnings per symbol |
| WatchlistPanel rewrite (quotes, source badges, settings) | Claude | 2026-06-29 | Price quotes via /api/markets/quote; per-item expand |
| BriefingPage symbol auto-suggest | Claude | 2026-06-29 | Regex extraction of tickers from brief text; watchlist + Watch chips |
| pgvector enabled + agent_memory table (migration 021) | Claude + Vaibhav | 2026-06-29 | Applied to production; vector(1536) + ivfflat index |
| PageHeader on Strategies + Settings pages | Claude | 2026-06-29 | Consistent what/why/look-for on all dashboard pages |
| Vault Change PIN button + API handler | Claude | 2026-06-29 | change_pin action updates app_settings.vault_pin; persists across restarts |
| Vault Edit key button + preserve existing value | Claude | 2026-06-29 | Edit pre-fills form; blank key_value = keep existing; API skips update if blank |
| PageHeader on Activity, Learning, You, Trading, Agents, Mentor | Claude | 2026-06-29 | All 8 dashboard pages now have consistent what/why/look-for header |
| Options chain tab in SymbolDetailPage | Claude | 2026-06-29 | Chart/Signals/Options/Chat tabs; put-call ratio, avg IV, calls+puts table |
| Options chain API route | Claude | 2026-06-29 | /api/options/chain?symbol=X; Alpha Vantage REALTIME_OPTIONS; revalidate 300s |
| Batch quotes endpoint | Claude | 2026-06-29 | /api/markets/quotes?symbols=A,B,C; parallel fetch, max 20 symbols, 1 round-trip |
| WatchlistPanel → batch quotes | Claude | 2026-06-29 | 15–20 serial calls replaced with 1 batch call; limit raised 15→20 |
| Company name auto-fetch on watchlist add | Claude | 2026-06-29 | POST /api/watchlist calls Alpha Vantage COMPANY_OVERVIEW if name not provided |
| Alpha Vantage API key added | Vaibhav + Claude | 2026-06-29 | In .env.local + vault DB; powers options, sentiment, company name |
| Vault providers expanded | Claude | 2026-06-29 | Added massive, alphavantage, robinhood, supabase providers + market_data/sentiment/options tasks |
| TypeScript error fixes | Claude | 2026-06-29 | theme-scout raw.text fix; tailwind darkMode array→string; supabase/functions excluded from tsconfig |
| Grammarly hydration error suppressed | Claude | 2026-06-29 | suppressHydrationWarning on <body> in app/layout.tsx |

### Design System Migration (2026-06-27) — What was built
- `app/globals.css` — full fo-* token system (trading-purple accent #6366F1, dark-first)
- `tailwind.config.ts` — fo-* color tokens wired to CSS vars
- `postcss.config.mjs` — Tailwind v4 postcss plugin
- `lib/utils.ts` — cn() utility (clsx + tailwind-merge)
- `components/ui/card.tsx` — shadcn Card/CardHeader/CardContent/CardFooter/CardTitle/CardDescription
- `components/ui/button.tsx` — shadcn Button (no Radix Slot dep, simplified)
- `components/ui/badge.tsx` — shadcn Badge with CVA
- `components/ui/sparkline.tsx` — Recharts sparkline, fo-green/fo-red auto-color
- `components/ui/pct-pill.tsx` — % change pill with ArrowUp/ArrowDown, fo-* colors
- `components/dashboard/DashboardShell.tsx` — rewritten, added /agents and /trading nav items
- Added deps: clsx, tailwind-merge, class-variance-authority

---

## 📋 Backlog (Not Yet Approved)

| Task | Type | Priority | Notes |
|---|---|---|---|
| TraderAgent — approval_required mode (real Robinhood orders) | Feature | High | After signal validation; account ••••0660 only |
| LearnerAgent — weekly weight mutation | Feature | Medium | After 10+ closed trades (Phase 0 gate) |
| strategy_config UI editor | Feature | Low | Phase 1 last |
| Mobile trade approval push notifications | Feature | Low | Phase 5 |
| knowledge/event-patterns/ population | Research | High | Fed decisions, earnings patterns, macro |
| SEC EDGAR Form 4 insider trades | Integration | Medium | Free API |
| Railway cron deployment | Infrastructure | Medium | Phase 5 alternative to pg_cron |

---

## Architecture Decisions Log (Quick Ref)

Full details in `PROJECT_DECISIONS.md`. Summary here:

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Styling | fo-* tokens + shadcn | Tailwind only | Design system consistency |
| DB | Supabase | Prisma/PlanetScale | Already active |
| Primary AI | Anthropic Claude | OpenAI | Already integrated, best reasoning |
| LLM routing | Claude → DeepSeek → Groq by task | Single model | Cost optimization + comparison |
| Trading | Robinhood MCP | Alpaca, IBKR | Robinhood native agentic support |
| Price data | Massive API (Polygon.io) | Yahoo Finance | Reliability + options data |
| Screener primary | FinancialDatasets screen_stocks | Robinhood run_scan | Deeper fundamentals |
| Vector store | pgvector (Supabase) | Pinecone | No new infra needed |
| Agent mode default | approval_required | auto | Safety first |
| Screener candidates/day | 3 max | 5 | 10% position sizing → max 10 positions |
| Regime detection | None (scoring adapts naturally) | Explicit bull/bear mode | Fragile; scoring handles it |
| Learning schedule | Weekly batch | Per-trade | Need 10+ trades; per-trade is noise |

---

## How to Add a Task (Any Agent)

1. Add to "Planned" or "Backlog" section
2. Tag with your model name in "Assigned To"
3. Move to "In Progress" when you start
4. Move to "Completed" when done, note what you built

---

*Last updated: 2026-06-29 by Claude (Sonnet 4.6)*
