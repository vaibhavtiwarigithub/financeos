# Kairos â€” Install Robinhood sync as a Windows Scheduled Task
# Run ONCE as Administrator: .\install-robin-sync.ps1
# Requires Python in PATH with robin_stocks + requests installed.

$ScriptDir  = $PSScriptRoot
$PythonExe  = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $PythonExe) {
    Write-Error "Python not found in PATH. Install Python 3 first."
    exit 1
}

$SyncScript = "$ScriptDir\sync_robin.py"
$LogDir     = "$ScriptDir\logs"
$TaskName   = "Kairos-RobinSync"

# â”€â”€ Step 1: install pip deps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Write-Host "Installing pip dependencies..."
& $PythonExe -m pip install robin_stocks requests --quiet
if ($LASTEXITCODE -ne 0) { Write-Error "pip install failed"; exit 1 }
Write-Host "Dependencies installed."

# â”€â”€ Step 2: first-run login (interactive â€” handles 2FA) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Write-Host ""
Write-Host "=== First-time Robinhood login ==="
Write-Host "You will be prompted for 2FA. After this, the session is saved and"
Write-Host "future runs are fully automated (no 2FA needed for 7 days)."
Write-Host ""
& $PythonExe $SyncScript --setup
if ($LASTEXITCODE -ne 0) { Write-Error "First-run login failed. Fix credentials in scripts\robin.env then re-run."; exit 1 }
Write-Host ""
Write-Host "Login successful. Session saved."

# â”€â”€ Step 3: register scheduled task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Write-Host "Registering scheduled task: $TaskName"

$Action  = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$SyncScript`"" -WorkingDirectory $ScriptDir
$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At (Get-Date)

# Run Mon-Fri 08:00-22:00 ET (13:00-03:00 UTC) â€” covers pre-market + after-hours
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   $Trigger `
    -Settings  $Settings `
    -RunLevel  Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "=== Done ==="
Write-Host "Task '$TaskName' registered â€” runs every hour."
Write-Host "Logs: $LogDir\robin-sync-<date>.log"
Write-Host ""
Write-Host "To run manually:  python `"$SyncScript`""
Write-Host "To view task:     Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "To remove task:   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
