param([string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
$bridgeDir = Join-Path $runtimeHome 'github-bridge'
$configFile = Join-Path $bridgeDir 'config.json'
if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Output '[TurfLab] GitHub sync is not configured. See docs/github-prediction-bridge.md.'
    return
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install GitHub CLI and run gh auth login.' }
$manifest = Join-Path $bridgeDir 'process.json'
if (Test-Path -LiteralPath $manifest) {
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if ($live) {
        if ($live.CommandLine -eq $record.command_line -and $live.CreationDate.ToUniversalTime() -eq ([datetime]$record.created_at).ToUniversalTime()) {
            Write-Output '[TurfLab] GitHub sync worker is already running.'
            return
        }
        # Only a later creation time proves the old process is gone. Never stop the reused PID.
        if ($live.CreationDate.ToUniversalTime() -le ([datetime]$record.created_at).ToUniversalTime()) { throw 'GitHub worker PID identity mismatch. No process was stopped.' }
        $lock = Join-Path $bridgeDir 'worker.lock'
        if (-not (Test-Path -LiteralPath $lock) -or (Get-Content -LiteralPath $lock -Raw).Trim() -ne [string]$record.pid) { throw 'Stale worker lock does not match its manifest. No files were changed.' }
        $again = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
        if (-not $again -or $again.CreationDate.ToUniversalTime() -ne $live.CreationDate.ToUniversalTime() -or (Get-Content -LiteralPath $lock -Raw).Trim() -ne [string]$record.pid) { throw 'Worker identity changed during inspection. No files were changed.' }
        $suffix = '.stale-' + [guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $lock -Destination ($lock + $suffix)
        Move-Item -LiteralPath $manifest -Destination ($manifest + $suffix)
        Write-Output '[TurfLab] Archived stale worker identity; unrelated process retained.'
    }
}
$null = New-Item -ItemType Directory -Force -Path (Join-Path $runtimeHome 'logs')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$scriptFile = Join-Path $RepoRoot 'scripts/github-sync.ts'
$argsList = @('--import', 'tsx', "`"$scriptFile`"", '--data-home', "`"$runtimeHome`"")
$child = Start-Process -FilePath (Get-Command node).Source -ArgumentList $argsList -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeHome "logs/github-$stamp.out.log") -RedirectStandardError (Join-Path $runtimeHome "logs/github-$stamp.err.log")
Start-Sleep -Seconds 1
$live = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
if (-not $live) { throw 'GitHub sync worker exited. Check the local github error log.' }
@{ pid = $child.Id; command_line = $live.CommandLine; created_at = $live.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
Write-Output '[TurfLab] GitHub sync worker started (default poll: 5 minutes).'
