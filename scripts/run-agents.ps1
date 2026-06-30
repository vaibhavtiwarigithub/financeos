# FinanceOS Agent Runner
# Called by Windows Task Scheduler for each agent
param(
  [Parameter(Mandatory=$true)]
  [string]$Agent  # "research" | "learner" | "brief-morning" | "brief-evening" | "position-monitor" | "nav-snapshot" | "stale-check"
)

$BASE = "http://localhost:3000"
$CRON_SECRET = "fos-cron-k9x2m7p4-2026"

$endpoints = @{
  "research"         = @{ method="POST"; url="$BASE/api/agents/research/cron";        headers=@{"x-cron-secret"=$CRON_SECRET;"Content-Type"="application/json"}; body="{}" }
  "learner"          = @{ method="POST"; url="$BASE/api/agents/learner";               headers=@{"Content-Type"="application/json"}; body="{}" }
  "brief-morning"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"Content-Type"="application/json"}; body='{"session":"morning"}' }
  "brief-evening"    = @{ method="POST"; url="$BASE/api/briefing/generate";            headers=@{"Content-Type"="application/json"}; body='{"session":"evening"}' }
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
