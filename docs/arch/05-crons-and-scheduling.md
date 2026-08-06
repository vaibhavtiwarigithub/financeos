# Kairos — Crons & Scheduling
> Last updated: 2026-08-05 (Added weekday `kairos-event-maturation` at 16:10 UTC, jobid 116. Computes 1/5/21-session forward paths for the market event ledger into `market_event_outcomes`. Measure-only; no score, sizing, entry, exit, promotion or broker path reads it.)
> Previously: 2026-08-01 (Removed the obsolete `kairos-macro-read-india` cron. India has no domestic macro narrative until the market-local exogenous-risk observation layer has source-backed data; the route continues to refuse India before any LLM call or write.)
> Previously: 2026-07-31 (US research, paper-entry, and close-monitor slots are DST-safe market-local contracts: paired EDT/EST UTC invocations plus an exact route guard admit only one. Added daily post-close `kairos-india-news-shadow`; it is evidence-only and uses no scoring API key.)
> Previously: 2026-07-21 (PaperTrader is standalone-only: one in-session attempt per market, with US at 15:15 UTC and India at 04:10 UTC. Research no longer tail-calls it. The route independently refuses weekends, holidays, and outside-session execution.)
> Previously: 2026-07-19 (Per-market ResearchAgent catch-up now runs on supported market-closed days: weekends plus verified full NYSE/NSE equity holidays. Daily triggers self-skip on trading days, special sessions, and unsupported calendar years. Results remain `weekend_staged` under the legacy status name, `session_validated=false`, and never chain a trader.)
> Previously: 2026-07-17 (`kairos-price-cache-fill` now also backfills ~400d of sector-XL daily history — one paced, resumable provider call per symbol on the existing schedule. No new cron, no schema change.)
> Previously: 2026-07-15 (Codex audit: added the missing daily `kairos-earnings-pit-capture` at 02:10 UTC; moved `kairos-india-markets-fill-retry` from a colliding 10:45 slot to 10:35 UTC. India primary remains 10:15; symbol-profile backfill remains 11:40.)
> Update this file when: a new cron is added or removed, a schedule changes, or a new endpoint is wired to a cron.

**Adding a cron:**
- Cloud: add to `vercel.json` (hit deployed URL)
- Local: add to `scripts/run-agents.ps1` (Windows Task Scheduler; PC must be on)
- Update this file with the new entry

---

## Vercel crons (cloud, hit deployed URL)

Defined in `vercel.json`. Fire against the Vercel deployment URL regardless of local machine state.

| Endpoint | Schedule (UTC) | What it does |
|---|---|---|
| `/api/agents/evaluation/p1-gate/cron` | Sundays 02:00 UTC | Count closed evaluable trades per market; fire System Health info alert when ≥ 20 |
| `/api/agents/autonomous-live/cron?market=us` | Weekdays 15:00 UTC (~10–11 AM ET, in US session) | Per-market run: 9-gate kernel + fresh kill-switch + session-window guard + per-market USD NAV + Kelly; submit live US orders via Robinhood REST; no-op when `AUTONOMOUS_LIVE_ENABLED=false`, market not autonomous, or session closed |
| `/api/agents/autonomous-live/cron?market=india` | Weekdays 06:00 UTC (11:30 AM IST, in NSE session) | Same, India: INR NAV from Kite margins+holdings; Kite REST |
| `/api/agents/live-exit-monitor/cron` | Every 30 min, 13:00–20:00 UTC weekdays (US session) | Protective exits for LIVE positions: reconstructs open live positions from filled broker_orders; SELLs via the gateway on stop (−8%) / target (+20%) / time (15d). No-op unless live-auto armed |
| `/api/agents/db-cleanup` | 1st of month 03:00 UTC | Prune 15 safe tables (llm_call_log >90d, agent_runs >60d, etc.); never touches ledgers |

---

## Windows Task Scheduler (local machine, ET)

All triggered by `scripts/run-agents.ps1 -Agent <name>`. PC must be on for these to fire.

