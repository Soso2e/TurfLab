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
        if ($live.CommandLine -ne $record.command_line -or $live.CreationDate.ToUniversalTime() -ne ([datetime]$record.created_at).ToUniversalTime()) { throw 'GitHub worker PID identity mismatch. No process was stopped.' }
        Write-Output '[TurfLab] GitHub sync worker is already running.'
        return
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
