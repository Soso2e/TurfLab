$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Get-TurfHome([string]$DataHome) {
    if (-not $DataHome) { $DataHome = Join-Path $env:LOCALAPPDATA 'TurfLab' }
    $path = [IO.Path]::GetFullPath($DataHome)
    if ($path -match '["\r\n]') { throw 'DataHome must not contain quotes or newlines.' }
    return $path
}
function Get-TurfToken {
    $vars = Join-Path $RepoRoot 'workers/api/.dev.vars'
    if (-not (Test-Path -LiteralPath $vars)) { throw 'Run Initialize.ps1 first.' }
    $match = [regex]::Match([IO.File]::ReadAllText($vars), '(?m)^API_TOKEN="([A-Za-z0-9_-]{24,})"\r?$')
    if (-not $match.Success) { throw 'API_TOKEN must be a quoted random key (24+ letters/digits/_/-).' }
    return $match.Groups[1].Value
}
function Get-TurfProcess([string]$HomePath) {
    $manifest = Join-Path $HomePath 'process.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if (-not $process) { return $null }
    if ($process.CommandLine -ne $record.command_line -or
        $process.CreationDate.ToUniversalTime().ToString('o') -ne $record.created_at) {
        throw 'Recorded PID belongs to another process. Refusing to stop or reuse it.'
    }
    return $process
}
function Test-TurfPort([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}
function Stop-TurfProcess([string]$HomePath) {
    $process = Get-TurfProcess $HomePath
    if ($process) {
        & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the recorded process tree.' }
    }
    $manifest = Join-Path $HomePath 'process.json'
    if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest }
}