| Task name | Schedule (ET) | Endpoint | Notes |
|---|---|---|---|
| `brief-morning` | Weekdays 8:00 AM | `/api/briefing/generate` | Morning email before market open |
| `research` | Weekdays 9:00 AM | `/api/agents/research/cron?market=us` | US signal generation (3 candidates/day) |
| `paper-trade-us` | Legacy local task; disable when pg_cron is active | `/api/agents/paper-trade?market=us` | Route is session-gated; production authority is pg_cron |
| `trader` | Weekdays 9:45 AM | `/api/agents/trader` | TraderAgent proposals; `approval_required=true` |
| `scan-india-refresh` | Weekdays 5:30 AM | `/api/scan/india/refresh` | Refresh up to 600 NSE equities oldest-first; scanner reports fresh/stale rotating coverage |
| `research-india` | Weekdays 6:15 AM | `/api/agents/research/cron?market=india` | India signal generation post-NSE-close |
| `paper-trade-india` | Legacy local task; disable when pg_cron is active | `/api/agents/paper-trade?market=india` | Route is session-gated; production authority is pg_cron |
| `position-monitor` | Weekdays 4:15 PM | `/api/agents/position-monitor?market=us` | US stop/target/time-stop/partial-profit checks |
| `position-monitor-india` | Weekdays 6:35 AM | `/api/agents/position-monitor?market=india` | India position exits |
| `brief-evening` | Weekdays 4:30 PM | `/api/briefing/generate` | Evening email recap |
| `nav-snapshot` | Weekdays 5:00 PM | `/api/agents/performance` | Daily NAV + alpha snapshot |
| `learner` | Fridays 5:00 PM | `/api/agents/learner` | Weekly weight learning; route skips non-Fridays |
| `macro-sentinel` | Mondays 8:00 AM | `/api/agents/macro-sentinel` | Weekly macro regime computation |
| `policy-events` | Weekdays 23:00 UTC | `/api/agents/policy-events` | US-only FOMC schedule/outcome sync plus record-only 1D/5D impact capture from frozen return evidence; no expectation source, scoring, or execution effect |
| `macro-read-us` | Weekdays 9:30 AM ET (13:30 UTC) | `/api/agent-mind/macro-read?market=us` | Agent Mind Phase 3: cached daily plain-English "what the macro backdrop means for your book" (US). Advisory/narrative only — never trades or sizes |
| `theme-scout` | Sundays 8:00 PM ET | `/api/agents/theme-scout` | Weekly, discovery-only watchlist additions; independent of ResearchAgent |
| `stale-check` | Every 4h | `/api/alerts/stale-check` | Alert if agent runs are stale |
| `live-snapshot` | Weekdays (manual / Task Scheduler) | `scripts/sync_robin.py` | Python script — pulls Robinhood positions into `live_account_snapshots` |
| `live-account-refresh` | On demand / Task Scheduler (`robinhood_mcp` source) | `POST /api/live-account/refresh-snapshot` | Deterministic MCP capture of all Robinhood accounts → upserts `live_account_snapshots` AND accrues one `live_performance` row/account/day (real equity + VOO close) — the forward-built source for the Live-vs-VOO chart (RH has no account-value history to backfill) |

---

## Postgres pg_cron (in-database, fire against deployed URL)

Scheduled inside Supabase via `cron.schedule`, calling the deployed app through the
`kairos_call_agent(endpoint, body, method, timeout_ms)` helper. Independent of local machine state.

