# Kairos — Crons & Scheduling
> Last updated: 2026-07-17 (Documented the two `macro-read` crons, which were missing from this table entirely. `macro-read-india` is now a **no-op** — the route refuses `market=india` — and is flagged for removal (not dropped here: a prod DB mutation). Also worth knowing for every cron on this page: **pg_cron `status='succeeded'` does NOT mean the agent ran** — it only means `net.http_post` was enqueued. `macro-read` failed silently for 4 days (2026-07-13 → 07-17) returning HTTP 200 `{ok:false}` while both crons logged "succeeded" and wrote nothing. Check `net._http_response` / the agent's own table, not `cron.job_run_details`, to prove a cron did work.; **Correction:** this chapter wrongly claimed `markets/overview` reads the warm `price_cache`. It never did, and — verified against prod — it must not: the cache lacks index-symbol coverage, is ragged at the head, and is a full session staler than the route's grouped call. The doc was wrong, not the code. See the `kairos-price-cache-fill` row.)
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
| `/api/agents/autonomous-shadow/cron` | Weekdays 07:30 UTC | Run execution kernel over qualifying signals; create shadow `trade_proposals` with Kelly sizing; no broker submission |
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
| `paper-trade-us` | Weekdays 10:05 AM | `/api/agents/paper-trade?market=us` | US paper fills (standalone, freshness-gated) |
| `trader` | Weekdays 9:45 AM | `/api/agents/trader` | TraderAgent proposals; `approval_required=true` |
| `scan-india-refresh` | Weekdays 5:30 AM | `/api/scan/india/refresh` | Cache full NSE equity list in oldest-first slices |
| `research-india` | Weekdays 6:15 AM | `/api/agents/research/cron?market=india` | India signal generation post-NSE-close |
| `paper-trade-india` | Weekdays 4:35 PM IST (≈6:05 AM ET) | `/api/agents/paper-trade?market=india` | India paper fills |
| `position-monitor` | Weekdays 4:15 PM | `/api/agents/position-monitor?market=us` | US stop/target/time-stop/partial-profit checks |
| `position-monitor-india` | Weekdays 6:35 AM | `/api/agents/position-monitor?market=india` | India position exits |
| `brief-evening` | Weekdays 4:30 PM | `/api/briefing/generate` | Evening email recap |
| `nav-snapshot` | Weekdays 5:00 PM | `/api/agents/performance` | Daily NAV + alpha snapshot |
| `learner` | Fridays 5:00 PM | `/api/agents/learner` | Weekly weight learning; route skips non-Fridays |
| `macro-sentinel` | Mondays 8:00 AM | `/api/agents/macro-sentinel` | Weekly macro regime computation |
| `macro-read-us` | Weekdays 9:30 AM ET (13:30 UTC) | `/api/agent-mind/macro-read?market=us` | Agent Mind Phase 3: cached daily plain-English "what the macro backdrop means for your book" (US). Advisory/narrative only — never trades or sizes |
| `macro-read-india` | Weekdays 10:00 AM IST (04:30 UTC) | `/api/agent-mind/macro-read?market=india` | **NO-OP — should be dropped.** The route refuses `market=india` before any LLM call or DB write (2026-07-17): both macro inputs (`macro_regime`, `category='macro'` `learning_priors`) are US-only and unmarket-tagged, so there is no honest India read to generate. Left active pending owner removal (dropping the `cron.job` row is a prod DB mutation); the route-level refusal makes it harmless — zero LLM spend, zero rows |
| `theme-scout` | Sundays 8:00 PM | `/api/agents/theme-scout` | Weekly watchlist theme additions |
| `stale-check` | Every 4h | `/api/alerts/stale-check` | Alert if agent runs are stale |
| `live-snapshot` | Weekdays (manual / Task Scheduler) | `scripts/sync_robin.py` | Python script — pulls Robinhood positions into `live_account_snapshots` |
| `live-account-refresh` | On demand / Task Scheduler (`robinhood_mcp` source) | `POST /api/live-account/refresh-snapshot` | Deterministic MCP capture of all Robinhood accounts → upserts `live_account_snapshots` AND accrues one `live_performance` row/account/day (real equity + VOO close) — the forward-built source for the Live-vs-VOO chart (RH has no account-value history to backfill) |

---

## Postgres pg_cron (in-database, fire against deployed URL)

Scheduled inside Supabase via `cron.schedule`, calling the deployed app through the
`kairos_call_agent(endpoint, body, method, timeout_ms)` helper. Independent of local machine state.

