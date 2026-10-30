param([string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
$manifest = Join-Path (Get-TurfHome $DataHome) 'github-bridge/process.json'
if (-not (Test-Path -LiteralPath $manifest)) { return }
$record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$live = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
if ($live) {
    if ($live.CommandLine -ne $record.command_line -or $live.CreationDate.ToUniversalTime() -ne ([datetime]$record.created_at).ToUniversalTime()) { throw 'GitHub worker PID identity mismatch. No process was stopped.' }
    & taskkill.exe /PID $live.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop GitHub sync worker.' }
}
Remove-Item -LiteralPath $manifest