| Job | Schedule (UTC) | Calls | What it does |
|---|---|---|---|
| `kairos-dimension-diagnostics-us` | Weekdays 23:20 UTC | `POST /api/agents/dimension-diagnostics?market=us` | P0 post-label diagnostic. Reads immutable decision/label evidence only; writes append-only market-local findings about availability, descriptive factor behavior and agent contribution. It makes no provider/LLM call and cannot change an agent, score, strategy, trade, exit, sizing or broker action. |
| `kairos-dimension-diagnostics-india` | Weekdays 23:25 UTC | `POST /api/agents/dimension-diagnostics?market=india` | Same P0 contract, separately for India. USD/US evidence is never read as India evidence. |
| `kairos-research` | Weekdays 13:00+14:00 UTC; only 09:00 ET admitted | `POST /api/agents/research/cron?market=us&local_slot=09%3A00` | Paired seasonal invocations keep the research contract at 09:00 New York time. The nonmatching invocation exits before provider/DB work. Daily technical scoring filters out the current session until 16:00 ET. |
| `kairos-paper-trade-us` | Weekdays 15:15+16:15 UTC; only 11:15 ET admitted | `POST /api/agents/paper-trade?market=us&local_slot=11%3A15` | The scheduled US paper-entry attempt stays at 11:15 ET across DST and independently enforces the NYSE session/calendar. |
| `kairos-paper-trade-india` | Weekdays 04:10 UTC (09:40 IST) | `POST /api/agents/paper-trade?market=india` | Morning India paper-entry attempt, after research starts and inside NSE hours. |
| `kairos-research-us-pm` | Weekdays 18:00+19:00 UTC; only 14:00 ET admitted | `POST /api/agents/research/cron?market=us&local_slot=14%3A00` | Afternoon rescore at a stable 14:00 ET. Daily factors still use the last completed session; live quotes remain execution inputs, not partial daily technical bars. |
| `kairos-paper-trade-us-pm` | Weekdays 19:15+20:15 UTC; only 15:15 ET admitted | `POST /api/agents/paper-trade?market=us&local_slot=15%3A15` | Afternoon US paper-entry/rotation attempt at a stable 15:15 ET. |
| `kairos-research-discovery-us` | Weekdays 14:30 UTC | `POST /api/agents/research/cron?market=us&scope=discovery` | Discovery-only research on its own budget. Takes ONLY never-held discovery buckets (screener, edge relative-strength, metals, region ETFs); holdings are excluded outright so it cannot touch an exit/SELL path. Exists because gatherSymbols orders candidates holdings → watchlist → screener and the wall-clock budget cuts from the tail, so screener candidates sat permanently at the back and were never scored — zero screener-sourced decisions across all of 2026-07. Runs after the 13:00 main run on a warm cache. |
| `kairos-research-discovery-india` | Weekdays 05:00 UTC | `POST /api/agents/research/cron?market=india&scope=discovery` | Same contract for India, after the 04:00 main run. |
| `kairos-event-maturation` | Weekdays 16:10 UTC | `POST /api/agents/event-maturation` | Matures recorded market events into 1/5/21-session forward paths. Daily rather than weekly even though events arrive roughly monthly: the job is idempotent and costs ~2s for the whole ledger, while a weekly tick could leave a freshly elapsed 21-session horizon unmatured for up to 7 days — long enough for a base-rate read to under-count its own n. 16:10 UTC sits after the referenced US session settles and clear of the 13:25/13:45 price-cache ticks and the 14:00 briefing. Weekdays only: no session elapses at a weekend. Measure-only. |
| `kairos-screener-contract` | Weekdays 11:10 UTC | `POST /api/validation/screener-contract` | Re-probes every Yahoo screener criterion with a threshold no security can satisfy and confirms the count collapses. Raises `screener-field-degraded:<field>` at critical when a criterion is accepted but discarded — a failure that produces no error and would otherwise widen a bucket silently. Runs ahead of the US research window so a degraded field is known before discovery uses it. |
| `kairos-position-monitor` | Weekdays 20:15+21:15 UTC; only 16:15 ET admitted | `POST /api/agents/position-monitor?market=us&local_slot=16%3A15` | US daily score/stop/target/time checks remain after the regular close in both EDT and EST. The seasonal duplicate exits before monitor work. |
| `kairos-research-india-mid` | Weekdays 07:00 UTC (12:30 IST) | `POST /api/agents/research/cron?market=india` | Midday India research cycle — same intraday-adaptation rationale as the US PM run. |
| `kairos-paper-trade-india-mid` | Weekdays 07:45 UTC (13:15 IST) | `POST /api/agents/paper-trade?market=india` | Midday India paper-entry/rotation attempt inside NSE hours. |
| `kairos-holding-risk-us` | Weekdays 21:30 UTC (17:30 ET) | `POST /api/agents/holding-risk?market=us` | Daily Per-Holding Risk: scores every US live-account holding (deterministic score + posture, LLM prose note only). Fires after the 16:00 ET close **and** after `nav-snapshot` refreshes the account book at 21:00 UTC. 290s timeout. **Advisory-only — touches no order path.** |
| `kairos-holding-risk-india` | Weekdays 11:00 UTC (16:30 IST) | `POST /api/agents/holding-risk?market=india` | Same, India (Kite): fires after the 15:30 IST close. 290s timeout. Advisory-only. |
| `kairos-live-snapshot` | Weekdays 13:00–21:00 UTC every 2h | `POST /api/live-account/refresh-snapshot` | Refreshes the live account book for every CONNECTED cloud MCP broker (Robinhood + Webull via the registry driver `captureAccounts`) → `live_account_snapshots` + `live_performance` (US, `market='us'`, VOO bench). Cloud-native (OAuth vault token, no local machine). Auto-ADDs newly-returned accounts. Auto-pruning is broker-scoped and fail-safe: it runs only after that broker returns at least one valid account, deletes only rows for that broker not in the successful capture set, and never runs on failed/empty capture, so a broker outage cannot mass-delete another broker or wipe the kill-switch baseline. **India (Kite) accrual (`refreshKite`)** runs in the same call, fully independent + fail-soft: NAV = Kite `margins.equity.net` + Σ(last_price×qty), bench = ^NSEI close, written as ONE `live_performance` row (`market='india'`, `broker='kite'`, `currency='INR'`, `account_id`=Kite `user_id`). It writes **only** `live_performance`, never `live_account_snapshots`, so the Kite account can never leak into the US account chips or the US kill-switch NAV baseline; a stale Kite daily token just skips the day. This is the forward-built source for the India Live-vs-NIFTY chart (`/api/live-portfolio/performance?market=india`, which falls back to the paper India NIFTY curve until ≥2 live Kite days exist). |
| `kairos-prewarm-us` | **7-day** every 5 min in the 12:00 UTC hour (12 ticks before 13:00 US research; migration 20260714070000) | `POST /api/agents/prewarm?market=us` | **Evidence-cache prewarmer.** Warms `av_cache` with each US symbol's fundamentals/sentiment/insider evidence AHEAD of scoring so a cold-start run gets cache hits instead of bursting Massive (5/min) / GDELT (1/5s) past their walls mid-run. BOUNDED (45s wall-clock) + RESUMABLE — each tick warms until the budget then returns `{warmed, remaining}`; the pacing lease + av_cache dedupe drain the universe across ticks (warm symbols are instant cache hits, so ticks advance to the cold tail). Warm-only: no scoring, no signal/packet writes, **no order path**. |
| `kairos-prewarm-india` | **7-day** every 10 min in the **03:00 UTC hour** (before the 04:00 India research) | `POST /api/agents/prewarm?market=india` | Warms active India fundamentals only. The retired GDELT India scoring path is no longer called; replacement news collection has its own post-close shadow. |
| `kairos-india-news-shadow` | Daily 12:15 UTC (17:45 IST) | `POST /api/agents/india-news-shadow` | Bounded holdings-first NSE corporate-announcement + Google News RSS collection into `evidence_cache_v2` and `provider_call_ledger`. Runs on weekends/holidays because events are not exchange-session-bound. No score, signal, paper/live trade, learner mutation, or broker reader. |
| `kairos-evidence-shadow-us` | **7-day** 14:20/35/50 UTC (after US research) | `POST /api/agents/evidence-shadow?market=us` | **Canonical Evidence Router dual-run shadow** (migration 20260714060000). **Weekend self-skip** (both prewarm + shadow): on Sat/Sun the route no-ops when the per-market `research_queue` backlog is <10, so idle weekend quota is used only when there's real backlog to drain; weekdays always run. Resolves the router-covered intents (fundamentals/analyst/insider/daily-bars) over the per-market universe = `watchlist` ∪ `research_queue` (unioned so India — whose rotation universe lives in `research_queue`, not the us/US-only `watchlist` — actually accumulates evidence; before this the India branch always resolved an empty universe), logging every attempt to `provider_call_ledger` + `evidence_cache_v2`. `router_enabled=false` → observational only, NEVER scored/traded. Bounded 45s + resumable (fresh cache short-circuits); 3 ticks drain the universe. Decoupled from the research hot path so it can't slow the 50-symbol run. Accumulates the coverage/disagreement evidence the Phase-4 cutover is gated on. |
| `kairos-evidence-shadow-india` | **7-day** 04:30/40/50 UTC (after India research) | `POST /api/agents/evidence-shadow?market=india` | Same, India. |
| `kairos-evidence-cohort-us` | Daily 15:05 UTC (after final US shadow tick) | `POST /api/agents/evidence-cohort?market=us&limit=50` | Cache-only cutover evidence. Replays frozen ResearchAgent score inputs, writes immutable safety/quality parity results, deduplicates unchanged cohort fingerprints, and consumes no external-provider quota. Measurement only; cannot activate a policy. |
| `kairos-evidence-cohort-india` | Daily 05:05 UTC (after final India shadow tick) | `POST /api/agents/evidence-cohort?market=india&limit=50` | Same, India/INR. Only session-validated ResearchAgent rows supply `as_of_session`, so weekend/holiday staged runs cannot increase the ten-session cutover count; missing Router bars are recorded as failed coverage rather than crashing the evaluator. |
| `kairos-closed-day-research-us` | Daily 15:10 UTC; route permits only supported weekends/full NYSE holidays | `POST /api/agents/research/cron?market=us&mode=closed_day_catchup` | Scores only US carry-forward queue symbols not already staged for the same completed session. Trading days, special sessions, and unsupported calendar years self-skip. Writes non-executable staged signals; leaves candidates queued for next-session revalidation; never chains a trader. |
| `kairos-closed-day-research-india` | Daily 05:10 UTC; route permits only supported weekends/full NSE CM holidays | `POST /api/agents/research/cron?market=india&mode=closed_day_catchup` | India-equivalent catch-up, independently scoped in INR/NSE symbol space. Uses the NSE Capital Market calendar, not settlement/derivatives calendars; Muhurat special sessions abstain. Same non-executable lifecycle. |
| `kairos-earnings-pit-capture` | **Daily** 02:10 UTC | `POST /api/calendar/earnings/refresh` | Captures changing US pre-report consensus vintages and the first provider actual observed after release. Conservative PIT rule rejects consensus captured on/after the US report date. Data-capture only; no score/order consumer. |
| `kairos-earnings-risk-monitor-us` | Weekdays 16:00 UTC (12:00 EDT / 11:00 EST) | `POST /api/agents/earnings-risk-monitor` | Bounded US holdings-only earnings/options shadow. Runs after PaperTrader and outside the 14:00-15:15 provider cluster, so same-day new positions are included without competing with evidence cohorts. Reads open paper positions and the latest complete per-account live-risk snapshots, merges the PIT cache with one Robinhood calendar call, requests per-symbol/options evidence only for an event inside the holding horizon, and appends `behavior_changed=false` evidence. It never scores, sizes, enters, exits, or calls India options. |
| `kairos-india-markets-fill` (+ `-retry`) | Weekdays 10:15 + 10:35 UTC | `POST /api/markets/india` | Post-close display snapshot for India indices, sectors, and versioned NIFTY-50 breadth. One deduplicated, paced provider stream; GET is cache-only. Retry moved from 10:45 because that slot is used by `kairos-scan-india-refresh`. |
| `kairos-broker-keepwarm` | **Daily** 06:00 + 18:00 UTC (7 days/week, migration 20260714000000) | `POST /api/broker-mcp/keepwarm` | **MCP token keep-warm.** Iterates every connected MCP broker and calls `getValidAccessToken`, which refreshes + CAS-rotates the refresh token when the short-lived access token (Webull ~1 day) is expiring. Insurance so the OAuth refresh chain never lapses across weekends/holidays when the weekday-only market crons (`broker-sync`, `research`) don't touch it. Read-only — no tool calls, **no order path**. A refresh failure raises a critical System Health issue (`broker-token:<broker>`) for reconnect. |
| `kairos-validation-sweep` | Fridays 21:45 UTC | `POST /api/validation/sweep` | **Automated strategy validation (migration 170)** recovery sweep: for each market, validates up to 5 never-validated challengers (`state='challenger'`, `validation_experiment_id IS NULL`) through the deterministic Validation Engine, and — when the per-market `strategy_validation_automation` policy allows — auto-routes a PASSED challenger into the single `shadow_paper` slot via the `activate_strategy_shadow` RPC. Catches challengers created outside LearnerAgent or interrupted before in-process validation. Runs 45 min after the Friday learner. Self-reports to **System Health** (`reportIssue`/`resolveIssue`, key `cron-failed:kairos-validation-sweep`) on any execution error, clears on a clean run. Also writes an `agent_runs` heartbeat (`agent_type='validation_sweep'`, market `us`) so **`stale-check`** flags a SILENT non-run — registered as a Friday-only job (expected 21:00 UTC, 2h grace). So both failure modes are covered: errored-when-run and never-fired. **Cannot promote a champion or touch any paper/live execution path — `shadow_paper` is non-executing.** |
| `kairos-price-cache-fill` (+ `-retry`) | Weekdays 13:25 + 13:45 UTC (pre-market, before the 14:00 briefing; migration 20260715140000) | `POST /api/agents/price-cache-fill` | **Markets display price-cache fill.** Pre-fills `price_cache` with the whole Markets ETF universe (regime proxies SPY/QQQ/IWM/TLT/IEF/HYG/UUP/GLD + VIXY/DIA, the 11 sector XLs, and the leveraged sentiment pairs TQQQ/SQQQ/… ) via ONE Massive **grouped-daily** call (all US tickers in a single request, filtered to the universe) — so the Markets tiles (`markets/synthesis`, `markets/quotes`, `charts/sector-returns`) read a warm cache instead of each bursting Massive's ~5/min free tier on page load.

