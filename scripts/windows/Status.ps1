param([string]$DataHome, [switch]$Logs, [switch]$Follow)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
$process = Get-TurfProcess $runtimeHome
if (-not $process) { Write-Output "Stopped | state: $(Join-Path $runtimeHome 'state')"; return }
Write-Output "Running PID $($process.ProcessId) | http://127.0.0.1:8787 | state: $(Join-Path $runtimeHome 'state')"
if ($Logs -or $Follow) {
    $record = Get-Content -LiteralPath (Join-Path $runtimeHome 'process.json') -Raw | ConvertFrom-Json
    if ($Follow) { Get-Content -LiteralPath $record.stdout, $record.stderr -Encoding UTF8 -Tail 30 -Wait }
    else { Get-Content -LiteralPath $record.stdout, $record.stderr -Encoding UTF8 -Tail 30 }
}
