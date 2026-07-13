# Kairos — Crons & Scheduling
> Last updated: 2026-07-11 (added pg_cron Daily Per-Holding Risk jobs — migration 156)
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
| `kairos-validation-sweep` | Fridays 21:45 UTC | `POST /api/validation/sweep` | **Automated strategy validation (migration 170)** recovery sweep: for each market, validates up to 5 never-validated challengers (`state='challenger'`, `validation_experiment_id IS NULL`) through the deterministic Validation Engine, and — when the per-market `strategy_validation_automation` policy allows — auto-routes a PASSED challenger into the single `shadow_paper` slot via the `activate_strategy_shadow` RPC. Catches challengers created outside LearnerAgent or interrupted before in-process validation. Runs 45 min after the Friday learner. Self-reports to **System Health** (`reportIssue`/`resolveIssue`, key `cron-failed:kairos-validation-sweep`) on any execution error, clears on a clean run — so this unattended weekly job isn't silently broken. **Cannot promote a champion or touch any paper/live execution path — `shadow_paper` is non-executing.** |

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
```