> **`markets/overview` is deliberately NOT a `price_cache` reader (corrected 2026-07-17).**
> This chapter previously listed it here and asserted it read the warm cache. It never
> did, and it should not — the claim was wrong, not the code. Verified against prod
> (`dionkikgdmlaotvtbnfr`) on 2026-07-17:
> 1. **The cache cannot cover the tile.** The overview needs all 15 symbols (SPY/QQQ/DIA/VIXY
>    + 11 XLs) **on one session**. `QQQ`, `DIA` and `VIXY` hold **2 bars each** (07-14, 07-15) —
>    the daily fill only began covering them on 07-14 and the 400d backfill is sector-XL-only.
>    Only **two** fully-aligned 15/15 sessions exist in the entire table.
> 2. **The head of the cache is ragged.** On 07-17 the newest bar per symbol was 07-16 for
>    SPY and XLV but 07-15 for the other 13. A "latest bar per symbol" read would therefore
>    render SPY's 07-16 close beside XLK's 07-15 close as one snapshot — reintroducing the
>    cross-session mix the grouped rewrite exists to prevent.
> 3. **The cache is a full session STALER.** Requiring honest 15/15 alignment resolves to
>    07-15, while grouped serves 07-16. Cache-first would trade freshness for nothing.
> 4. **The rate-limit argument no longer applies.** It was written when the route fired 15
>    per-symbol `/prev` calls against a ~5/min ceiling. The route now spends 2–3 grouped
>    calls, each `revalidate: 3600` (past sessions are immutable) behind a 5-min route memo —
>    ~2 calls/**hour**, ≈0.7% of budget. The premise was overtaken by the rewrite.
>
> A cache **fallback** on provider error was also considered and rejected: `price_cache` is
> filled from the *same provider's same endpoint*, so an outage that breaks the route
> correlates with a stalled fill — it would fall back to a staler copy of the same failure,
> while adding a DB dependency to a route that has none. The degraded payload + Retry is honest.
>
> The tile's contract: every symbol on ONE session, labelled with `sessionDate` /
> `priorCloseDate`, unresolved symbols as `n/a` — **never 0.00%**, never "today" for a prior
> session. Pinned by `tests/markets-overview.test.ts`. Late, never wrong. The prev-session close is stable all day, so one fill/day is enough; the 13:45 tick is an idempotent no-op once 13:25 has filled (skips when the most-recent session is already cached). Falls back to sequential per-symbol `/prev` (lease-gated 5/min, bounded 45s, resumable) only if the grouped endpoint is unavailable. Raises a System Health `warn` (`price-cache-fill-degraded`, auto-clears at UTC midnight) only on a large shortfall. **Display data only — never on the money/scoring path.**<br><br>**Sector history backfill (2026-07-17).** The same tick also backfills ~400 calendar days of daily bars for the 11 sector XLs, because `charts/sector-returns` offers 1W/1M/3M/6M/1Y windows and the daily fill alone only ever accumulates one session per tick — with two cached sessions every window collapsed onto the same two bars and reported a one-day move as a "1Y return". Uses `/v2/aggs/ticker/{sym}/range/1/day/{from}/{to}`, which returns the FULL series in ONE request, so the whole 11-ETF backfill costs **11 provider calls total** (not 11 × 400). Each call takes the shared `try_acquire_provider_slot` lease (12.5s = 5/min), is wall-clock bounded, and is **resumable** — a tick drains what fits (~1-3 symbols), skips symbols that already have depth, and later ticks finish the rest; once drained it is a permanent no-op. Runs **before** the per-symbol fallback deliberately: on a grouped-endpoint failure the fallback would otherwise consume the whole budget and starve the backfill indefinitely. Going first costs the daily fill nothing for these symbols — the range call spans up to the most recent session, so a backfilled sector is daily-filled by the same request. No new cron and no schema change: it rides the existing schedule. |
| `kairos-benchmark-scorecard` | Weekdays 22:15 UTC | `POST /api/agents/benchmark-scorecard` | **Benchmark Alpha P1 (migration 20260713143000)** rolls up paper/live scorecard rows for 1W/1M/3M/YTD/1Y after NAV + labels. Writes `benchmark_scorecard` status rows, including missing/unpriceable rows. Measurement-only: no learner mutation, no paper fills, no live orders. |
| `kairos-downside-hedge-us` | Weekdays 21:10 UTC | `POST /api/agents/downside-hedge` | Deterministic US paper hedge evaluation. Default OFF; shadow logging and paper execution have separate flags. No live path. |
| `kairos-edge-scout-us` | Weekdays 22:30 UTC | `POST /api/agents/edge-scout?market=us&universe=liquid&maxSymbols=50` | Post-close bounded factor snapshot. The route rotates 50-name pages through the current liquid US universe; fresh relative-strength rows may admit up to four provenance-only ResearchAgent candidates, but never alter score, sizing, exits, or order gates. |
| `kairos-edge-scout-india` | Weekdays 11:30 UTC | `POST /api/agents/edge-scout?market=india&maxSymbols=50` | India post-close equivalent. Never cross-sums or updates US lifecycle state. |
| `kairos-edge-ic-us` / `-india` | Mondays 02:00 / 03:00 UTC | `POST /api/agents/edge-ic?...` | Weekly bounded retrospective IC diagnostic. Explicitly current-universe/survivorship-biased; cannot promote, score, size, or trade. |
| `kairos-edge-readiness` | Daily 03:20 UTC | `POST /api/agents/edge-readiness` | Reads cached IC history only, updates the measure-only readiness projection, emits one-time review milestones, and warns when collection is stale. No provider or trading call. |
| `kairos-international-allocation-shadow` | Mondays 03:30 UTC | `POST /api/allocation/international/assess?mode=p2_weekly` | **P2A international-allocation operational shadow.** Appends one US/USD VXUS assessment per ISO week from persisted paper positions and the latest immutable policy snapshot. It records `action=none`, null costs/tax drag, coverage state, and input fingerprints while target/band remain unset. No provider call, candidate, paper/live position, order, broker, or India/INR read. |

The route fails closed (publishes a failed/insufficient-data run, never yesterday-as-today) when a broker
snapshot is missing/stale, so cron timing is a best-effort ordering, not a correctness dependency. **EDT/EST
caveat:** the US job is set for EDT (summer); shift it +1h at the November EST changeover. Both jobs are
re-scheduled idempotently (unschedule-first) by migration 156.

---

## Cron authentication

All cron-triggered routes verify the `x-cron-secret` request header using a timing-safe comparison (`verifyCronSecret()` in `lib/auth/cron.ts`). The secret is `CRON_SECRET` in env and Vercel environment variables.

Cron routes do NOT require an owner session — they accept the cron secret as an alternative. This means the secret must be kept private; anyone with it can invoke cron routes.

---

## Daily schedule overview (US trading day)

```
5:30 AM ET  — scan-india-refresh (NSE cache)
6:15 AM ET  — research-india
6:35 AM ET  — position-monitor-india
8:00 AM ET  — brief-morning + macro-sentinel (Mon only)
9:00 AM ET  — research (US)
9:25 AM ET  — price-cache-fill (Markets ETF cache; retry 9:45)
9:45 AM ET  — trader (US proposals)
10:15/11:15 AM ET — paper-trade-us (EST/EDT; fixed 15:15 UTC)
4:15 PM ET  — position-monitor (US)
4:30 PM ET  — brief-evening
5:00 PM ET  — nav-snapshot
5:00 PM ET  — learner (Fri only)
Every 4h    — stale-check (cloud, Vercel)
Sun 8 PM ET — theme-scout
2:00 PM UTC  — autonomous-live (cloud, Vercel, weekdays; after research+signals at 1 PM UTC)
Sun 2 AM UTC — p1-gate (cloud, Vercel)
1st of month 3 AM UTC — db-cleanup (cloud, Vercel)
11:00 AM UTC — holding-risk India (pg_cron, weekdays; after 15:30 IST close)
9:30 PM UTC  — holding-risk US (pg_cron, weekdays; after 16:00 ET close + nav-snapshot)
Fri 9:45 PM UTC — validation-sweep (pg_cron; recovers never-validated challengers, after learner)
9:10 PM UTC  — downside-hedge-us (pg_cron; US paper only, default OFF)
10:15 PM UTC — benchmark-scorecard (pg_cron; benchmark-alpha measurement only, after NAV + labels)
2:10 AM UTC  — earnings-pit-capture (daily; data capture only)
10:15/10:35 AM UTC — India Markets full snapshot + retry (weekdays; display only)
```

**Research capacity note (2026-07-17):** the US and India jobs both prioritize
stale holdings, but held rows no longer spend an LLM narrative call because the
decision is deterministic. One existing worker is reserved for candidates while
the others prioritize holdings, so discovery always advances without raising
concurrency. Candidate overflow retains its original defer time and
is bounded to six deferrals/seven days. Theme Scout's seven-day owner-scoped rows
and `watchlist.research_enabled` prevent disabled or month-old machine discoveries
from silently expanding the daily universe. Prewarm and evidence-shadow are Canonical
Evidence Router jobs, not GitHub/Vibe jobs; shadow remains observational and never
feeds scoring or orders, though its provider calls still obey the shared pacing layer.

**Order-maintenance correction (2026-07-26):** The every-30-minute maintenance trigger only sends stale-order cancellation during a US market session and processes one candidate. It independently reconciles one unknown order through a read-only broker status query; the owner can request that read-only reconciliation from Trading. The limits avoid overnight/weekend MCP churn and leave cold-start headroom.
