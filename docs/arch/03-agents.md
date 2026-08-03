# Kairos — Agents
> 2026-08-01 documentation truth audit: reconciled the ResearchAgent screener,
> five scoring dimensions, provider order, exact formulas, availability rules,
> weight resolution, and breakdown veto against production code. Added a
> plain-English report-card explanation beside the exact quantitative contract.
>
> 2026-07-31 event-aware/ADR correction: ResearchAgent batch-annotates company symbols from `earnings_calendar` before fetching fundamentals (1-day cache inside -3/+14 report window; otherwise/unknown 7 days; Finnhub profile 30 days). Theme Scout only proves a ticker with quote data. Reviewed US exchange ADRs persist `asset_class='adr'`, skip structurally inapplicable Form 4 evidence, and use ADS-compatible Yahoo fundamentals without foreign-underlying fallthrough. `SKHY` is the reviewed Nasdaq SK hynix ADS; `SKHYV`, `HXSCL`, and `HXSCF` are blocked substitutes.
>
> 2026-07-31 scoring data-truth correction: ResearchAgent is the sole authoritative
> scorer; the legacy Supabase `research-agent` function is a 410 tombstone. Provider
> sector taxonomies are explicit. Finnhub industries are crosswalked only when
> unambiguous, unknown sectors omit relative-P/E scoring, and P/E outside `(0, 200]`
> is unavailable for valuation. Fundamental, sentiment, macro, and insider inclusion
> requires explicit availability. A weak close remains evidence, but only ATR-scaled
> or high-volume declines can hard-veto. See
> `features/scoring-data-truth/FEATURE_ARCHITECTURE.md`.
> Last updated: 2026-07-22 (contract layer fix: macro.regime_inputs marked US-only in INTENT_CATALOG, INTENT_CLASSIFICATION, and SCORER_FIELD_CONTRACTS — contracts now match the pipeline reality that fetchMacroScore/applicableDimensions/persistObservedResearchEvidence have always enforced; shadow resolver no longer reports 0% India macro starvation; ETF analyst_score capped at 65 in ResearchAgent + archetypes; lane-comparison API added; Monte Carlo in BacktestPage; capital-rotation trigger unblocked — see history below)
> Prior: 2026-07-17 (the asset allocator is now market-scoped too — India no longer inherits the US FRED regime for sleeve weights, and macro UNAVAILABLE means NO allocation rather than an untilted config echo; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted; India SEBI PIT evaluated as the India insider analog and REJECTED on live evidence — 0/34 India symbols clear the US open-market bar at 90d, ~70% of PIT rows are non-open-market (ESOP allotments marked "Buy"); India insider stays honestly UNAVAILABLE, pinned by tests/india-insider-not-wired.test.ts; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted; Macro read (Agent Mind Phase 3) documented for the first time and scoped **US-only** — the India read is killed, not faked: BOTH its macro inputs (`macro_regime` AND the `category='macro'` `learning_priors`) are US-only and unmarket-tagged, and the priors were the live leak in prod row id=6, so gating only the regime would not have fixed it; the route now refuses `market=india` on both verbs before any LLM call or DB write, and `MacroReadCard` states the gap instead of vanishing. Also fixed the 4-day silent outage of that agent — `deepseek-reasoner` burned the whole `maxTokens: 600` budget on chain-of-thought and returned empty content (`finish_reason=length`) from 2026-07-13 onward, so nothing was written while both crons reported success; 600 → 1500. Corrected the stale "looks back up to 3 weeks" macro line that contradicted this chapter's own 10-day consumer contract; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted; CPI Inflation now actually loads — MacroSentinel advertised 8 indicators and shipped 7 on every run since the FRED cutover because it fetched exactly 13 CPI readings and required 13, while FRED writes "." for a missing month (2025-10) that the adapter drops; YoY now aligns on the paired MONTH via fredSeriesDated + observationMonthsBefore rather than array index, since a gap-collapsed array makes vals[12] 13 months back — a wrong number, not just an absent one)
> Update this file when: a new agent is added or removed, an agent's schedule changes, an agent's inputs or outputs change, or an agent's key behavior changes.

**Adding an agent:** create `app/api/agents/<name>/route.ts` + add cron entry in `vercel.json` (cloud) or `scripts/run-agents.ps1` (local) + update this file (prose/registry only) + update `public/agent-diagrams/system-map.json` (the node, its edges, and a `history` entry — this is where the topology change lands) + add or update the per-agent diagram `public/agent-diagrams/<agent>.json` (same `agentId`/`agentLabel`/`diagram`/`nodes`/`history` contract; `nodes` is an object keyed by node id, never an array).

---

## Agent coordination model

**There are zero direct agent-to-agent HTTP calls.** All coordination is via shared Supabase
tables. Agents write and read a common set of tables; they never invoke each other's HTTP
handlers directly.

**The topology diagram lives in exactly one place:** `public/agent-diagrams/system-map.json`,
rendered at `/dashboard/agents` → **"System Map"** (the default diagram view). It is the single
source of truth for which agent hands what to which, and it carries a `history` audit trail of
every edge change. This chapter deliberately does **not** redraw it — a second copy of the same
edges does not add safety, it just gives a stale claim a second place to hide. (It already did:
both copies asserted `MACRO --> RESEARCH` unqualified long after `macro_score` became US-only.)
`tests/arch-diagram-drift.test.ts` enforces this.

The table below is the chapter's own altitude: **which tables** carry the coordination, not which
arrows exist.

### Table-to-agent matrix

| Table | Written by | Read by |
|---|---|---|
| `macro_regime`, `macro_signals` | MacroSentinel | ResearchAgent (**US only**), Macro read (**US only**), Dashboard |
| `macro_interpretations` | Macro read (**US only**) | Macro read's own GET → `MacroReadCard` on `/dashboard/markets`. **Nothing else** — no scoring/sizing/gate/order/exit path reads it |
| `agent_signals` | ResearchAgent, DeepSeekAgent | PaperTrader, TraderAgent, Dashboard |
| `signal_score_history` | ResearchAgent | ResearchAgent (trend), Dashboard charts |
| `decision_observations` | ResearchAgent | LearnerAgent, Validation Engine, PerformanceTruth |
| `edge_signals` | EdgeScout | ResearchAgent (**US candidate admission only**; fresh relative-strength provenance only), EdgeIC, Edge dashboard |
| `paper_positions` | PaperTrader | PositionMonitor, LearnerAgent, Dashboard |
| `paper_trades` | PaperTrader, PositionMonitor | LearnerAgent, MentorAgent, PerformanceTruth, **lane-comparison API** (closed trades → strategy lane NAV curves + Monte Carlo) |
| `strategy_versions` | LearnerAgent, User | ResearchAgent, Dashboard |
| `trade_memories` | PositionMonitor | ResearchAgent (RAG retrieval) |
| `agent_alerts` | All reporters | Health-Triage, Dashboard, Briefing |
| `mentor_insights` | MentorAgent | LearnerAgent (context), Dashboard |
| `strategy_evaluations` | PerformanceTruth/Evaluation | Dashboard |
| `benchmark_scorecard` | BenchmarkScorecard route | PerformanceTruth dashboard, future gated learner evidence |
| `rotation_events` | PaperTrader capital-rotation shadow evaluator | Dashboard/audit, future rotation validation |
| `validation_experiments`, `model_artifacts` | Validation/Calibration | Promotion gate, Dashboard |
| `broker_orders` | Execution Gateway + order sync | Reconciliation, **Trading Dashboard** (live orders surface on `/dashboard/trading` — read-only, pending/submitted/filled/error/unknown_needs_reconcile statuses, last 20 rows, market-scoped) |
| `broker_order_events` (target) | Execution Gateway + order sync | Audit/reconciliation |
| `trade_proposals` (shadow) | AutonomousShadow | Dashboard, owner audit |
| `trade_proposals` (live) | AutonomousLive | Dashboard, reconciliation |
| `broker_order_events` | AutonomousLive, Execution Gateway | Audit/reconciliation |
| `llm_call_log` | All LLM callers | Admin cost view |
| `rag_traces` | ResearchAgent (retrieval) | Debug/audit |

---

## Agent registry

### MacroSentinel — the economist

**File:** `app/api/agents/macro-sentinel/route.ts`
**Schedule:** Mondays 8:00 AM ET (Windows Task Scheduler)
**LLM:** None — fully deterministic

**Inputs:**
- 8 Alpha Vantage macro endpoints: Treasury yield 10Y + 2Y, unemployment, real GDP, nonfarm
  payrolls, CPI, retail sales, federal funds rate, durable goods orders

**What it computes:**
```
danger_score = Σ (indicator_value × weight × direction_sign)
```

Each indicator has a hardcoded `direction_sign` (+1 bad, -1 good) and weight summing to 1.0.

| danger_score | regime |
|---|---|
| 0–24 | GREEN |
| 25–49 | YELLOW |
| 50–74 | ORANGE |
| ≥75 | RED |

**Outputs:**
- One `macro_regime` row (current regime + score)
- One `macro_signals` row per indicator (raw_value + contribution + direction)

**Key behavior:** Advisory-only. MacroSentinel never auto-throttles agents or halts trading.
User sees the regime first and decides whether to act.

**Scope: US ONLY.** Every indicator is a US series (yield curve, Sahm rule, US GDP, nonfarm
payrolls, US CPI, US retail sales, fed funds, US durables). `macro_regime` has **no `market`
column**, so its verdict is US-only regardless of which symbol reads it. **It must never score a
non-US symbol.** Consumers are responsible for market-gating their own reads — `lib/data/scores.ts`
does this for the money path (India → macro UNAVAILABLE). A real India regime would be a separate
agent + a `market` column; `lib/india-macro.ts` (FII/DII) is thesis evidence, NOT a regime.

**Consumer contract for `macro_regime` (money path — `lib/data/scores.ts`):**
A row may score a symbol only if **all** hold. Otherwise macro is UNAVAILABLE → excluded from the
weighted score, weights renormalize. It never falls back to a calm/green default.

| Check | Rule | Why |
|---|---|---|
| Market | symbol is US | agent is US-only; table has no `market` column |
| Verdict | `regime != 'unknown'` | an unknown row's `danger_score` is a placeholder 0, not a calm read |
| Freshness | `week_of` within `MAX_MACRO_AGE_DAYS` = **10** | weekly cadence (7d) + 3d cron slack, and strictly < 14 so a fully missed run can never be masked by riding the prior week |
| Evidence | `raw_indicators` length >= 3 | mirrors MacroSentinel's own classification floor; rejects pre-guard legacy rows that stamped `green`/danger-0 off **zero** indicators |

`signals_triggered = 0` is **NOT** treated as suspect on its own — a genuinely calm week really does
trip zero signals, and rejecting those would bias the book bearish. The honest discriminator is the
indicator count.

**Second consumer — the asset allocator (`lib/allocation/allocator.ts` + `lib/allocation/regime.ts`,
2026-07-17).** `computeAllocation(svc, market)` maps the regime → sleeve target weights; its equity
target may only ever **shrink** that market's gross-equity cap in PaperTrader sizing. It applies the
**same four checks as the table above** and imports `MAX_MACRO_AGE_DAYS` from `lib/data/scores.ts`
rather than re-declaring the bound, so the two money-path consumers cannot drift on what "too old to
act on" means.

It previously filtered `strategy_sleeves` by market but read `macro_regime` **unscoped**, so the US
FRED verdict tilted India's sleeves — the same contamination class as the `macro_score` defect, and
latent only because `allocation_enabled` defaults off (verified `false` in prod). India sleeves *do*
exist in prod (equity 70 / defensive 20 / cash 10), so this was live-capable, not theoretical. India
now returns UNAVAILABLE **without querying `macro_regime` at all**.

**Macro UNAVAILABLE → NO allocation (`null`), not an untilted allocation.** The regime is the only
input that turns owner-configured sleeve rows into an allocation; emitting the base `target_pct`
with tilt=0 would be byte-identical to a real "macro says neutral" verdict — the
neutral-50-and-included fake in a different hat. For India this is permanent until a real India
regime is built; whether India should instead run *static* sleeve targets is a product call that is
deliberately left to the owner rather than silently made. **Accepted tension, stated not hidden:**
because the equity target only ever shrinks the gross cap, `null` leaves the owner's configured
`max_gross_exposure_pct` in force — *looser* than any regime outcome, including `risk_off`. That is
the documented default (identical to `allocation_enabled=false`, today's live state), not a
fabricated one; tightening on absent evidence would be an unapproved position change justified by
nothing. Callers already handle `null` (it is the shipped-off path). `computeAllocationDetailed()`
returns the same result plus a `reason` naming the specific rejected row(s).

> **Known gap (not a regression — pre-existing, reported 2026-07-17):** `normalizeRegime` matches
> `bull`/`bear`/`risk_on`/`risk_off`/`aggressive`/`defensive`, but MacroSentinel writes
> `green`/`orange`/`red`/`unknown`. **Every real label therefore normalizes to `neutral`, so the
> regime tilt is dead in prod today.** Fixing the vocabulary would *activate* tilting — a real
> behaviour change requiring its own approval — so it was deliberately left alone.

> **Proposal (not applied — schema change):** give `macro_regime` a `market` column so the table can
> express what it actually is, instead of every consumer having to remember to market-gate its own
> read. Until then, "US-only" is a convention enforced consumer-by-consumer, and each new consumer
> is a fresh chance to reintroduce this exact bug.

---

### Macro read (Agent Mind Phase 3) — the narrator

**File:** `app/api/agent-mind/macro-read/route.ts` (+ pure logic in `lib/macro-read.ts`)
**Schedule:** weekdays — `kairos-macro-read-us` (13:30 UTC). **Cadence: US only.**
**Writes:** `macro_interpretations` (one cached row/day/market)
**Read by:** its own GET → `MacroReadCard` on `/dashboard/markets`. **Nothing else.**

Turns the US macro regime + the US book + the system's US macro priors into a plain-English
"what this means for your book" narrative.

**NARRATIVE ONLY.** This is the LLM sibling of `macro_score`, and it is on **no** money path:
`macro_interpretations` is written here and read back by this route's own GET alone. The
deterministic rule stands — no LLM on any scoring/sizing/gate/order/exit path — and this route must
never widen its reach.

**Scope: US ONLY. The India read is killed, not faked.** (2026-07-17)

Both of this read's macro inputs are US-only and **neither is market-tagged**:

| Input | Why it is US-only | Market column? |
|---|---|---|
| `macro_regime` | MacroSentinel = 8 US FRED series (see above) | **No** |
| `learning_priors WHERE category='macro'` | US beliefs: Fed funds, DXY, 2Y/10Y curve, ISM/PMI, VIX | **No** |

> **The priors were the live leak, not just the regime.** Prod `macro_interpretations` id=6
> (2026-07-13, `market=india`) reads: *"…no regime-based bias can be assigned to this India book.
> The system's high-conviction belief (80%) that rising **Fed funds** rates comp[resses]…"* — against
> a 13-position India book, while the regime was **already `unknown`**. So market-gating only
> `macro_regime` would **not** have prevented that sentence. Prior id=8 ("Rising Fed funds rate
> environment…", confidence 0.80) did it.

**Why killed rather than "honestly scoped":** once both US-only inputs are withheld, an India read has
**zero** macro evidence left — only the held symbols. An LLM asked for a macro read with no macro
input either restates a constant ("we know nothing" — which does not need a `deepseek-reasoner` call
every weekday) or reaches into training knowledge for RBI/rupee/FII colour, inventing exactly what the
prompt forbids. So:

- The route **refuses `market=india` on both GET and POST** before any LLM call or DB write — zero
  spend, zero rows, and the legacy India rows (ids 2/4/6) stay unreachable.
- `MacroReadCard` renders a **deterministic not-supported note** for India instead of vanishing.
- This also resolves a self-contradiction: the India Markets view already renders a `NotSupportedNote`
  for *"…macro sentinel…"* while a cron wrote an India read derived from that same US-only sentinel.

**Parity** means both markets get an *honest* answer, not that both get an LLM call. `lib/india-macro.ts`
(NSE FII/DII) is deliberately **not** wired in as a substitute regime — that is a separate build.

**US path** reuses the same discipline as `lib/data/scores.ts` (unknown-guard, 10-day age bound,
`raw_indicators >= 3` floor, fail-safe to UNAVAILABLE). When no row qualifies the prompt states the
regime is **UNAVAILABLE** and interpolates **no** regime, danger score, summary or indicators — an
absent verdict is never described as calm. `MAX_MACRO_AGE_DAYS` is imported from `scores.ts`; the
indicator floor is restated in `lib/macro-read.ts` (it is module-private in `scores.ts`) and **must be
kept in sync**.

**2026-08-01 correction:** the obsolete `kairos-macro-read-india` cron was removed.
India remains without a macro narrative by design until market-local, source-backed
exogenous observations exist; the route-level refusal remains defence in depth.

---

### ResearchAgent — the analyst (the brain)

**File:** `app/api/agents/research/route.ts`, `lib/research-agent.ts`
**Schedule:** US 09:00 + 14:00 ET and India 09:30 + 12:30 IST on trading weekdays. US slots are DST-safe paired UTC jobs admitted by exact New York local time. Closed-day catch-up is non-executable.
**LLM:** per-flow from Settings → AI Models (`agent_config` row `research`, read via `getConfiguredModel`), default `deepseek-v4-pro` with thinking enabled. Writes thesis text only — scores are deterministic. (Was hardcoded Groq Llama pre-2026-07-12.)

**Inputs:**
1. Account-scoped holdings snapshots. Research may analyze approved holdings, but only holdings verified on the actual order account can authorize a SELL.
2. Watchlist from `watchlist` table
3. Screener candidates from FinancialDatasets `POST /financials/search/screener` (US) or NSE universe cache (India) — dual buckets. FinancialDatasets is supplemental discovery only: missing credentials, exhausted credits, HTTP failures, and timeouts open a self-healing System Health warning and return no screener candidates; holdings/watchlist/carry-forward research continues, and scoring fundamentals are unaffected:
   - *US fundamental-momentum screen*: revenue growth >15%, earnings growth >10%, gross margin >25%, ROE >15%, market cap >$2B; ranked by revenue growth. It does **not** use RSI or a moving average.
   - *US value screen*: 0 < P/E <18, FCF yield >4%, debt/equity <1, market cap >$1B; ranked by lowest P/E. It does **not** compare P/E with a sector median or require insider/analyst activity.
   - The two US lists are interleaved before the six-name screener cap, so one bucket cannot silently crowd out the other. India candidates come from the separately scored rotating `india_screen_cache`; the US criteria above are not applied to India.
4. Score trend from `signal_score_history` (last 5 rows per symbol)
5. Champion weights from `strategy_versions WHERE is_champion = true AND market = ?`
6. Macro regime from the most recent **usable** `macro_regime` row — **US symbols only**. A row is usable only if it has a real verdict (`regime != 'unknown'`), is within `MAX_MACRO_AGE_DAYS` (10) of `week_of`, and rests on >= 3 real indicators. Otherwise macro is UNAVAILABLE (excluded, never defaulted to calm). India never reads this table. (`lib/data/scores.ts`, 2026-07-16)
7. RAG memory via `retrieveSimilarTrades()` (if Jina embeddings are configured — Voyage was replaced by Jina free tier 2026-07)
8. India news/event replacement shadow — NSE corporate announcements + bounded Google News RSS, persisted to the canonical evidence cache but **not read by scoring** (2026-07-31). The old zero-output GDELT dimension is retired.
9. India FII/DII net cash flows — live NSE (`lib/india-macro.ts`), injected into the India thesis prompt (2026-07-12)

**Webull boundary:** Webull analyst/extended research is collected by the Evidence Router shadow, not called synchronously by `processSymbol`. The old inline path could issue up to nine MCP tool calls per US symbol and repeatedly exhausted the per-symbol deadline. Authoritative research may consume Webull only after a separately approved cache-only reader passes Router parity; until then it cannot consume scoring capacity, alter scores/directions, or delay holdings research.

**Current production baseline (`deterministic_v1`) — 5 dimensions:**

#### Plain-English model: a five-subject report card

Think of each stock as receiving a report card. ResearchAgent, not the LLM, is the
teacher doing the arithmetic:

| Subject | Child-friendly question | Important limitation |
|---|---|---|
| Fundamentals | "Is the business healthy and reasonably priced?" | Quarterly company facts move slowly. An analyst target is written in the evidence, but currently earns **zero points**. |
| Technicals | "Is the settled price trend healthy, or did the stock just break down?" | Uses completed daily bars, not today's unfinished candle. It describes price behavior; it does not know the business. |
| Sentiment | "Are enough real news/social observations leaning positive or negative?" | Tiny samples are pulled toward 50. No data means the subject is omitted, not treated as a neutral vote. |
| Macro | "Is the current US economic weather supportive?" | US only. India does not inherit the Fed/FRED result. |
| Insider | "Are US insiders spending more money buying than selling in real open-market trades?" | US domestic issuers only; sparse data and ADR/India inapplicability are omitted. |

Every available subject receives 0–100. A missing or structurally meaningless
subject is removed and the remaining weights are rescaled. Fewer than two usable
subjects means **abstain**. The resulting `analyst_score` is a ranking/eligibility
input, not a promised return or a predicted price. The configured LLM may explain
the facts, but it cannot change any subject score, weight, direction gate, or order.

| Dimension | Source | What it measures |
|---|---|---|
| `fundamental_score` | Finnhub → Yahoo → FMP → AV reserve (domestic US); Yahoo-only ADS basis (reviewed ADR); Yahoo (India) | Sector-relative P/E when taxonomy maps safely, profit margin, ROE, EPS sign, and revenue growth YoY. Analyst target upside is persisted as `observational_only` and contributes no points. Cache is 1d near earnings, otherwise 7d. |
| `technical_score` | Yahoo → Massive → EODHD → Twelve Data → AV reserve (US); Upstox → Yahoo (India), all normalized to completed daily candles | RSI(14) continuous curve, EMA20/50, 20d trend, volume confirmation, and an ATR/high-volume breakdown veto. A weak bottom-quartile close is warning-only. A still-forming daily bar never enters scoring. |
| `sentiment_score` | StockTwits + GDELT first; AV NEWS_SENTIMENT only when both free sources are unusable (US only) | Sample-shrunk US news/social bullishness. StockTwits requires ≥5 tagged messages. When both social and news exist they blend 40%/60%. **India: structurally not applicable in the active scorer**; replacement headline/event evidence is shadow-only. |
| `macro_score` | `macro_regime.danger_score` — **US ONLY** | Macro backdrop from MacroSentinel. **India: dimension is UNAVAILABLE and excluded — weights renormalize onto the remaining dimensions** (2026-07-16). MacroSentinel is US-only by construction (8 US FRED series) and `macro_regime` has no `market` column, so scoring an India symbol from it stamped the US Fed's verdict onto Indian equities. India research still injects a factual **FII/DII net-flow line** (`lib/india-macro.ts`, live NSE) into the thesis prompt — narrative grounding only, deliberately NOT wired into `macro_score`; a real India regime is a separate build. FII/DII is null (line omitted) when NSE geo-throttles Vercel. (2026-07-12) |
| `insider_score` | **US:** Massive Form 4 → SEC EDGAR Form 4 → AV INSIDER_TRANSACTIONS (cascade, `resolveInsider`, first `available:true` wins). **India: none wired** — the dimension is excluded, not scored. | 90-day open-market (P/S only) buy/sell **value** ratio. India's SEBI PIT feed (`fetchNseInsider`) was evaluated as the analog on 2026-07-17 and **rejected**: 0/34 live India symbols clear the US ≥3-open-market-txn bar at 90d, and only ~30% of PIT rows are open-market at all (ESOP allotments are marked "Buy"). See the India insider block below. Its `agent_signals.insider_score` default-fills `50`, but `decision_observations.availability_mask.insider` is `false`, which is the honest record — do not read the 50 as neutral evidence. (2026-07-17) |

Sub-score formulas are deterministic and **fixed** (hand-tuned priors in `lib/data/scores.ts` + `lib/data/technicals.ts`) — they are NOT agent/genome-mutable. Only the dimension **weights** evolve through an explicitly promoted champion. New candidate features flow through the validation/registry process, not by silently editing these formulas. Volume is scored; analyst-target upside is intentionally observational-only.

**Technical calibration shadow (2026-07-21):** EdgeScout now measures the exact
`kairos_technical_score_v1` composite beside bounded `macd_atr_12_26_9` and
`signed_adx_14` challengers. EdgeIC evaluates them independently for US and India
and emits market-wide plus sufficiently broad sector diagnostic rows from the same
already-fetched candles. This is measure-only: it does not add MACD/ADX to the
score, create sector-specific parameters, or change any agent decision. Formula,
dataset, segment, and run fingerprints preserve later recalibration history.

**US relative-strength discovery (2026-08-01):** ResearchAgent may read a fresh
completed-session EdgeScout snapshot to add at most four non-ETF US symbols to its
candidate batch when both six-month relative strength and 52-week-high proximity are
positive within that snapshot. This is *admission only*: the edge values are stored as
provenance, never added to `analyst_score`, thresholds, sizing, exits, or orders. The
usual deterministic scoring and portfolio gates remain authoritative. India is not
included until an equivalent candidate contract is verified.

The Research Journal renders those immutable admission measurements beside the decision
as **Admission evidence**. They explain why the candidate was researched, not why a
trade was eligible; the canonical score and downstream terminal state remain separate.

**Calibration readiness monitor (2026-07-21):** A weekly deterministic monitor
collapses same-window provider revisions, counts only market-wide windows at least
five calendar days apart, and publishes progress per edge/market/horizon. Six stable
historical windows can request the PIT/walk-forward/cost/FDR validation build; four
qualified validation windows can request shadow review. Both are review milestones,
not lifecycle promotion or trading permission. The monitor makes no provider call and
emits a one-time informational notice plus a warning if collection is stale >10 days.

**Weighted composite (availability-masked + renormalized):**
```
analyst_score = Σ (dimension_score × effective_weight[dimension])
```
Missing/inapplicable dimensions are EXCLUDED and the remaining weights renormalized to sum to 1.0 (`lib/scoring/weighted-score.ts`); `< 2` usable dimensions → abstain (thin evidence), never a low score. Weight source: this market's promoted champion `weights_snapshot`; if none exists, the selected risk-profile static weights; if the profile is invalid, balanced F.30/T.25/S.20/M.15/I.10. The mandate's strategy tilt is then applied. The legacy `signal_weights` and `learning_priors` tables are not live-score fallbacks.

**ETF score cap (2026-07-22):** ETFs exclude fundamental + insider dimensions; after renorm, technical carries ~62% weight. Low-volatility ETFs (SGOV, VTV, SCHD) were scoring 77–80 — above single-name equities — and the capital-rotation shadow proposed selling PLTR to buy SGOV. A hard cap of `ETF_SCORE_CAP = 65` is applied post-computation in both `lib/research-agent.ts` (main analystScore + challenger shadowScore) and `lib/scoring/archetypes.ts` (`computeArchetypeScore` for `etf_trend`). ETFs can still surface as SELL targets for held positions and can enter the book up to score 65; they cannot displace an equity candidate scoring ≥ 66.

**Indicative trade plan (2026-07-20):** ResearchAgent now records the latest
scoring-candle close in `decision_observations.price_at_decision` and a versioned
native-currency `features.trade_plan`. Eligible new longs get deterministic
mandate-based approximate risk/target levels; rejected and held names do not.
This adds no provider call and no LLM number. The plan is audit/presentation
context only; a close older than seven calendar days is marked unavailable.

**Low-confidence output (2026-07-12):** ResearchAgent aggregates per-market evidence availability across a run; when ≥ 50% of scored symbols (min 2) were scored on `< 2` of 5 dimensions, it raises a `low-confidence-research:<market>` System Health alert (warn/data) naming the commonly-missing dimensions, and resolves it when a run recovers. Surfaces *quality* gaps (thin data) alongside the existing *quota* alerts (provider budget).

**Holdings ordering + fail-loud (2026-07-16, bug fix — both markets):**

Holdings lead the batch and are exempt from the candidate cap, but they are **not** exempt from the cron's wall-clock budget (`RESEARCH_BUDGET_MS`, ≤105s). Throughput is ~30 symbols/run; the US book was 56. Because holdings order was *stable* (broker capture order, later alphabetical), the budget decapitated the **same tail every run, permanently** — prod run `a4530e8f` (07-16) wrote signals for batch slots 1-30 and **zero** for slots 31-56, all holdings. AVGO (slot 55) went unscored 07-13 → 07-16 while Risk Analytics advised trimming it. `enqueueDeferred` could not rescue them: `gatherSymbols` rebuilds holdings from the broker snapshot each run and `addCandidate` drops any symbol already in `holdingSet`, so a deferred holding re-entered at the same starved index forever.

- **Holdings are staleness-ordered** — least-recently-scored first (`orderHoldingsByStaleness`, `lib/research/holding-symbols.ts`), from this market's own `agent_signals`. The budget's cut now **rotates**, bounding worst-case staleness at `ceil(nHoldings / throughput)` runs instead of never. Applies to US and India identically.
- **`fetchHoldings` fails loud** — the old `catch { return []; }` made a broken holdings read indistinguishable from "owns nothing", so research would score new BUYs while blind to every position it might need to SELL. It now raises a `research-holdings-fetch:us` critical System Health issue and **throws** (no holdings visibility → no run). PostgREST `error` is checked, not just `data`.
- **India parity** — a rejected Kite call raises `research-holdings-fetch:india-kite` (warn, auto-resolves) and continues on the paper book, since a token lapse is expected/recoverable; an India `paper_positions` DB fault aborts like US.
- **Deferred holdings alert** — any held symbol the budget misses emits a warn `cron` alert naming the symbols. This is the only signal that the book exceeds one run's throughput, since the deferral queue can't carry holdings.

> **Known capacity limit (not fixed by ordering):** with 56 holdings and ~30/run, *every holding every session* does not fit in one 150s `maxDuration` invocation. Rotation bounds staleness at ~2 runs; closing it fully needs a capacity decision (raise `RESEARCH_PARALLEL`, or split holdings into their own cron) — a design change, deliberately not taken here.

#### Sub-score formula reference (`deterministic_v1`, exact values)

Each dimension outputs 0–100, clamped. Source of truth: `lib/data/scores.ts`, `lib/data/technicals.ts`.

**Fundamental** (`scoreFundamentals`) — base 50. At least two real fields among P/E, margin, ROE, EPS, and revenue growth are required before the dimension is marked available. The function emits a display placeholder of 55 for an ETF or missing overview, but that placeholder is excluded from the composite and is not evidence. Additive when available:
| Field | Bands → points |
|---|---|
| P/E (sector-relative) | `ratio = pe / SECTOR_PE_NORM[sector]`. <0.7 → +18 · <1.0 → +8 · <1.4 → −3 · <2.0 → −12 · ≥2.0 → −22 |
| Profit margin | >0.20 → +20 · >0.10 → +10 · <0 → −20 |
| ROE (TTM) | >0.20 → +15 · >0.10 → +8 · <0 → −10 |
| EPS | >0 → +5 · ≤0 → −10 |
| Rev growth YoY | >0.20 → +15 · >0.10 → +8 · <0 → −10 |
| Analyst target upside `(target−price)/price` | **0 points.** Stored as `analyst_target_mode='observational_only'` for audit/display only. |

`SECTOR_PE_NORM`: technology 30 · communication 20 · health care 25 · consumer disc. 24 · staples 22 · industrials 20 · materials 16 · energy 12 · financials 14 · utilities 18 · real estate 30. Missing/unmapped sector taxonomy omits the P/E component; it does **not** receive a made-up default norm. Nonpositive P/E and P/E >200 are also omitted.

**Technical** (`scoreTechnicals`) — base 50; <15 candles → flat 50. Additive:
| Signal | Contribution |
|---|---|
| RSI(14) | continuous interp over anchors `(20,−20)(35,−16)(45,−5)(50,+2)(55,+12)(60,+25)(72,+25)(75,+6)(85,−10)(100,−15)` |
| Price vs EMA50 | above +15 · below −15 |
| Price vs EMA20 | above +10 · below −10 |
| 20-day trend (±3% band) | up +10 · down −10 |
| Volume vs 20d avg (direction-confirming) | in-direction ≥1.5× → ±8 · ≥1.2× → ±4 (direction from EMA20/trend; neutral context → 0) |

**Breakdown veto** (`detectBreakdownVeto`, runs FIRST) — before the additive math, a deterministic crash/meme-reversal check caps the technical score at 20 when the last bar is down ≥2.5 ATR, or ≤−7% on ≥1.5× volume. A bottom-quartile close on a down bar is persisted as a **warning only** and does not veto. This fixed the case where a −12% high-volume reversal scored ~100 because RSI fell into the preferred band while price remained above its EMAs.

**Sentiment** (`fetchSocialSentiment` + `scoreSentiment`) — StockTwits and GDELT are fetched first. Fewer than 5 sentiment-tagged StockTwits messages is unavailable. Each available component is shrunk toward 50: social uses neutral prior K=10; news uses K=5. If both exist, `sentiment = 0.4×social + 0.6×news`; otherwise the available component wins. AV NEWS_SENTIMENT (`(sent+1)×50`) is called only when both free sources fail. The final value is excluded unless `has_data=true`; the label fallback exists for legacy shapes but cannot make a failed current fetch available.

**Per-run evidence contract.** Every ResearchAgent packet retains the input facts and derived values used for its five dimension scores in `research_packets.raw_data._scores.evidence`, including the completed-session close and candle date for technicals. `signal_score_history` retains the immutable score trajectory and links each point back to its packet. The user-visible audit surfaces are Research Journal's **Quant audit** for that run and Score Tracker's **Point Detail** for score-to-score comparisons. This is an explanation record, not a second scorer: displayed facts never alter an already-recorded decision.

**Feature-pack catalog (P0, 2026-08-02).** `lib/feature-packs/catalog.ts` is a typed read model that classifies a decision's inputs as active v1, measure-only, observed-only or inapplicable for its instrument family. Research Journal renders this classification from stored evidence only; it never fetches data or changes a decision. Strategy Library uses the same catalog to label manual Scanner support, shadow-only rules and unsupported conditions. The catalog has no score, paper, live, exit, sizing, broker or feature-registry writer.

**Feature registry lifecycle (2026-08-02).** Learner-proposed formulas are `proposed`, `quarantined`, `measure_only`, or `retired`. A deterministic IC screen can only advance a formula to `measure_only`; it is recorded under `decision_observations.features.measured_feature_values` and cannot alter a score, eligibility, size, paper/live proposal, exit, or broker order. Any future score use requires the separate market-local replay, shadow, challenger and owner-promotion path in `docs/arch/09-learning-loop.md`.

**Macro** (`fetchMacroScore`) — **US symbols only** (India → UNAVAILABLE, excluded, weights renormalize). `100 − danger_score` from the newest `macro_regime` row that satisfies the full consumer contract above: real verdict (`regime != 'unknown'`) **and** `week_of` within `MAX_MACRO_AGE_DAYS` = 10 **and** `raw_indicators` length >= 3. Nothing qualifies → UNAVAILABLE, never a calm default. (Corrected 2026-07-17: this line previously said "looks back up to 3 weeks", contradicting the 10-day bound documented in the consumer-contract table in this same chapter — the unbounded reach-back was the 2026-07-13 prod bug, not the intended behavior.)

**Insider** (`resolveInsider` → Massive / EDGAR / AV) — `10 + buyRatio×80` where `buyRatio = buyValue/(buyValue+sellValue)` over 90 days, counting only open-market P/S codes (awards `A`, exercises `M`, gifts `G`, tax-withholding `F` are `other` and excluded — they are not conviction trades). Requires ≥3 transactions; <3, no data, ADRs, or fetch-fail → `available:false` (excluded).

**Reviewed ADR contract (2026-07-31):** `lib/instruments/adrs.ts` is the explicit identity registry; suffix guessing is forbidden. ADRs run in the US/USD research and paper pools and are segmented as `adr` for evidence/learning. Because foreign private issuers generally have no Section 16 Form 4 stream, insider is not fetched and remaining applicable dimensions are renormalized. Live execution recognizes ADR as a non-fund equity but adds no permission: broker review, account allowlist, market controls, kill switches, portfolio gates, and broker acknowledgement all remain mandatory.

> **Insider is expected to be sparse, and that is correct** (`EXPECTED_SPARSE_DIMS` holds `us:insider`). Most Form 4 activity is compensation-related, not open-market buying, so an empty insider result is usually a real finding rather than a fault. That is exactly why a *failure* must never render as one — see below.

**India insider (SEBI PIT): evaluated 2026-07-17 → DO NOT WIRE.** India *does* have an insider
analog — `fetchNseInsider` (`lib/nse-data.ts`) reads SEBI PIT (Prohibition of Insider Trading)
disclosures from NSE `/api/corporates-pit`. It is built but deliberately **not** connected to
`insider_score`. It failed the data-qualification bar on live evidence measured against the 34 real
India symbols in the book:

| Test | Result | Bar |
|---|---|---|
| Coverage: any PIT row in 90d (the US window) | **2/34 = 6%** | — |
| Coverage: ≥3 open-market txns in 90d (the US bar, `MIN_INSIDER_TRANSACTIONS=3`) | **0/34 = 0%** | fails |
| Widening to 365d | 1/10 large caps scorable | fails |
| Semantics vs US Form 4 (90d open-market P/S buy/sell **value** ratio) | only ~30% of PIT rows are open-market (Market Purchase 9.7% + Market Sale 19.5%); the rest are ESOP allotments 29.2%, Off Market 22.1%, Gift 5.3%, pledges, amalgamations | fails |
| Freshness / PIT lag (`intimDt` − `acqfromDt`) | p50 2d, p90 34d, max 71d; 83% disclosed after the transaction | usable in principle |

A dimension available for **0%** of the universe is not a usable dimension. Worse, PIT's
`tdpTransactionType` marks an **ESOP allotment as "Buy"** — so a naive wiring would read routine
equity compensation as insider conviction. A same-named field carrying different meaning across
markets is worse than an absent one, and `insider_score` is a genome dimension that reaches paper
buys. India's insider dimension therefore stays **honestly unavailable**: `applicableDimensions()`
omits it for India, the availability mask excludes it, and the weights renormalize onto the
remaining dimensions. Pinned by `tests/india-insider-not-wired.test.ts`. Revisit only if SEBI PIT
open-market density rises materially — the 0%-at-90d measurement is the gate.

> **Two live defects found in the PIT read path while qualifying it (display-only, NOT on the money
> path, not fixed here — no caller feeds scoring):** (1) `fetchNseInsider()` with **no symbol**
> returns `{"data":[]}` unconditionally — NSE's market-wide PIT feed requires `from_date`/`to_date`,
> which the function never sends. `SmartMoneyPage.tsx` calls `/api/india/insider` with no symbol, so
> the India insider tab has **never** shown a row (same class as the 2026-07-16 EDGAR Form 4 404).
> (2) The per-symbol call sends no date window either, so NSE returns the latest ~20 disclosures
> **regardless of age** — RELIANCE's default response spans back to **24-Sep-2021** — while the
> route reports `available: trades.length > 0`, which would present 5-year-old disclosures as
> current. Both are cosmetic today precisely because nothing consumes them.

**Form 4 URL contract (bug fixed 2026-07-16 — US insider data had never worked):** the Form 4 XML
must be resolved from `filings.recent.primaryDocument` in the submissions JSON, with the
`xslF345X0N/` prefix **stripped** (`buildForm4XmlUrl`, `lib/data/edgar-insider.ts`). Two traps:
`<accession>.xml` is not a real EDGAR artifact and 404s for every filing; and `primaryDocument`
itself points at the XSL *rendering*, which SEC serves as `text/html` — it returns **200** but
contains no `<rptOwnerName>`/`<nonDerivativeTransaction>` tags, so it parses to zero transactions
(a silent empty, worse than an error). The filename also varies by filer agent
(`form4.xml`, `tm2618092-2_4seq1.xml`, `wk-form4_1784149645.xml`), so it must never be hardcoded.
The archive path needs the **unpadded** CIK; the zero-padded form 301-redirects.

**Availability is recoverable without a schema change.** `agent_signals` stores only the score, so
an unavailable `50` and a genuinely balanced `50` are identical there. The `available` flag is
already persisted in `decision_observations.availability_mask` (linked by `signal_id`), which is
what `/api/markets/smart-money` joins to filter `highInsider`. Note prod holds rows that are
`available:true` **and** exactly `50` — so "treat any 50 as unavailable" is *not* a valid shortcut;
it would misreport real balanced data as missing.

Known gaps (deliberately not yet added — see the hype-catch discussion / IC-gate path): relative-strength vs index, MACD/ATR, 52w-high proximity, EMA200; debt/leverage, FCF yield, EV/EBITDA, revenue *acceleration*, sector-relative margins; per-symbol macro beta; insider role/cluster weighting.

**Target v2:** asset/setup-specific PIT feature snapshots, comparable-universe rank, structural
evidence confidence, contradiction/event gates, and deterministic action. The complete contract is
`features/scoring-methodology/FEATURE_ARCHITECTURE.md`; v2 remains non-actionable until its
lifecycle and validation gates pass.

**LLM role:** explanation, risks, catalysts, and a bounded evidence-citing veto only. It never
generates score, probability, expected return, direction, weight, size, or lifecycle state.

**Screener target:** 3 candidates/day (not 5). With $10k NAV and 10% sizing, max 10
positions. Daily churn of 5+ creates overtrading.

**Outputs:**
- `agent_signals` row per symbol (score + thesis + recommendation)
- `signal_score_history` row (append-only score history)
- `decision_observations` row (even for skipped/expired candidates)
- `rag_traces` row (if RAG ran)

---

### DeepSeekAgent — the comparison analyst

**File:** `app/api/agents/deepseek/route.ts`
**Schedule:** Weekdays 9:00 AM ET (parallel with ResearchAgent)
**LLM:** DeepSeek `deepseek-v4-flash` with thinking disabled

**Inputs:** Same watchlist and screener pipeline as ResearchAgent.

**Key behavior:** Advisory comparison only. Current code asks DeepSeek for an LLM-generated
`analyst_score`; it must be tagged `score_source='llm_advisory'`, remain `status='advisory'`,
and be structurally excluded from PaperTrader and TraderAgent. Future comparison should reuse the
deterministic score and compare explanation/veto quality.

**Outputs:** `agent_signals` rows tagged `agent_label = 'deepseek'`

---

### PaperTrader — the pretend-money trader

**File:** `app/api/agents/paper-trade/route.ts`
**Schedule:** US 10:05 AM ET, India 4:35 PM IST (standalone crons, independent of research)
**LLM:** None

**Inputs:**
- `agent_signals` WHERE `status = 'pending'` AND `created_at` is today (market timezone) AND `market = ?`
- the market's `trading_mandates.score_threshold` (canonical entry threshold; the legacy global threshold cannot loosen it)
- deterministic `score_source` and a strategy version currently in `paper_active` lifecycle
- `paper_portfolio` for pool cash
- `paper_positions` for existing open positions

**Key behavior:**

**Signal freshness gate:** Only fills signals created today in the market's own timezone
(New York for US, Kolkata for India). Older signals are marked `expired`.

**Claim-and-fill protocol (prevents double-fills):**
1. Claims a signal by stamping `claim_run_id` on the `agent_signals` row
2. Opens paper position only if it still owns the claim

**Position sizing:**
- `position_size_pct` from champion genome (clamped to `strategy_config.position_size_pct`)
- Slippage model: 0.05% above mid
- Records `expected_price` and `realized_slip_pct` on every fill

**Fill-bound risk plan:** PaperTrader ignores research-time absolute levels. It
binds stop and target to the fresh actual fill using the current market mandate,
or the same-market/horizon MAE/MFE percentiles only after 60 eligible-long labels
exist. Learned values are bounded to a 10% maximum stop and 40% maximum target;
invalid or thin data falls back to the mandate. Planned-versus-bound percentages
are appended to the Research Journal pipeline trail.

**Risk gates (added 2026-07-09):**
- **Latched controls:** both pause and trading-enabled controls are checked per market; a recovered kill-switch metric cannot silently re-enable entries
- **Name cap:** `trading_mandates.max_open_positions` per market (default 10), enforced again from the canonical DB value inside the row-locked fill RPC. It gates new names only and never liquidates an over-cap book.
- **Re-entry cooldown:** 5-calendar-day block after a position in a symbol closes
- **Pyramid gate:** New BUY only if fill price > existing avg_cost (no averaging down)
- **Long-only for new positions:** SELL signals only apply to symbols already held

**Capital-rotation shadow (added 2026-07-13; trigger corrected 2026-07-22):** When a candidate cannot be taken as-is — because the book is at its `max_open_names` cap **or** because it lacks cash — PaperTrader calls the deterministic rotation evaluator and writes one `rotation_events` row with the would-be source holding, edge, notional, and gate reasons. This is P0 measurement only: it does not sell, buy, create a proposal, or move cash. Paper rotation execution and live rotation proposals remain disabled/unbuilt behind `rotation_config`.

Until 2026-07-22 the evaluator was reachable **only** from the `insufficient_cash` branch. In practice the name cap binds first — the book exhausts its 10 slots long before it runs out of cash — and the cap check `continue`d before the rotation call, so the evaluator was unreachable and `rotation_events` stayed empty for nine days with shadow enabled. The cap check now sets a flag instead of skipping; the candidate flows through the remaining gates (sector cap, re-entry cooldown, pricing, sizing) and is evaluated for rotation at the funding step. Rotation is slot-for-slot, so this cannot grow the book; a candidate with no viable rotation is still skipped with the same `max_open_names` reason.

**Outputs:**
- `paper_positions` row (new open position)
- `paper_trades` row (buy leg)
- `paper_order_events` row (submitted + filled events)
- Updates `paper_portfolio.cash` and `paper_portfolio.nav`
- `rotation_events` row when either `max_open_names` or `insufficient_cash` triggers a shadow rotation evaluation

---

### PositionMonitor — the risk watcher

**File:** `app/api/agents/position-monitor/route.ts`
**Schedule:** US 4:15 PM ET, India 6:35 AM ET
**LLM:** None (exits are rule-based)

**Inputs:** All open `paper_positions` for the market; current prices.

**What it does on each run:**
1. Fetch current prices for all open `paper_positions` in the market
2. Update `highest_price` if today's price is a new high
3. Run exit checks (in priority order):
   - **Time stop:** age from `paper_positions.opened_at` > holding horizon → close. The per-market Trading Mandate is authoritative unless its governance explicitly permits a promoted champion horizon within the mandate bounds.
   - **Trailing stop:** `stop_loss = max(original_stop, highest_price × 0.93)` → close if breached
   - **Price target:** at target price → **partial profit-taking** (sell half, move stop to
     breakeven on remainder; US paper uses six-decimal fractional quantity, India remains
     whole-share; full close only when no valid partial leg remains)
   - **Score exit (immediate):** a fresh same-market `deterministic_v1` score below the exit threshold with direction still long closes the position at once. The score must be no older than `trading_mandates.max_signal_age_sessions` (default 2). A stale/unavailable score can never close a position; price, stop, target, time-stop, and hedge exits remain active. Legacy score flags are revalidated and cleared when stale or no longer below the exit threshold.
   - **Direction-flip exit (debounced):** a held-long position whose fresh signal flips to `short` below exit is NOT sold on the first session. It **arms** (staged in `paper_positions.exit_reason` as `direction_flip_armed:<session>`) and only **confirms** the exit once a strictly newer research session still flips; a one-session wobble disarms and the position is held. A flip on a position held fewer than `MIN_FLIP_HOLD_DAYS` (2) market days is ignored. Pure logic in `lib/trading/direction-flip.ts`. This debounce was added 2026-07-24 after 13/22 closed paper trades exited on same-week flips (min 1.3 days held).
4. **NAV drawdown circuit breaker:** if weekly NAV return < -5%, set
   `strategy_config.app_paused = true` and fire a critical System Health alert
5. **Benchmark sync:** upsert `paper_performance.bench_nav` with today's VOO (US) / ^NSEI (India) price

**On close:**
- Call `execute_paper_exit`, which atomically realizes FIFO lots (including a closed slice for a partial lot), updates/deletes the position, credits the correct market pool, and writes the decision journal; any mismatch rolls the whole exit back
- Call `indexClosedTrade()` for RAG (if Voyage embeddings are configured)

---

### TraderAgent — the live order proposer

**File:** `app/api/agents/trader/route.ts`
**Schedule:** Weekdays 9:45 AM ET (after research settles)
**LLM:** None

**Inputs:** eligible deterministic `agent_signals`. A numeric score alone is not live eligibility.

**Current behavior:** creates proposals. Manual submission is owner-gated through the hardened
Execution Gateway in `app/api/broker/orders/route.ts`.

- **`manual` (default):** Creates `trade_proposals` rows with `status = 'pending_review'`.
  Owner reviews and approves/rejects in the dashboard. Send invokes the deterministic Execution
  Gateway and broker preview/place sequence; no LLM supplies order parameters.

- **`auto` (future L4):** the old direct-submit branch is rejected. An authenticated worker may
  call only the shared execution kernel, under deployment flag, expiring owner lease, atomic
  budget, and a `live_approved` scoring version. Auto BUY is blocked until live protective exits,
  partial-fill sync, and reconciliation are operational.

**Current auto status:** disabled. India auto is a separate architecture. Eventual L4 must support
verified risk-reducing SELL before autonomous BUY.

**Architecture doc:** `features/live-auto-trading/FEATURE_ARCHITECTURE.md`

**Outputs:** `trade_proposals` rows (expire after 30 min in manual mode)

---

### LearnerAgent — the strategy improver

**File:** `app/api/agents/learner/route.ts` (entry); `app/api/agents/learner-brain/route.ts`
**Schedule:** Fridays 5:00 PM ET
**LLM:** Claude Opus 4.8 (upgraded 2026-07-03)

**Phase gate:** Mutation blocked until 10+ closed trades per market exist.

**Inputs (via tool-use loop — 9 tools):**
1. `get_closed_trades` — recent paper_trades with outcomes
2. `get_signal_weights` — current champion weights
3. `get_strategy_versions` — all challengers + their backtest results
4. `get_decision_observations` — scored decisions (including skipped)
5. `query_trade_decisions` — real historical enriched Robinhood trades by regime/action
6. `propose_challenger` — write a new `strategy_versions` row with new weights + genome
7. `run_validation` — trigger Validation Engine on the proposed challenger
8. `get_mentor_insights` — recent coaching notes
9. `semantic_search_decisions` — pgvector RAG over trade memories (if Voyage embeddings are configured)

**What it proposes:**
A Challenger `strategy_versions` row containing:
- 5 dimension weights (must sum to 1.0)
- Genome: `{entry_threshold, exit_stop_pct, exit_target_pct, horizon_days, position_size_pct, sizing_mode}`
- Possibly: a Feature Registry entry (a new formula idea — never runs as code)

**Auto-guard:** Blocks mutation if last 3 runs have win_rate < 35%.

**Governance boundary:** Learner/LLM may propose hypotheses, feature specs, and bounded
challengers. Deterministic fitting/optimizers produce numeric candidate parameters. Only Vaibhav
may promote lifecycle state. Learner cannot activate weights, versions, thresholds, money limits,
accounts, orders, or code.

**Closed-loop closure (2026-07-05):** When user promotes a Challenger to Champion, the
promoted `weights_snapshot` is read by ResearchAgent on its next run.

**Per-trade notes:** 1-sentence outcome summary per closed trade written to `learning_log`.

**Outputs:** `strategy_versions` (Challenger row), `learning_log` entries

---

### ThemeScout — the watchlist manager

**File:** `app/api/agents/theme-scout/route.ts`
**Schedule:** Independent weekly pg_cron job, Sunday 8:00 PM ET during daylight time
**LLM:** Per-flow `agent_config`; default Groq `llama-3.3-70b-versatile`

**Inputs:** Broad GDELT market headlines first. Alpha Vantage NEWS_SENTIMENT is
a cached fallback; TOP_GAINERS_LOSERS is used only when neither news source
returns usable headlines. Every LLM-suggested candidate must then pass a
deterministic Yahoo US quote lookup. That lookup proves the ticker currently
resolves to a positive market price; it deliberately does **not** fetch
fundamentals, because discovery should not spend scarce fundamentals calls.

**Key behavior:** Identifies emerging themes (e.g. `ai_infrastructure`, `clean_energy`). Adds
at most six verified US symbols to owner-scoped `watchlist` rows tagged by theme,
with a seven-day expiry. It is discovery-only: additions enter a later normal
ResearchAgent run and must pass the same deterministic scoring and eligibility
gates as every other symbol. It is not awaited by ResearchAgent, so a slow scout
cannot consume a research run's time or provider budget.

**Outputs:** New `watchlist` rows with `source = 'llm_theme'`, `theme`, `reason`,
`auto_added = true`, and `expires_at`; invalid tickers are quarantined.

---

### MentorAgent — the coach

**File:** `app/api/agents/mentor/route.ts`
**Schedule:** After position-monitor + learner runs
**LLM:** Claude Sonnet 4.6 (`claude-smart`)

**Inputs:** Closed `paper_trades` + `learner_insights` + macro context.

**Key behavior:** Writes plain-English coaching insights to `mentor_insights`. Three types:
`pattern` (what worked), `lesson` (what to change), `warning` (risk concentrations). Advisory
only — never touches money, weights, or positions.

**Mentor UI surfaces (all per-flow model from Settings → AI Models; each response carries a
`meta:{agent,model,agentKind}` for the AI-attribution chip, 2026-07-12):**
- **AI Coach** (`/api/agents/mentor-coach`, `mentor`→deepseek-v4-pro) — a TRUE tool-using
  agent loop (`runAgentLoop`, ≤10 steps, tools: query_behavior/learning_progress/market_context
  /read_principles).
- **Ask the Agent** (`/api/mentor/ask`, `mentor-ask`→deepseek-v4-flash) — UPGRADED from a fixed
  recent-rows snapshot to a tool-using retrieval agent (`runAgentLoop`, ≤8 steps): tools
  lookup_symbol / recent_activity / list_open_positions / worst_and_best_trades → answers on
  the EXACT data the question needs (targeted, not a generic LLM guess). SSE-streams the final
  answer word-by-word after the loop; emits meta as the first + last stream event.
- **Judgment Coach** (`/api/mentor/evaluate`, `mentor-evaluate`→deepseek-v4-pro) and **Market
  Thesis** (`/api/mentor/thesis`, `mentor-thesis`→deepseek-v4-pro) — single grounded
  `callLLM` (no tool loop); evaluate injects the symbol's real research_packet + signal.

**Outputs:** `mentor_insights` rows

---

### Health-Triage — the SRE

**File:** `app/api/agents/health-triage/route.ts`
**Schedule:** Every 6h + on-demand from dashboard
**LLM:** None — operational truth is deterministic

**Read-only — can never change config, money limits, weights, orders, or code.**

**Inputs:** Current open `agent_alerts` plus the latest run per agent/market in the last 48h.

**Key behavior:** Builds machine-readable `structured_issues` deterministically. An older failed
run disappears from current triage once a newer successful run for the same agent/market exists.
The snapshot carries its alert count and timestamp so Home can mark it stale against the live feed.

**Dashboard display:** `SystemHealthCard` on dashboard home. Green when clean. Severity-ranked.
Deep-link fix hints. Tier-1 safe actions (retry, resolve info/warn) are one-click.

**Outputs:** Append-only `health_triage` snapshots and an `agent_runs` bookkeeping row. It never
creates inferred alerts or modifies trading/configuration state.

---

### AutonomousShadow — the execution dry-run

**Files:** `lib/trading/execution-kernel.ts`, `lib/trading/autonomous-shadow.ts`,
`app/api/agents/autonomous-shadow/run/route.ts` (owner POST),
`app/api/agents/autonomous-shadow/cron/route.ts` (CRON_SECRET POST)
**Schedule:** Weekdays 07:30 UTC (30 min after research cron)
**LLM:** None — fully deterministic

**No broker calls in PA1. Purpose: prove the execution kernel fires, gates fire correctly,
and shadow proposals accumulate evidence before live mode is ever enabled.**

**Inputs:**
- `strategy_config` live_auto_* policy snapshot
- `agent_signals` (last 24h, `score_source='deterministic_v1'`, direction=long, score ≥ threshold)
- Current `broker_orders` filled count (open positions)
- Today's `trade_proposals` with `execution_mode='autonomous_shadow'` count

**Key behavior:** For each qualifying signal, creates a `trade_proposal` row
(`execution_mode='autonomous_shadow'`, `auto_run_id`, `auto_decided_at`), then runs it through
`evaluateAutonomousExecution()` — 9 ordered gates (see `lib/trading/execution-kernel.ts`).
Updates proposal status to `queued_auto` (kernel approved) or `manual_review_required`
(gate failed with named reason). Writes one `decision_journal` entry per run. Never touches
broker APIs, never calls reserve_live_order_budget, never submits any order.

**Gates (in order):**
1. `AUTONOMOUS_LIVE_ENABLED` deployment flag
2. `live_auto_enabled` DB toggle
3. Lease not expired (`live_auto_enabled_until`)
4. Direction = long only
5. Score ≥ score_threshold
6. `evidence_confidence` ≥ `live_auto_min_evidence_confidence` (floor 0.6)
7. Open positions < `live_auto_max_open_positions`
8. Orders today < `live_auto_max_orders_per_day`
9. Proposed notional ≤ `live_auto_max_per_order_usd` (skipped in PA1 — notional = 0)

**In current deployment:** gate 1 fires unless `AUTONOMOUS_LIVE_ENABLED=true` is set in Vercel env.
When false, all proposals land on `manual_review_required`. Shadow accumulates evidence.

**Outputs:** `trade_proposals` rows (shadow), `decision_journal` run summary

---

### AutonomousLive — the live submitter (PA3)

**Files:** `lib/trading/execution-kernel.ts`, `lib/trading/autonomous-live.ts`,
`app/api/agents/autonomous-live/cron/route.ts` (CRON_SECRET POST)
**Schedule:** Weekdays 14:00 UTC (10:00 AM ET, after research at 13:00 UTC)
**LLM:** None — fully deterministic

**Runs ONLY when:**
- `AUTONOMOUS_LIVE_ENABLED=true` in Vercel env AND
- `strategy_config.live_auto_enabled=true` AND
- `live_auto_enabled_until` not expired AND
- `live_auto_mode_us='autonomous'` or `live_auto_mode_india='autonomous'`

**Inputs:**
- `strategy_config` policy + per-market mode columns
- `agent_signals` (last 24h, `score_source='deterministic_v1'`, direction=long, markets in autonomous mode)
- `live_account_snapshots` for NAV (account 605420660, max age 4h)
- `paper_trades` for Kelly calibration (last 100 closed)

**Key behavior:** Same 9-gate kernel as shadow, plus:
1. Checks kill switches (`app_paused`, `security_locked`, `trading_enabled`)
2. Checks `live_auto_mode_[market] = 'autonomous'` per signal's market
3. Calls `computeAutonomousSizing()` for approved signals
4. Calls `reserve_live_order_budget_v2` RPC (`p_execution_actor='autonomous_worker'`) — atomic
5. Submits to broker:
   - US: `rhPlaceMarketOrder()` via Robinhood REST API (direct, no MCP — unavailable in serverless)
   - India: `placeEquityOrder()` via Kite Connect REST
6. Updates `broker_orders`: `status=submitted` + `broker_order_ref`
7. Appends `broker_order_events` row (`actor_kind='autonomous_live'`)
8. Updates `trade_proposals`: `status=queued_auto` or `manual_review_required`

**Per-market mode (migration 141):**
- `off` — market skipped entirely
- `manual` — no live orders from this agent; owner clicks Approve in dashboard
- `autonomous` — live orders submitted per above

**Safety:** `approved_by_user=false` in broker_orders. Any gate failure = `manual_review_required`, no order. Budget exceeded (RPC throws) = skip, log. Broker error = `unknown_needs_reconcile`, budget stays reserved.

**Outputs:** `trade_proposals` (autonomous_live), `broker_orders`, `broker_order_events`, `decision_journal`

---

### BriefingAgent — the daily email

**File:** `app/api/briefing/generate/route.ts`
**Schedule:** Weekdays 8:00 AM (morning) + 4:30 PM (evening) ET
**LLM:** Settings-controlled through `getConfiguredModel("briefing")`; default
`deepseek-v4-flash`, for editor/outlook prose only.

**Inputs:** Latest signals, paper positions, NAV, macro regime, open System Health alerts,
and the latest complete deterministic Holding Risk snapshots for every live account in
the edition's market.

**Key behavior:** Generates morning and evening briefing emails. Morning: pre-market outlook.
Evening: trade recap. Sends via Resend (or configured EMAIL_PROVIDER). Includes "Open Issues"
band when System Health alerts are present. Its Live Holdings Risk band replays immutable
per-account results (actionable/review postures first), exposes freshness/confidence/missing
inputs, and never recomputes risk or combines accounts/currencies. LLM prose cannot change a
HoldingRisk score or posture.

**Outputs:** `briefings` row, `newsletters` row (on successful Resend send)

---

### Validation Engine

**File:** `lib/validators/backtest.ts`, `app/api/agents/backtest/route.ts`

**Deterministic, no LLM.** Replays Challenger vs Champion on the same PIT opportunity set. For
v2 it must use purged/embargoed walk-forward folds, train-fold-only preprocessing/calibration,
out-of-fold predictions, costs/turnover, and multiple-testing accounting. The existing five-weight
replay remains a baseline, not sufficient proof for a new scoring architecture.

**Eligibility gates:**
- **Sharpe ≥ 0.5**
- **Win rate ≥ 40%**

Computes: Sharpe, Sortino, max drawdown, win rate, expectancy, alpha vs benchmark. If gates
pass, sets `eligibility_passed = true` on the `experiment_runs` row. Promotion is blocked
(HTTP 412) unless `eligibility_passed = true`.

---

### Performance Truth Layer

**File:** `lib/evaluation/run-evaluation.ts`, `/api/agents/evaluation/*`

Mandate-aware, deterministic (no LLM), honesty-first evaluation panel on `/dashboard/learning`.

**Evaluation metrics:** Sharpe, Sortino, max drawdown, win rate, expectancy, profit factor,
alpha vs benchmark, execution slip (mean realized vs 0.05% modeled).

**Honesty rules:**
- Fewer than 20 trades → shows "too small" instead of a number
- Tainted trades are counted (P&L must not hide them) but labeled as tainted
- `health_label` summarizes: `insufficient_sample` → `negative_or_zero_edge` → `promising_but_unvalidated` → `validation_required`

### Downside Hedge Controller

**File:** `app/api/agents/downside-hedge/route.ts`, `lib/trading/downside-hedge.ts`

Deterministic US paper-book overlay. It combines MacroSentinel with locally computed SPY/QQQ
confirmation and an audited `off -> armed -> active -> exit_pending -> cooldown` state machine.
Generic agents block inverse ETFs; only the paper-only hedge RPC may buy unleveraged `SH`/`PSQ`
when both settings flags are enabled. No LLM, live-order, broker, rotation, or cross-market path.
It ships fully OFF.

**P1 gate:** Weekly Vercel cron counts closed evaluable trades per market. Fires a System
Health info alert when ≥ 20 accumulate.

---

## 2026-07-17 Research and Exit Contract Audit

- The watchlist input is filtered by `research_enabled=true`, unexpired rows, and
  authoritative `market`; suffix inference is only a legacy fallback. US and India
  watchlist rows cannot enter each other's scoring pool.
- Holdings from paper and live snapshots are staleness-ordered and persist
  `agent_signals.is_holding=true`. PositionMonitor may only treat a holding-path
  signal as a reassessment input.
- Held positions receive the same deterministic evidence fetch, five-dimension
  scoring, availability mask, and market-local weights as candidates. They skip
  optional LLM narrative and RAG retrieval because those outputs cannot alter an
  action; this preserves wall-clock capacity for exit coverage and candidates.
- One worker from the existing concurrency pool is reserved for candidates while
  the remaining workers prioritize staleness-ordered holdings. Concurrency and
  provider quotas do not increase, but a large book cannot starve all discovery.
- Candidate overflow is carried forward with a stable original defer time and is
  pruned after six unsuccessful deferrals or seven days. Theme Scout rows expire
  after seven days, require an owner id, deduplicate per run, and cannot overwrite
  a durable manual row.
- Sentiment inputs are shrunk toward 50 using source sample size before blending.
  A five-message 100% bullish split therefore scores 67, not 100.
- Analyst targets are retained as observational evidence only. They do not alter
  fundamental or composite scores until a validation/promotion decision says so.
- India macro remains unavailable and excluded. It never queries or inherits the
  US-only `macro_regime`; effective weights renormalize over genuine India inputs.
- A stored held `short` below the entry threshold is not an independent exit gate.
  PositionMonitor still requires the lower `entry threshold - hysteresis` bound,
  a fresh score, and holding provenance. Stops and targets remain independent.
- Risk Analytics remains deliberately research-free in its risk formula. The UI
  may show the latest holding score and age beside the independent risk verdict;
  research cannot veto a concentration, drawdown, liquidity, or volatility risk.
## Earnings-Aware Risk P0 (2026-07-29)

PaperTrader annotates an otherwise-eligible entry after its fill-bound
stop/target plan exists and before either capital rotation or
`execute_paper_fill`. TraderAgent attaches the same normalized block to
`trade_proposals.risk_check_reasons`; its existing Alpha Vantage earnings
blackout remains unchanged and authoritative. Policy version 1 is shadow-only:
no agent reads the counterfactual verdict to change a score, quantity, stop,
target, fill, rotation, or exit. PositionMonitor is deliberately not wired.

US event dates are cross-checked against the PIT calendar, Finnhub, Webull, and
Robinhood. India records market-local proximity and always reports options as
unavailable. Robinhood research tools are a hardcoded read allowlist disjoint
from order/review/cancel tools.

## Shadow Registry and Upgrade Path (2026-07-29)

`lib/shadows/registry.ts` is the descriptive inventory for every active,
paper-active, armed, idle, or disabled evidence program. `/api/upgrade-path`
adapts existing truth ledgers into a read-only status model; it does not create
a parallel evidence table. `/dashboard/upgrade-path` refreshes that model every
minute and reports market scope, schedule state, progress, collection rate,
provider-call accounting, benefit evidence, blockers, and the separate
activation gate.

The DashboardShell market switch is the only market selector. The API requires
`market=us|india` and applies it to every market-bearing ledger query before
aggregation. It never combines US and India readiness. A US-only program stays
visible in the India view as `not_applicable`.

The registry has no write or activation capability. Estimated days are shown
only for a declared target with a non-zero observed rate. Uninstrumented calls
are labelled unmetered rather than zero. Capital rotation is labelled
`paper_active`, not shadow-only. Any future shadow producer is incomplete until
its ledger, schedule, safety boundary, and activation gate are registered.

## Deep-Dive Debate (2026-07-31 correction)

`/api/agents/deep-dive` is an owner-only, on-demand LLM research surface. Both
POST and cached GET use the owner gate before service-role reads. It remains
advisory: only `deep_analyses` is written and no signal, score, paper position,
proposal, or broker path consumes its verdict.

The route accepts canonical US class tickers and NSE/BSE `.NS`/`.BO` symbols.
US uses Massive/cache quotes plus Alpha Vantage fundamentals; India uses Yahoo
INR quotes and Yahoo India fundamentals and never borrows the US macro regime.
The configured LLM provider is resolved before its key is checked. The diagram
source is `public/agent-diagrams/deep-dive.json`.
