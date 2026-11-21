<#
.SYNOPSIS
  Isolated, read-only data audit and dev backtest of the odds-free forecast lab on the real NAR archive.
.DESCRIPTION
  - Reads %LOCALAPPDATA%\TurfLab\local-predictions\nar-csv (CSV and ZIP). The source is never written to.
  - Writes only under %LOCALAPPDATA%\TurfLab\forecast-lab-dev\<timestamp>. The Worker, formal predictions,
    exchange\, the database and the Web app are not touched or restarted.
  - Default is the dev window (latest 20% untouched). -Final spends the one-shot holdout: do it once, last.
#>
param(
  [string]$CsvDir = (Join-Path $env:LOCALAPPDATA 'TurfLab\local-predictions\nar-csv'),
  [string]$DevRoot = (Join-Path $env:LOCALAPPDATA 'TurfLab\forecast-lab-dev'),
  [string]$Python = 'python',
  [switch]$Final
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcFull = [IO.Path]::GetFullPath($CsvDir)
$devFull = [IO.Path]::GetFullPath($DevRoot)
if (-not (Test-Path $srcFull)) { throw "CSV directory not found: $srcFull" }
if ($devFull.StartsWith($srcFull, [StringComparison]::OrdinalIgnoreCase) -or
    $devFull -like '*\local-predictions\exchange*') { throw "DevRoot must be outside the data home: $devFull" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $devFull $stamp
$state = Join-Path $devFull 'state'   # holdout lock + trial log persist across runs
New-Item -ItemType Directory -Force -Path $out, $state | Out-Null
$cli = Join-Path $repo 'scripts\python\forecast_lab\cli.py'
Write-Host "audit -> $out\audit.json"
& $Python $cli audit --csv-dir $srcFull --out (Join-Path $out 'audit.json')
if ($LASTEXITCODE) { throw 'audit failed' }
$mode = if ($Final) { 'final' } else { 'dev' }
Write-Host "backtest ($mode) -> $out\backtest-$mode.json"
$args = @('backtest','--csv-dir',$srcFull,'--out',(Join-Path $out "backtest-$mode.json"),'--state-dir',$state,'--mode',$mode)
if (-not $Final) { $args += '--ablate' }
& $Python $cli @args
if ($LASTEXITCODE) { throw 'backtest failed' }
Write-Host "done. Send audit.json and backtest-$mode.json for review. Nothing outside $devFull was written."
