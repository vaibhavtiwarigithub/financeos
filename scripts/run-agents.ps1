# Kairos Agent Runner — Windows Task Scheduler trigger script
# Schedule (all times ET, weekdays only unless noted):
#   08:00  brief-morning     — email briefing before market open
#   09:00  research          — pre-market signal generation (all weekdays)
#   09:45  trader            — proposal generation after research settles
#   16:15  position-monitor  — post-close exit/trailing-stop checks
#   16:30  brief-evening     — email recap
#   17:00  nav-snapshot      — daily NAV + alpha snapshot
#   Friday 17:00  learner    — weekly weight learning (Fridays only; route skips other days)
#   Every 4h  stale-check   — alert on stale agent runs
param(
  [Parameter(Mandatory=$true)]
  [string]$Agent  # "research" | "learner" | "brief-morning" | "brief-evening" | "position-monitor" | "nav-snapshot" | "stale-check" | "trader"
)

$BASE = "http://localhost:3000"
$CRON_SECRET = ""

$endpoints = @{
  "research"         = @{ method="POST"; url="$BASE/api/agents/research/cron";        headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "learner"          = @{ method="POST"; url="$BASE/api/agents/learner";               headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "trader"           = @{ method="POST"; url="$BASE/api/agents/trader";                headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "brief-morning"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"session":"morning"}' }
  "brief-evening"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body='{"session":"evening"}' }
  "position-monitor" = @{ method="POST"; url="$BASE/api/agents/position-monitor";     headers=@{"Content-Type"="application/json"}; body="{}" }
  "nav-snapshot"     = @{ method="POST"; url="$BASE/api/agents/performance";           headers=@{"Content-Type"="application/json"}; body='{"action":"snapshot"}' }
  "stale-check"      = @{ method="GET";  url="$BASE/api/alerts/stale-check";           headers=@{}; body=$null }
}

if (-not $endpoints.ContainsKey($Agent)) {
  Write-Error "Unknown agent: $Agent. Valid: $($endpoints.Keys -join ', ')"
  exit 1
}

$ep = $endpoints[$Agent]
$logFile = "$PSScriptRoot\logs\$Agent-$(Get-Date -Format 'yyyy-MM-dd').log"
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

try {
  $params = @{ Uri=$ep.url; Method=$ep.method; Headers=$ep.headers; TimeoutSec=120 }
  if ($ep.body) { $params.Body = $ep.body }
  $res = Invoke-RestMethod @params
  $msg = "$(Get-Date -Format 'HH:mm:ss') [$Agent] OK: $($res | ConvertTo-Json -Compress -Depth 2)"
  Add-Content -Path $logFile -Value $msg
  Write-Host $msg
} catch {
  $err = "$(Get-Date -Format 'HH:mm:ss') [$Agent] ERROR: $_"
  Add-Content -Path $logFile -Value $err
  Write-Error $err
}
