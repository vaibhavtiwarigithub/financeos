# Kairos Scripts

PowerShell scripts for running Kairos agents via Windows Task Scheduler.

## Files

| File | Purpose |
|------|---------|
| `run-agents.ps1` | Generic runner â€” call any agent by name via HTTP |
| `setup-tasks.ps1` | Registers all tasks in Windows Task Scheduler (requires Admin) |
| `logs/` | Per-agent, per-day log files written by the runner |

---

## Quick Start

### 1. Make sure the app is running

The scripts call `http://localhost:3000`. The Next.js dev server (or production build) must be running when a task fires.

```powershell
cd C:\...\Kairos
npm run dev
```

### 2. Register the scheduled tasks (one-time, run as Administrator)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
```

Verify registration:

```powershell
Get-ScheduledTask -TaskName "Kairos-*" | Select TaskName, State
```

### 3. Test a task manually

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-agents.ps1 -Agent research
```

---

## Scheduled Tasks

| Task Name | Agent | Schedule |
|-----------|-------|----------|
| `Kairos-BriefMorning` | `brief-morning` | Weekdays 8:55 AM |
| `Kairos-Research` | `research` | Weekdays 9:30 AM |
| `Kairos-PositionMonitor` | `position-monitor` | Weekdays 4:15 PM |
| `Kairos-NavSnapshot` | `nav-snapshot` | Weekdays 4:30 PM |
| `Kairos-BriefEvening` | `brief-evening` | Weekdays 4:45 PM |
| `Kairos-StaleCheck` | `stale-check` | Daily 6:00 PM |
| `Kairos-Learner` | `learner` | Sundays 8:00 PM |

---

## Agent Reference

| Agent key | HTTP call | What it does |
|-----------|-----------|--------------|
| `research` | `POST /api/agents/research/cron` | Runs ResearchAgent â€” scores watchlist, writes signals |
| `learner` | `POST /api/agents/learner` | Closes paper trades, updates weights (weekly batch) |
| `brief-morning` | `POST /api/briefing/generate` (`session: morning`) | Generates morning market briefing |
| `brief-evening` | `POST /api/briefing/generate` (`session: evening`) | Generates end-of-day briefing |
| `position-monitor` | `POST /api/agents/position-monitor` | Checks open positions, sends alerts if needed |
| `nav-snapshot` | `POST /api/agents/performance` (`action: snapshot`) | Takes a NAV/portfolio snapshot for charting |
| `stale-check` | `GET /api/alerts/stale-check` | Flags agents that haven't run recently |

The `research` endpoint requires the `x-cron-secret` header (`fos-cron-k9x2m7p4-2026`), set automatically by `run-agents.ps1`.

---

## Logs

Each agent writes a daily log file:

```
scripts/logs/research-2026-06-29.log
scripts/logs/stale-check-2026-06-29.log
...
```

Format: `HH:mm:ss [agent] OK: <json response>` or `HH:mm:ss [agent] ERROR: <message>`

---

## Unregistering tasks

```powershell
Get-ScheduledTask -TaskName "Kairos-*" | Unregister-ScheduledTask -Confirm:$false
```
