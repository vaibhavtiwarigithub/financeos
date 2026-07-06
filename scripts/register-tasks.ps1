# Kairos — Register Windows Task Scheduler tasks
# Run once as Administrator (or as the user who will run the app):
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1

$ScriptPath  = "$PSScriptRoot\run-agents.ps1"
$TaskFolder  = "Kairos"
$PSExe       = "powershell.exe"
$PSArgs      = "-NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`" -Agent"

# Weekday trigger helper
function WeekdayTrigger([string]$time) {
  $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $time
  return $t
}

# Friday-only trigger helper
function FridayTrigger([string]$time) {
  return New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At $time
}

$tasks = @(
  @{ Name="brief-morning";    Trigger=(WeekdayTrigger "8:00AM");  Agent="brief-morning"    },
  @{ Name="research";         Trigger=(WeekdayTrigger "9:00AM");  Agent="research"          },
  @{ Name="trader";           Trigger=(WeekdayTrigger "9:45AM");  Agent="trader"            },
  @{ Name="position-monitor"; Trigger=(WeekdayTrigger "4:15PM");  Agent="position-monitor" },
  # India market — must fire AFTER the 15:30 IST NSE close in BOTH US seasons.
  # 15:30 IST = 05:00 ET (EST, winter) / 06:00 ET (EDT, summer). Earlier times
  # (e.g. 5:30 AM EDT = 15:00 IST) would cache mid-session prices, so these are
  # set to ≥6:45 AM ET — post-close year-round. Runs only do work when
  # market_focus includes India; otherwise the routes skip (0 symbols).
  # NOTE: no NSE holiday calendar yet — on an Indian market holiday these still
  # fire but produce stale/no data (a future improvement is an NSE holiday gate).
  @{ Name="scan-india-refresh";     Trigger=(WeekdayTrigger "6:45AM");  Agent="scan-india-refresh"     },
  @{ Name="research-india";         Trigger=(WeekdayTrigger "7:00AM");  Agent="research-india"         },
  @{ Name="position-monitor-india"; Trigger=(WeekdayTrigger "7:15AM");  Agent="position-monitor-india" },
  @{ Name="brief-evening";    Trigger=(WeekdayTrigger "4:30PM");  Agent="brief-evening"    },
  @{ Name="nav-snapshot";     Trigger=(WeekdayTrigger "5:00PM");  Agent="nav-snapshot"     },
  @{ Name="rescore";          Trigger=(WeekdayTrigger "4:45PM");  Agent="rescore"           },
  @{ Name="embed";            Trigger=(WeekdayTrigger "4:50PM");  Agent="embed"             },
  # Phase 1 learning-core: nightly label maturation (after market data settles).
  @{ Name="label-maturation"; Trigger=(WeekdayTrigger "6:00PM");  Agent="label-maturation"  },
  @{ Name="learner";          Trigger=(FridayTrigger  "5:00PM");  Agent="learner"           },
  # Phase 2 learning-core: weekly calibrated-sizing refit, before the learner runs.
  @{ Name="fit-calibration";  Trigger=(FridayTrigger  "4:45PM");  Agent="fit-calibration"   },
  @{ Name="mentor-coach";     Trigger=(FridayTrigger  "5:15PM");  Agent="mentor-coach"      }
)

