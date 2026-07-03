# Kairos Task Scheduler Setup
# Run as Administrator to register all Kairos scheduled tasks.
# Usage: powershell -ExecutionPolicy Bypass -File setup-tasks.ps1

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = "$scriptDir\run-agents.ps1"

function Register-FOSTask {
  param($Name, $Agent, $Trigger)

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -Agent $Agent" `
    -WorkingDirectory $scriptDir

  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd

  Register-ScheduledTask `
    -TaskName "Kairos-$Name" `
    -Action $action `
    -Trigger $Trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force | Out-Null

  Write-Host "Registered: Kairos-$Name"
}

# Research: weekdays 9:30 AM ET (after market open)
Register-FOSTask "Research" "research" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "9:30AM"
)

# Morning briefing: weekdays 8:55 AM (before research)
Register-FOSTask "BriefMorning" "brief-morning" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "8:55AM"
)

# Position monitor: weekdays 4:15 PM (after market close)
Register-FOSTask "PositionMonitor" "position-monitor" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "4:15PM"
)

# NAV snapshot: weekdays 4:30 PM
Register-FOSTask "NavSnapshot" "nav-snapshot" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "4:30PM"
)

# Evening briefing: weekdays 4:45 PM
Register-FOSTask "BriefEvening" "brief-evening" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "4:45PM"
)

# LearnerAgent: Sundays 8 PM
Register-FOSTask "Learner" "learner" (
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "8:00PM"
)

# Stale check: daily 6 PM
Register-FOSTask "StaleCheck" "stale-check" (
  New-ScheduledTaskTrigger -Daily -At "6:00PM"
)

Write-Host ""
Write-Host "All Kairos tasks registered. Run Get-ScheduledTask -TaskName 'Kairos-*' to verify."
