# Kairos — Nightly Postgres backup (Supabase Free tier has no automatic backups)
# Run manually to test: powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
# Registered as a nightly Windows Task Scheduler task (see register-tasks.ps1).
#
# Connection string is NEVER hardcoded here — resolved at runtime, same pattern
# as CRON_SECRET in run-agents.ps1:
#   1. $env:SUPABASE_DB_URL if set
#   2. else parse SUPABASE_DB_URL from ../.env.local
#
# To enable: add a line to .env.local yourself (Supabase dashboard -> Settings
# -> Database -> Connection string -> URI, "Session pooler" or direct connection):
#   SUPABASE_DB_URL=postgresql://postgres:[YOUR-PASSWORD]@[HOST]:5432/postgres

$BackupDir = Join-Path $PSScriptRoot "..\backups"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$DbUrl = $env:SUPABASE_DB_URL
if (-not $DbUrl) {
  $envFile = Join-Path $PSScriptRoot "..\.env.local"
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*SUPABASE_DB_URL\s*=' | Select-Object -First 1
    if ($line) { $DbUrl = ($line.Line -replace '^\s*SUPABASE_DB_URL\s*=\s*', '').Trim().Trim('"').Trim("'") }
  }
}
if (-not $DbUrl) {
  Write-Error "SUPABASE_DB_URL not set. Add it to .env.local (Supabase dashboard -> Settings -> Database -> Connection string) or set `$env:SUPABASE_DB_URL. Backup skipped."
  exit 1
}

# Locate pg_dump — prefer PATH, else the known winget install location.
$PgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
if (-not $PgDump) {
  $candidates = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($candidates) { $PgDump = $candidates[0].FullName }
}
if (-not $PgDump) {
  Write-Error "pg_dump.exe not found (PATH or C:\Program Files\PostgreSQL\*\bin). Backup skipped."
  exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$outFile = Join-Path $BackupDir "kairos_$stamp.dump"
$logFile = Join-Path $BackupDir "backup.log"

try {
  # -Fc = custom format: compressed, restorable with pg_restore, handles large
  # objects/schema+data cleanly. --no-owner/--no-privileges so a restore into a
  # different Supabase project (different role names) doesn't fail on GRANT/OWNER.
  & $PgDump $DbUrl -Fc --no-owner --no-privileges -f $outFile 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FAILED (exit $LASTEXITCODE)"
    Write-Error "pg_dump failed with exit code $LASTEXITCODE"
    exit 1
  }
  $sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
  Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK: $outFile ($sizeMB MB)"
  Write-Host "Backup OK: $outFile ($sizeMB MB)"
} catch {
  Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR: $_"
  Write-Error $_
  exit 1
}

# Retention: keep the last 14 daily dumps, delete older ones so backups/ doesn't
# grow unbounded. Data volume here is small (tens of MB), so 14 days costs little.
$allDumps = Get-ChildItem (Join-Path $BackupDir "kairos_*.dump") | Sort-Object LastWriteTime -Descending
if ($allDumps.Count -gt 14) {
  $allDumps | Select-Object -Skip 14 | ForEach-Object {
    Remove-Item $_.FullName -Force
    Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') pruned: $($_.Name)"
  }
}
