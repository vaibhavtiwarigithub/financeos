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
  @{ Name="embed";            Trigger=(WeekdayTrigger "4:50PM");  Agent="embed"             },
  @{ Name="learner";          Trigger=(FridayTrigger  "5:00PM");  Agent="learner"           }
)

# proposal-reminder: every 15 min on weekdays (hits /api/alerts/proposal-reminder)
$BaseUrl    = "http://localhost:3000"
$CronSecret = "fos-cron-k9x2m7p4-2026"
$reminderArgs = "-NonInteractive -ExecutionPolicy Bypass -Command `"Invoke-WebRequest -Uri '$BaseUrl/api/alerts/proposal-reminder' -Method POST -Headers @{'x-cron-secret'='$CronSecret'} -UseBasicParsing | Out-Null`""
$reminderBase = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "9:00AM"
$reminderBase.Repetition.Interval   = "PT15M"
$reminderBase.Repetition.Duration   = "PT8H"
$reminderBase.Repetition.StopAtDurationEnd = $false
$reminderAction   = New-ScheduledTaskAction -Execute $PSExe -Argument $reminderArgs
$reminderSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$reminderTask     = New-ScheduledTask -Action $reminderAction -Trigger $reminderBase -Settings $reminderSettings -Description "Kairos: proposal expiry reminder (every 15min, 9am-5pm weekdays)"
Register-ScheduledTask -TaskName "$TaskFolder\proposal-reminder" -InputObject $reminderTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\proposal-reminder  -> every 15 min, weekdays 9am-5pm"

# Ensure task folder exists
$sch = New-Object -ComObject Schedule.Service
$sch.Connect()
$root = $sch.GetFolder("\")
try { $root.GetFolder($TaskFolder) }
catch { $root.CreateFolder($TaskFolder) | Out-Null; Write-Host "Created folder \$TaskFolder" }

foreach ($t in $tasks) {
  $action   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs $($t.Agent)"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  $task     = New-ScheduledTask -Action $action -Trigger $t.Trigger -Settings $settings -Description "Kairos agent: $($t.Agent)"
  Register-ScheduledTask -TaskName "$TaskFolder\$($t.Name)" -InputObject $task -Force | Out-Null
  Write-Host "Registered: $TaskFolder\$($t.Name)  -> $($t.Agent)"
}

# Stale-check: every 4h, all days
$staleBase = New-ScheduledTaskTrigger -Daily -At "12:00AM"
$staleBase.Repetition.Interval   = "PT4H"
$staleBase.Repetition.Duration   = "P1D"
$staleBase.Repetition.StopAtDurationEnd = $false
$staleAction   = New-ScheduledTaskAction -Execute $PSExe -Argument "$PSArgs stale-check"
$staleSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$staleTask     = New-ScheduledTask -Action $staleAction -Trigger $staleBase -Settings $staleSettings -Description "Kairos agent: stale-check (every 4h)"
Register-ScheduledTask -TaskName "$TaskFolder\stale-check" -InputObject $staleTask -Force | Out-Null
Write-Host "Registered: $TaskFolder\stale-check  -> stale-check (every 4h)"

Write-Host ""
Write-Host "Done. All Kairos tasks registered under \$TaskFolder in Task Scheduler."
Write-Host "Verify with: Get-ScheduledTask -TaskPath `"\$TaskFolder\`""
