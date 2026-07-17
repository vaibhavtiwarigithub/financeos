# Kairos — Agents
> Last updated: 2026-07-17 (the asset allocator is now market-scoped too — India no longer inherits the US FRED regime for sleeve weights, and macro UNAVAILABLE means NO allocation rather than an untilted config echo; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted; India SEBI PIT evaluated as the India insider analog and REJECTED on live evidence — 0/34 India symbols clear the US open-market bar at 90d, ~70% of PIT rows are non-open-market (ESOP allotments marked "Buy"); India insider stays honestly UNAVAILABLE, pinned by tests/india-insider-not-wired.test.ts; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted; Macro read (Agent Mind Phase 3) documented for the first time and scoped **US-only** — the India read is killed, not faked: BOTH its macro inputs (`macro_regime` AND the `category='macro'` `learning_priors`) are US-only and unmarket-tagged, and the priors were the live leak in prod row id=6, so gating only the regime would not have fixed it; the route now refuses `market=india` on both verbs before any LLM call or DB write, and `MacroReadCard` states the gap instead of vanishing. Also fixed the 4-day silent outage of that agent — `deepseek-reasoner` burned the whole `maxTokens: 600` budget on chain-of-thought and returned empty content (`finish_reason=length`) from 2026-07-13 onward, so nothing was written while both crons reported success; 600 → 1500. Corrected the stale "looks back up to 3 weeks" macro line that contradicted this chapter's own 10-day consumer contract; macro_score is US-only — India macro now honestly UNAVAILABLE instead of inheriting the US FRED regime; macro_regime reads are age-bounded (10d) + indicator-backed, fail-safe to UNAVAILABLE never to calm; SEC Form 4 URL fixed — US insider data had never resolved; insider availability now recovered from `decision_observations.availability_mask` at the smart-money boundary; insider symbol universe unioned across all broker accounts; ResearchAgent holdings: staleness-ordered rotation under the wall-clock budget + fail-loud holdings fetch, both markets; per-flow LLM from Settings; India GDELT news sentiment + live NSE FII/DII macro inputs; low-confidence-research quality alert; Trading Style presets govern the time-stop before a champion is promoted)
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
```mermaid
flowchart LR
  MACRO[MacroSentinel] --> |macro_regime · US only| RESEARCH[ResearchAgent]
  MACRO --> |macro_regime · US only| MACROREAD[Macro read · narrative only]
  MACROREAD --> |macro_interpretations| MARKETS[/dashboard/markets/]
  UNIVERSE[PIT Universe + Providers] --> RESEARCH
  RESEARCH --> |agent_signals + decision_observations| PAPER[PaperTrader]
  RESEARCH --> |eligible proposal| TRADER[TraderAgent]
  RESEARCH --> |qualifying signal| SHADOW[AutonomousShadow]
  SHADOW --> |shadow proposal queued_auto / manual_review_required| PROPOSALS[(trade_proposals)]
  RESEARCH --> |qualifying signal autonomous markets| LIVE[AutonomousLive]
  LIVE --> |reserve_live_order_budget_v2| BUDGET[(broker_orders atomic)]
  LIVE --> |live order| BROKER2[Robinhood REST or Kite REST]
  LIVE --> |live proposal + events| LIVEAUDIT[(trade_proposals broker_order_events)]
  TRADER --> GATEWAY[Shared Execution Gateway]
  GATEWAY --> BROKER[Robinhood or Kite Adapter]
  RESEARCH --> |signal_score_history| RESEARCH
  PAPER --> |paper_positions paper_trades| MONITOR[PositionMonitor]
  MONITOR --> |closed paper_trades| LEARNER[LearnerAgent]
  LEARNER --> |challenger proposal| VALIDATE[Validation Engine]
  VALIDATE --> |evidence| USER((You))
  USER --> |promote champion| RESEARCH
  MONITOR --> |closed paper_trades| MENTOR[MentorAgent]
  MENTOR --> |mentor_insights| USER
  HEALTH[Health-Triage] --> |agent_alerts structured_issues| USER
  LEARNER --> |trade_memories via RAG| RESEARCH
```

### Table-to-agent matrix

| Table | Written by | Read by |
|---|---|---|
| `macro_regime`, `macro_signals` | MacroSentinel | ResearchAgent (**US only**), Macro read (**US only**), Dashboard |
| `macro_interpretations` | Macro read (**US only**) | Macro read's own GET → `MacroReadCard` on `/dashboard/markets`. **Nothing else** — no scoring/sizing/gate/order/exit path reads it |
| `agent_signals` | ResearchAgent, DeepSeekAgent | PaperTrader, TraderAgent, Dashboard |
| `signal_score_history` | ResearchAgent | ResearchAgent (trend), Dashboard charts |
| `decision_observations` | ResearchAgent | LearnerAgent, Validation Engine, PerformanceTruth |
| `paper_positions` | PaperTrader | PositionMonitor, LearnerAgent, Dashboard |
| `paper_trades` | PaperTrader, PositionMonitor | LearnerAgent, MentorAgent, PerformanceTruth |
| `strategy_versions` | LearnerAgent, User | ResearchAgent, Dashboard |
| `trade_memories` | PositionMonitor | ResearchAgent (RAG retrieval) |
| `agent_alerts` | All reporters | Health-Triage, Dashboard, Briefing |
| `mentor_insights` | MentorAgent | LearnerAgent (context), Dashboard |
| `strategy_evaluations` | PerformanceTruth/Evaluation | Dashboard |
| `benchmark_scorecard` | BenchmarkScorecard route | PerformanceTruth dashboard, future gated learner evidence |
| `rotation_events` | PaperTrader capital-rotation shadow evaluator | Dashboard/audit, future rotation validation |
| `validation_experiments`, `model_artifacts` | Validation/Calibration | Promotion gate, Dashboard |
| `broker_orders` | Execution Gateway + order sync | Reconciliation, Dashboard |
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

**Known-open:** the `kairos-macro-read-india` cron (jobid 47, `30 4 * * 1-5`) is **still active** and
should be dropped — a prod DB mutation, so it is flagged rather than done. The route-level refusal
makes it a harmless no-op meanwhile.

---

### ResearchAgent — the analyst (the brain)

**File:** `app/api/agents/research/route.ts`, `lib/research-agent.ts`
**Schedule:** Weekdays 9:00 AM ET (US), Weekdays 6:15 AM ET post-NSE-close (India)
**LLM:** per-flow from Settings → AI Models (`agent_config` row `research`, read via `getConfiguredModel`), default `deepseek-reasoner`. Writes thesis text only — scores are deterministic. (Was hardcoded Groq Llama pre-2026-07-12.)

**Inputs:**
1. Account-scoped holdings snapshots. Research may analyze approved holdings, but only holdings verified on the actual order account can authorize a SELL.
2. Watchlist from `watchlist` table
3. Screener candidates from FinancialDatasets `screen_stocks` (US) or NSE universe cache (India) — dual buckets:
   - *Momentum*: RSI > 60, price > 50-day MA, revenue acceleration, positive earnings revision
   - *Value*: P/E < sector median, high FCF yield, insider buying, recent analyst upgrades
4. Score trend from `signal_score_history` (last 5 rows per symbol)
5. Champion weights from `strategy_versions WHERE is_champion = true AND market = ?`
6. Macro regime from the most recent **usable** `macro_regime` row — **US symbols only**. A row is usable only if it has a real verdict (`regime != 'unknown'`), is within `MAX_MACRO_AGE_DAYS` (10) of `week_of`, and rests on >= 3 real indicators. Otherwise macro is UNAVAILABLE (excluded, never defaulted to calm). India never reads this table. (`lib/data/scores.ts`, 2026-07-16)
7. RAG memory via `retrieveSimilarTrades()` (if Jina embeddings are configured — Voyage was replaced by Jina free tier 2026-07)
8. India news sentiment — GDELT DOC 2.0 article tone (`lib/india-news.ts`), free/no-key (2026-07-12)
9. India FII/DII net cash flows — live NSE (`lib/india-macro.ts`), injected into the India thesis prompt (2026-07-12)

**Current production baseline (`deterministic_v1`) — 5 dimensions:**

| Dimension | Source | What it measures |
|---|---|---|
| `fundamental_score` | AV OVERVIEW (US) / Yahoo quoteSummary (India) | **P/E vs sector norm** (`SECTOR_PE_NORM`, not an absolute band), profit margin, ROE, EPS sign, rev-growth YoY, **analyst target upside** (target vs live close / 200-DMA proxy) |
| `technical_score` | AV RSI + EMA + SMA (US) / Yahoo candles (India) | RSI(14) **continuous curve** (interpolated anchors, no bucket cliffs), price vs EMA20/50, 20d trend, **volume confirmation** (elevated volume ±8 in the prevailing direction) |
| `sentiment_score` | AV NEWS_SENTIMENT + StockTwits (US) / **GDELT India news tone** (India, `lib/india-news.ts`) | Weighted news bullishness. India: aggregate tone of recent GDELT articles → 0-100; dimension stays *unavailable* (not faked) when GDELT returns < 3 articles (2026-07-12). |
| `macro_score` | `macro_regime.danger_score` — **US ONLY** | Macro backdrop from MacroSentinel. **India: dimension is UNAVAILABLE and excluded — weights renormalize onto the remaining dimensions** (2026-07-16). MacroSentinel is US-only by construction (8 US FRED series) and `macro_regime` has no `market` column, so scoring an India symbol from it stamped the US Fed's verdict onto Indian equities. India research still injects a factual **FII/DII net-flow line** (`lib/india-macro.ts`, live NSE) into the thesis prompt — narrative grounding only, deliberately NOT wired into `macro_score`; a real India regime is a separate build. FII/DII is null (line omitted) when NSE geo-throttles Vercel. (2026-07-12) |
| `insider_score` | **US:** Massive Form 4 → SEC EDGAR Form 4 → AV INSIDER_TRANSACTIONS (cascade, `resolveInsider`, first `available:true` wins). **India: none wired** — the dimension is excluded, not scored. | 90-day open-market (P/S only) buy/sell **value** ratio. India's SEBI PIT feed (`fetchNseInsider`) was evaluated as the analog on 2026-07-17 and **rejected**: 0/34 live India symbols clear the US ≥3-open-market-txn bar at 90d, and only ~30% of PIT rows are open-market at all (ESOP allotments are marked "Buy"). See the India insider block below. Its `agent_signals.insider_score` default-fills `50`, but `decision_observations.availability_mask.insider` is `false`, which is the honest record — do not read the 50 as neutral evidence. (2026-07-17) |

Sub-score formulas are deterministic and **fixed** (hand-tuned priors in `lib/data/scores.ts` + `lib/data/technicals.ts`) — they are NOT agent/genome-mutable. Only the dimension **weights** evolve (champion loop). New candidate features flow through the IC-gated Feature Registry, not by editing these formulas. (2026-07-10: scored the previously-dead volume + analyst-target signals, made RSI continuous, made P/E sector-relative.)

**Weighted composite (availability-masked + renormalized):**
```
analyst_score = Σ (dimension_score × effective_weight[dimension])
```
Missing/inapplicable dimensions are EXCLUDED and the remaining weights renormalized to sum to 1.0 (`lib/scoring/weighted-score.ts`); `< 2` usable dimensions → abstain (thin evidence), never a low score. Base weights: champion `weights_snapshot` → risk-profile static → `learning_priors`/`signal_weights` → default F.30/T.25/S.20/M.15/I.10.

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

**Fundamental** (`scoreFundamentals`) — base 50; ETF → flat 55; missing OVERVIEW → 55 (low-confidence). Additive:
| Field | Bands → points |
|---|---|
| P/E (sector-relative) | `ratio = pe / SECTOR_PE_NORM[sector]`. <0.7 → +18 · <1.0 → +8 · <1.4 → −3 · <2.0 → −12 · ≥2.0 → −22 |
| Profit margin | >0.20 → +20 · >0.10 → +10 · <0 → −20 |
| ROE (TTM) | >0.20 → +15 · >0.10 → +8 · <0 → −10 |
| EPS | >0 → +5 · ≤0 → −10 |
| Rev growth YoY | >0.20 → +15 · >0.10 → +8 · <0 → −10 |
| Analyst target upside `(target−price)/price` (price = live close, else 200-DMA) | >25% → +12 · >10% → +6 · <−10% → −8 |

`SECTOR_PE_NORM`: technology 30 · communication 20 · health care 25 · consumer disc. 24 · staples 22 · industrials 20 · materials 16 · energy 12 · financials 14 · utilities 18 · real estate 30 · unknown → 20.

**Technical** (`scoreTechnicals`) — base 50; <15 candles → flat 50. Additive:
| Signal | Contribution |
|---|---|
| RSI(14) | continuous interp over anchors `(20,−20)(35,−16)(45,−5)(50,+2)(55,+12)(60,+25)(72,+25)(75,+6)(85,−10)(100,−15)` |
| Price vs EMA50 | above +15 · below −15 |
| Price vs EMA20 | above +10 · below −10 |
| 20-day trend (±3% band) | up +10 · down −10 |
| Volume vs 20d avg (direction-confirming) | in-direction ≥1.5× → ±8 · ≥1.2× → ±4 (direction from EMA20/trend; neutral context → 0) |

**Breakdown veto** (`detectBreakdownVeto`, runs FIRST) — before the additive math, a deterministic crash/meme-reversal check caps the technical score at 20: last bar down ≥2.5 ATR, or ≤−7% on ≥1.5× volume, or a bottom-quartile close on a down bar. Fixes the case where a −12% high-volume reversal scored ~100 (RSI fell into the preferred band while price stayed above the EMAs). Uses new `computeATR14` + last-bar diagnostics on `TechnicalResult`.

**Sentiment** (`scoreSentiment`) — bullish fraction Bayesian-shrunk toward neutral by real `stocktwits_message_count` (prior K=10): `(bullFrac·N + 0.5·K)/(N + K)`, so 1 bullish message → 55 not 100, 500 msgs @90% → 89. Falls back to AV news `(sent+1)×50`; else label (bull 65 / bear 35); else 50. Excluded from weighting unless `has_data`.

**Macro** (`fetchMacroScore`) — **US symbols only** (India → UNAVAILABLE, excluded, weights renormalize). `100 − danger_score` from the newest `macro_regime` row that satisfies the full consumer contract above: real verdict (`regime != 'unknown'`) **and** `week_of` within `MAX_MACRO_AGE_DAYS` = 10 **and** `raw_indicators` length >= 3. Nothing qualifies → UNAVAILABLE, never a calm default. (Corrected 2026-07-17: this line previously said "looks back up to 3 weeks", contradicting the 10-day bound documented in the consumer-contract table in this same chapter — the unbounded reach-back was the 2026-07-13 prod bug, not the intended behavior.)

**Insider** (`resolveInsider` → Massive / EDGAR / AV) — `10 + buyRatio×80` where `buyRatio = buyValue/(buyValue+sellValue)` over 90 days, counting only open-market P/S codes (awards `A`, exercises `M`, gifts `G`, tax-withholding `F` are `other` and excluded — they are not conviction trades). Requires ≥3 transactions; <3, no data, ADRs, or fetch-fail → `available:false` (excluded).

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
**LLM:** DeepSeek `deepseek-chat`

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

**Risk gates (added 2026-07-09):**
- **Latched controls:** both pause and trading-enabled controls are checked per market; a recovered kill-switch metric cannot silently re-enable entries
- **Name cap:** `trading_mandates.max_open_positions` per market (default 10), enforced again from the canonical DB value inside the row-locked fill RPC. It gates new names only and never liquidates an over-cap book.
- **Re-entry cooldown:** 5-calendar-day block after a position in a symbol closes
- **Pyramid gate:** New BUY only if fill price > existing avg_cost (no averaging down)
- **Long-only for new positions:** SELL signals only apply to symbols already held

**Capital-rotation shadow (added 2026-07-13):** When a candidate reaches the execution branch and is rejected for `insufficient_cash`, PaperTrader calls the deterministic rotation evaluator and writes one `rotation_events` row with the would-be source holding, edge, notional, and gate reasons. This is P0 measurement only: it does not sell, buy, create a proposal, or move cash. Paper rotation execution and live rotation proposals remain disabled/unbuilt behind `rotation_config`.

**Outputs:**
- `paper_positions` row (new open position)
- `paper_trades` row (buy leg)
- `paper_order_events` row (submitted + filled events)
- Updates `paper_portfolio.cash` and `paper_portfolio.nav`
- `rotation_events` row only when `insufficient_cash` triggers a shadow rotation evaluation

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
     breakeven on remainder; full close only when qty < 2)
   - **Score/direction exit:** the latest same-market `deterministic_v1` signal must be no older than `trading_mandates.max_signal_age_sessions` (default 2). A stale/unavailable score can never close a position; price, stop, target, time-stop, and hedge exits remain active. Legacy score flags are revalidated and cleared when stale or no longer below the exit threshold.
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
**Schedule:** Sundays 8:00 PM ET
**LLM:** Claude Sonnet 4.6 (`claude-smart`)

