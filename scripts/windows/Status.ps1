param([string]$DataHome, [switch]$Logs, [switch]$Follow)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
$healthFile = Join-Path $runtimeHome 'github-bridge/health.json'
if (Test-Path -LiteralPath $healthFile) {
    $health = Get-Content -LiteralPath $healthFile -Raw | ConvertFrom-Json
    $stale = ([datetime]::UtcNow - ([datetime]$health.checked_at).ToUniversalTime()).TotalSeconds -gt 120
    Write-Output "GitHub Worker: $($health.status) | stale: $stale | checked: $($health.checked_at) | error: $($health.last_error)"
}
$process = Get-TurfProcess $runtimeHome
if (-not $process) { Write-Output "Stopped | state: $(Join-Path $runtimeHome 'state')"; return }
Write-Output "Running PID $($process.ProcessId) | http://127.0.0.1:8787 | state: $(Join-Path $runtimeHome 'state')"
if ($Logs -or $Follow) {
    $record = Get-Content -LiteralPath (Join-Path $runtimeHome 'process.json') -Raw | ConvertFrom-Json
    if ($Follow) { Get-Content -LiteralPath $record.stdout, $record.stderr -Encoding UTF8 -Tail 30 -Wait }
    else { Get-Content -LiteralPath $record.stdout, $record.stderr -Encoding UTF8 -Tail 30 }
}
