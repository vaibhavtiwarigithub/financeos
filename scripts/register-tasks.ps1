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
  @{ Name="brief-evening";    Trigger=(WeekdayTrigger "4:30PM");  Agent="brief-evening"    },
  @{ Name="nav-snapshot";     Trigger=(WeekdayTrigger "5:00PM");  Agent="nav-snapshot"     },
  @{ Name="rescore";          Trigger=(WeekdayTrigger "4:45PM");  Agent="rescore"           },
  @{ Name="embed";            Trigger=(WeekdayTrigger "4:50PM");  Agent="embed"             },
  @{ Name="learner";          Trigger=(FridayTrigger  "5:00PM");  Agent="learner"           },
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
$timeLimits = @{ "embed" = 10; "learner" = 15 }
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

Write-Host ""
Write-Host "Done. All Kairos tasks registered under \$TaskFolder in Task Scheduler."
Write-Host "Verify with: Get-ScheduledTask -TaskPath `"\$TaskFolder\`""
