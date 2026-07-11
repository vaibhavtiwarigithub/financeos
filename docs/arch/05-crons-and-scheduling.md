# Kairos — Crons & Scheduling
> Last updated: 2026-07-10
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
```