| Job | Schedule (UTC) | Calls | What it does |
|---|---|---|---|
| `kairos-holding-risk-us` | Weekdays 21:30 UTC (17:30 ET) | `POST /api/agents/holding-risk?market=us` | Daily Per-Holding Risk: scores every US live-account holding (deterministic score + posture, LLM prose note only). Fires after the 16:00 ET close **and** after `nav-snapshot` refreshes the account book at 21:00 UTC. 290s timeout. **Advisory-only — touches no order path.** |
| `kairos-holding-risk-india` | Weekdays 11:00 UTC (16:30 IST) | `POST /api/agents/holding-risk?market=india` | Same, India (Kite): fires after the 15:30 IST close. 290s timeout. Advisory-only. |
| `kairos-live-snapshot` | Weekdays 13:00–21:00 UTC every 2h | `POST /api/live-account/refresh-snapshot` | Refreshes the live account book for every CONNECTED cloud MCP broker (Robinhood + Webull via the registry driver `captureAccounts`) → `live_account_snapshots` + `live_performance` (US, `market='us'`, VOO bench). Cloud-native (OAuth vault token, no local machine). Auto-ADDs newly-returned accounts. Auto-pruning is broker-scoped and fail-safe: it runs only after that broker returns at least one valid account, deletes only rows for that broker not in the successful capture set, and never runs on failed/empty capture, so a broker outage cannot mass-delete another broker or wipe the kill-switch baseline. **India (Kite) accrual (`refreshKite`)** runs in the same call, fully independent + fail-soft: NAV = Kite `margins.equity.net` + Σ(last_price×qty), bench = ^NSEI close, written as ONE `live_performance` row (`market='india'`, `broker='kite'`, `currency='INR'`, `account_id`=Kite `user_id`). It writes **only** `live_performance`, never `live_account_snapshots`, so the Kite account can never leak into the US account chips or the US kill-switch NAV baseline; a stale Kite daily token just skips the day. This is the forward-built source for the India Live-vs-NIFTY chart (`/api/live-portfolio/performance?market=india`, which falls back to the paper India NIFTY curve until ≥2 live Kite days exist). |
| `kairos-prewarm-us` | **7-day** every 5 min in the 12:00 UTC hour (12 ticks before 13:00 US research; migration 20260714070000) | `POST /api/agents/prewarm?market=us` | **Evidence-cache prewarmer.** Warms `av_cache` with each US symbol's fundamentals/sentiment/insider evidence AHEAD of scoring so a cold-start run gets cache hits instead of bursting Massive (5/min) / GDELT (1/5s) past their walls mid-run. BOUNDED (45s wall-clock) + RESUMABLE — each tick warms until the budget then returns `{warmed, remaining}`; the pacing lease + av_cache dedupe drain the universe across ticks (warm symbols are instant cache hits, so ticks advance to the cold tail). Warm-only: no scoring, no signal/packet writes, **no order path**. |
| `kairos-prewarm-india` | **7-day** every 10 min in the **03:00 UTC hour** (before the 04:00 India research) | `POST /api/agents/prewarm?market=india` | Same, India (Yahoo fundamentals + GDELT sentiment). **Fixed 2026-07-14 (migration 20260714050000):** was in the 09:00 hour — i.e. 5h AFTER the 04:00 research run — so India research always cold-started and GDELT sentiment (1 req/5s) was paced out → recurring `data-availability:india:sentiment 0/8`. Moved ahead of research to mirror US. |
| `kairos-evidence-shadow-us` | **7-day** 14:20/35/50 UTC (after US research) | `POST /api/agents/evidence-shadow?market=us` | **Canonical Evidence Router dual-run shadow** (migration 20260714060000). **Weekend self-skip** (both prewarm + shadow): on Sat/Sun the route no-ops when the per-market `research_queue` backlog is <10, so idle weekend quota is used only when there's real backlog to drain; weekdays always run. Resolves the router-covered intents (fundamentals/analyst/insider/daily-bars) over the per-market universe = `watchlist` ∪ `research_queue` (unioned so India — whose rotation universe lives in `research_queue`, not the us/US-only `watchlist` — actually accumulates evidence; before this the India branch always resolved an empty universe), logging every attempt to `provider_call_ledger` + `evidence_cache_v2`. `router_enabled=false` → observational only, NEVER scored/traded. Bounded 45s + resumable (fresh cache short-circuits); 3 ticks drain the universe. Decoupled from the research hot path so it can't slow the 50-symbol run. Accumulates the coverage/disagreement evidence the Phase-4 cutover is gated on. |
| `kairos-evidence-shadow-india` | **7-day** 04:30/40/50 UTC (after India research) | `POST /api/agents/evidence-shadow?market=india` | Same, India. |
| `kairos-earnings-pit-capture` | **Daily** 02:10 UTC | `POST /api/calendar/earnings/refresh` | Captures changing US pre-report consensus vintages and the first provider actual observed after release. Conservative PIT rule rejects consensus captured on/after the US report date. Data-capture only; no score/order consumer. |
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
10:05 AM ET — paper-trade-us
4:15 PM ET  — position-monitor (US)
4:30 PM ET  — brief-evening
5:00 PM ET  — nav-snapshot
5:00 PM ET  — learner (Fri only)
Every 4h    — stale-check (cloud, Vercel)
Sun 8 PM ET — theme-scout
7:30 AM UTC  — autonomous-shadow (cloud, Vercel, weekdays)
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
