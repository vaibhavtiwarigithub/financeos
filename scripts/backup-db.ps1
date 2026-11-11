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

$BackupDir = Join-Path $env:LOCALAPPDATA 'Kairos\backups\database'
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
# A full dump contains private financial data. Keep it out of the repository and
# OneDrive, and require an explicit ACL for the signed-in account only.
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
& icacls.exe $BackupDir '/inheritance:r' '/grant:r' "*$($ownerSid.Value):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error 'Private backup directory ACL could not be set. Backup skipped.'
  exit 1
}
$actualAcl = Get-Acl -LiteralPath $BackupDir
if (-not $actualAcl.AreAccessRulesProtected -or $actualAcl.Access.Count -ne 1 -or
    $actualAcl.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value) {
  Write-Error 'Private backup directory ACL could not be verified. Backup skipped.'
  exit 1
}

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
if ($DbUrl.Contains('[HOST]') -or $DbUrl.Contains('[YOUR-PASSWORD]')) {
  Write-Error 'SUPABASE_DB_URL is still a template. Configure the current Session Pooler host and database password privately. Backup skipped.'
  exit 1
}
try {
  $DbUri = [Uri]$DbUrl
  $separator = $DbUri.UserInfo.IndexOf(':')
  if ($DbUri.Scheme -notin @('postgresql', 'postgres') -or $separator -lt 1 -or
      $DbUri.Port -lt 1 -or $DbUri.AbsolutePath -ne '/postgres') { throw 'invalid connection' }
  $DbUser = [Uri]::UnescapeDataString($DbUri.UserInfo.Substring(0, $separator))
  $DbPassword = [Uri]::UnescapeDataString($DbUri.UserInfo.Substring($separator + 1))
  $SslMode = 'require'
  if ($DbUri.Query -match '(?:^\?|&)sslmode=([^&]+)') {
    $SslMode = [Uri]::UnescapeDataString($Matches[1])
  }
  $direct = $DbUri.Host -eq 'db.dionkikgdmlaotvtbnfr.supabase.co' -and $DbUser -eq 'postgres'
  $pooler = $DbUri.Host -like '*.pooler.supabase.com' -and $DbUser -eq 'postgres.dionkikgdmlaotvtbnfr'
  if (-not $DbPassword -or (-not $direct -and -not $pooler) -or
      $SslMode -notin @('require', 'verify-ca', 'verify-full')) { throw 'invalid connection' }
} catch {
  Write-Error 'SUPABASE_DB_URL is not a valid connection to the FinanceOS project. Backup skipped.'
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
  # Keep libpq diagnostics private: connection strings and account details must
  # never be echoed into task logs. Surface only a bounded failure category.
  # The original URI must never appear in a process command line or a child
  # environment. libpq reads only the password from PGPASSWORD.
  $priorPassword = $env:PGPASSWORD
  $priorDbUrl = $env:SUPABASE_DB_URL
  $priorSslMode = $env:PGSSLMODE
  $priorConnectTimeout = $env:PGCONNECT_TIMEOUT
  $env:SUPABASE_DB_URL = $null
  $env:PGPASSWORD = $DbPassword
  $env:PGSSLMODE = $SslMode
  $env:PGCONNECT_TIMEOUT = '15'
  $dumpOutput = & $PgDump -h $DbUri.Host -p $DbUri.Port -U $DbUser -d postgres -Fc --no-owner --no-privileges -f $outFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    $diagnostic = ($dumpOutput | Out-String)
    $category = if ($diagnostic -match 'password authentication failed|no password supplied') { 'authentication' }
      elseif ($diagnostic -match 'could not translate host name|Name or service not known') { 'dns' }
      elseif ($diagnostic -match 'Connection refused|timeout expired|could not connect to server') { 'connection' }
      elseif ($diagnostic -match 'server version mismatch|server version:') { 'version' }
      elseif ($diagnostic -match 'no pg_hba.conf entry|SSL|certificate') { 'tls_or_access' }
      else { 'unknown' }
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FAILED ($category, exit $LASTEXITCODE)"
    Write-Error "pg_dump failed: $category (exit $LASTEXITCODE)"
    exit 1
  }
  if ((Get-Item -LiteralPath $outFile).Length -lt 1024) {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Write-Error 'pg_dump returned an empty or incomplete archive. Backup skipped.'
    exit 1
  }
  $PgRestore = Join-Path (Split-Path -Parent $PgDump) 'pg_restore.exe'
  & $PgRestore -l $outFile 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Write-Error 'pg_restore could not read the archive catalog. Backup skipped.'
    exit 1
  }
  $sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
  Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK: $outFile ($sizeMB MB)"
  Write-Host "Backup OK: $outFile ($sizeMB MB)"
} catch {
  Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR: backup script failed"
  Write-Error 'Backup script failed; inspect only the private backup log for its bounded status.'
  exit 1
} finally {
  $env:PGPASSWORD = $priorPassword
  $env:SUPABASE_DB_URL = $priorDbUrl
  $env:PGSSLMODE = $priorSslMode
  $env:PGCONNECT_TIMEOUT = $priorConnectTimeout
  $DbPassword = $null
  $DbUrl = $null
}