# Ensure task folder exists BEFORE any Register-ScheduledTask call (fresh machines
# have no \Kairos folder yet, and registering into a missing folder fails).
$sch = New-Object -ComObject Schedule.Service
$sch.Connect()
$root = $sch.GetFolder("\")
try { $root.GetFolder($TaskFolder) | Out-Null }
catch { $root.CreateFolder($TaskFolder) | Out-Null; Write-Host "Created folder \$TaskFolder" }

# Per-agent execution time limits (minutes). embed can run a large first backfill.
$timeLimits = @{ "embed" = 10; "learner" = 15; "scan-india-refresh" = 10; "label-maturation" = 10 }
function TimeLimitFor([string]$agent) {
  if ($timeLimits.ContainsKey($agent)) { return $timeLimits[$agent] } else { return 5 }
}

# proposal-reminder: every 15 min on weekdays. Routed THROUGH run-agents.ps1 so the
# cron secret is resolved at runtime from .env.local — never hardcoded here or baked
# into the registered task's command line.
$reminderBase = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "9:00AM"
# PS 5.1 can't mutate an empty .Repetition — borrow a populated one from a -Once trigger.
$reminderBase.Repetition = (New-ScheduledTaskTrigger -Once -At "9:00AM" -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 8)).Repetition
$reminderAction   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs proposal-reminder"
$reminderSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$reminderTask     = New-ScheduledTask -Action $reminderAction -Trigger $reminderBase -Settings $reminderSettings -Description "Kairos: proposal expiry reminder (every 15min, 9am-5pm weekdays)"
Register-ScheduledTask -TaskName "$TaskFolder\proposal-reminder" -InputObject $reminderTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\proposal-reminder  -> every 15 min, weekdays 9am-5pm"

foreach ($t in $tasks) {
  $mins     = TimeLimitFor $t.Agent
  $action   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs $($t.Agent)"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $mins) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  $task     = New-ScheduledTask -Action $action -Trigger $t.Trigger -Settings $settings -Description "Kairos agent: $($t.Agent)"
  Register-ScheduledTask -TaskName "$TaskFolder\$($t.Name)" -InputObject $task -Force | Out-Null
  Write-Host "Registered: $TaskFolder\$($t.Name)  -> $($t.Agent) (limit ${mins}m)"
}

# Stale-check: every 4h, all days
$staleBase = New-ScheduledTaskTrigger -Daily -At "12:00AM"
# Borrow a populated Repetition object (PS 5.1 can't mutate an empty one).
$staleBase.Repetition = (New-ScheduledTaskTrigger -Once -At "12:00AM" -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$staleAction   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs stale-check"
$staleSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$staleTask     = New-ScheduledTask -Action $staleAction -Trigger $staleBase -Settings $staleSettings -Description "Kairos agent: stale-check (every 4h)"
Register-ScheduledTask -TaskName "$TaskFolder\stale-check" -InputObject $staleTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\stale-check  -> stale-check (every 4h)"

# Nightly DB backup: Supabase Free tier has no automatic backups. Runs pg_dump
# directly (not through run-agents.ps1 — this isn't an HTTP call to the app).
# Requires SUPABASE_DB_URL in .env.local (see scripts/backup-db.ps1 header).
$backupScript   = "$PSScriptRoot\backup-db.ps1"
$backupAction   = New-ScheduledTaskAction -Execute $PSExe -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`""
$backupTrigger  = New-ScheduledTaskTrigger -Daily -At "3:00AM"
$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$backupTask     = New-ScheduledTask -Action $backupAction -Trigger $backupTrigger -Settings $backupSettings -Description "Kairos: nightly Postgres backup (pg_dump to backups/)"
Register-ScheduledTask -TaskName "$TaskFolder\db-backup" -InputObject $backupTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\db-backup  -> nightly pg_dump at 3:00 AM"

# Execution Gateway: sync every 30 min during market hours (9:30 AM - 4:00 PM ET).
$syncBase = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "9:30AM"
$syncBase.Repetition = (New-ScheduledTaskTrigger -Once -At "9:30AM" -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 6.5)).Repetition
$syncAction   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs broker-sync"
$syncSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$syncTask     = New-ScheduledTask -Action $syncAction -Trigger $syncBase -Settings $syncSettings -Description "Kairos: Alpaca order sync + reconciliation (every 30min, market hours)"
Register-ScheduledTask -TaskName "$TaskFolder\broker-sync" -InputObject $syncTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\broker-sync  -> every 30 min, weekdays 9:30am-4pm"

Write-Host ""
Write-Host "Done. All Kairos tasks registered under \$TaskFolder in Task Scheduler."
Write-Host "Verify with: Get-ScheduledTask -TaskPath `"\$TaskFolder\`""