**Inputs:** Alpha Vantage NEWS_SENTIMENT by sector.

**Key behavior:** Identifies emerging themes (e.g. `ai_infrastructure`, `clean_energy`). Adds
relevant symbols to `watchlist` tagged by theme. Prevents the watchlist from going stale and
introduces thematic discovery alongside the screener buckets.

**Outputs:** New `watchlist` rows tagged with `theme_tag` and `added_by = 'theme-scout'`

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
- **AI Coach** (`/api/agents/mentor-coach`, `mentor`→deepseek-reasoner) — a TRUE tool-using
  agent loop (`runAgentLoop`, ≤10 steps, tools: query_behavior/learning_progress/market_context
  /read_principles).
- **Ask the Agent** (`/api/mentor/ask`, `mentor-ask`→deepseek-chat) — UPGRADED from a fixed
  recent-rows snapshot to a tool-using retrieval agent (`runAgentLoop`, ≤8 steps): tools
  lookup_symbol / recent_activity / list_open_positions / worst_and_best_trades → answers on
  the EXACT data the question needs (targeted, not a generic LLM guess). SSE-streams the final
  answer word-by-word after the loop; emits meta as the first + last stream event.
- **Judgment Coach** (`/api/mentor/evaluate`, `mentor-evaluate`→deepseek-reasoner) and **Market
  Thesis** (`/api/mentor/thesis`, `mentor-thesis`→deepseek-reasoner) — single grounded
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
**LLM:** Claude Haiku 4.5 (`claude-fast`) for editor's note

**Inputs:** Latest signals, open positions, NAV, macro regime, open System Health alerts.

**Key behavior:** Generates morning and evening briefing emails. Morning: pre-market outlook.
Evening: trade recap. Sends via Resend (or configured EMAIL_PROVIDER). Includes "Open Issues"
band when System Health alerts are present.

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
