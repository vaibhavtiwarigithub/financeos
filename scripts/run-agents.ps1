# Kairos Agent Runner — Windows Task Scheduler trigger script
# Schedule (all times ET, weekdays only unless noted):
#   09:00  research          — pre-market signal generation (all weekdays)
#   09:45  trader            — proposal generation after research settles
#   10:00  brief-morning     — email briefing, after research+trader settle
#   16:15  position-monitor  — post-close exit/trailing-stop checks
#   16:30  brief-evening     — email recap
#   16:50  embed             — RAG embeddings for newly-enriched trade_decisions (before learner)
#   17:00  nav-snapshot      — daily NAV + alpha snapshot
#   Friday 17:00  learner    — weekly weight learning (Fridays only; route skips other days)
#   Every 4h  stale-check   — alert on stale agent runs
param(
  [Parameter(Mandatory=$true)]
  [string]$Agent  # "research" | "learner" | "brief-morning" | "brief-evening" | "position-monitor" | "nav-snapshot" | "stale-check" | "trader" | "embed"
)

$BASE = "http://localhost:3000"

# CRON_SECRET is never hardcoded here (would leak into git). Resolve at runtime:
#   1. $env:KAIROS_CRON_SECRET if set
#   2. else parse CRON_SECRET from ../.env.local (the same source the server reads)
$CRON_SECRET = $env:KAIROS_CRON_SECRET
if (-not $CRON_SECRET) {
  $envFile = Join-Path $PSScriptRoot "..\.env.local"
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*CRON_SECRET\s*=' | Select-Object -First 1
    if ($line) { $CRON_SECRET = ($line.Line -replace '^\s*CRON_SECRET\s*=\s*','').Trim().Trim('"').Trim("'") }
  }
}
if (-not $CRON_SECRET) { Write-Warning "CRON_SECRET not resolved — cron-authed endpoints will 401. Set KAIROS_CRON_SECRET env or CRON_SECRET in .env.local." }

$endpoints = @{
  # US market (ET schedule). ?market=us so the 9 AM run no longer touches India —
  # India has its own post-NSE-close run below.
  "research"         = @{ method="POST"; url="$BASE/api/agents/research/cron?market=us";    headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "learner"          = @{ method="POST"; url="$BASE/api/agents/learner";               headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "trader"           = @{ method="POST"; url="$BASE/api/agents/trader";                headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "brief-morning"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"session":"morning"}' }
  "brief-evening"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"session":"evening"}' }
  "position-monitor" = @{ method="POST"; url="$BASE/api/agents/position-monitor?market=us"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  # India market. NSE closes 15:30 IST = 06:00 ET, so these fire in the ET morning
  # (register-tasks.ps1: research-india 6:15 AM, monitor-india 6:35 AM ET). India
  # research chains its own ?market=india paper-trade automatically.
  "research-india"         = @{ method="POST"; url="$BASE/api/agents/research/cron?market=india";    headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "position-monitor-india" = @{ method="POST"; url="$BASE/api/agents/position-monitor?market=india"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  # Phase 1 learning-core: nightly maturation of decision_observations -> observation_labels.
  "label-maturation" = @{ method="POST"; url="$BASE/api/agents/label-maturation"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=300 }
  # Phase 2 learning-core: weekly refit of the calibrated P(win) sizing model (dormant until 60+ matured labels).
  "fit-calibration" = @{ method="POST"; url="$BASE/api/validation/fit-calibration"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=120 }
  # Execution Gateway: polls Alpaca for order-status updates + position reconciliation.
  "broker-sync" = @{ method="POST"; url="$BASE/api/broker/orders/sync"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=60 }
  # Phase 3 learning-core: weekly feature-registry IC check (proposed/quarantined/active promotion+retirement).
  "feature-check" = @{ method="POST"; url="$BASE/api/validation/feature-check"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=120 }
  # Nightly full-NSE pre-score cache (india_screen_cache). Rotates ~600 names/run,
  # oldest-scored-first, so the India scanner reads the whole market. Runs before
  # research-india (6:15 AM) so candidates draw from a fresh cache.
  "scan-india-refresh"     = @{ method="POST"; url="$BASE/api/scan/india/refresh"; headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=300 }
  "nav-snapshot"     = @{ method="POST"; url="$BASE/api/agents/performance";           headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"action":"snapshot"}' }
  "stale-check"      = @{ method="POST"; url="$BASE/api/alerts/stale-check";           headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "embed"            = @{ method="POST"; url="$BASE/api/live-portfolio/embed";         headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"limit":200}'; timeoutSec=300 }
  "proposal-reminder"= @{ method="POST"; url="$BASE/api/alerts/proposal-reminder";     headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "rescore"          = @{ method="POST"; url="$BASE/api/agents/rescore-check";          headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "mentor-coach"     = @{ method="POST"; url="$BASE/api/agents/mentor-coach";           headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}"; timeoutSec=180 }
}

if (-not $endpoints.ContainsKey($Agent)) {
  Write-Error "Unknown agent: $Agent. Valid: $($endpoints.Keys -join ', ')"
  exit 1
}

$ep = $endpoints[$Agent]
$logFile = "$PSScriptRoot\logs\$Agent-$(Get-Date -Format 'yyyy-MM-dd').log"
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

try {
  $timeout = if ($ep.timeoutSec) { $ep.timeoutSec } else { 120 }
  $params = @{ Uri=$ep.url; Method=$ep.method; Headers=$ep.headers; TimeoutSec=$timeout }
  if ($ep.body) { $params.Body = $ep.body }
  $res = Invoke-RestMethod @params

  # Routes return HTTP 200 with { error: ... } on app-level failure — treat as failure.
  if ($res -and ($res.PSObject.Properties.Name -contains 'error') -and $res.error) {
    $err = "$(Get-Date -Format 'HH:mm:ss') [$Agent] APP-ERROR: $($res.error)"
    Add-Content -Path $logFile -Value $err
    Write-Error $err
    exit 1
  }

  $msg = "$(Get-Date -Format 'HH:mm:ss') [$Agent] OK: $($res | ConvertTo-Json -Compress -Depth 2)"
  Add-Content -Path $logFile -Value $msg
  Write-Host $msg
  exit 0
} catch {
  $err = "$(Get-Date -Format 'HH:mm:ss') [$Agent] ERROR: $_"
  Add-Content -Path $logFile -Value $err
  Write-Error $err
  exit 1
}
