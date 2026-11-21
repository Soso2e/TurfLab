<#
.SYNOPSIS
  Isolated, read-only data audit and dev backtest of the odds-free forecast lab on the real NAR archive.
.DESCRIPTION
  - Reads %LOCALAPPDATA%\TurfLab\local-predictions\nar-csv (CSV and ZIP). The source is never written to.
  - Reads exchange\outcomes and exchange\forecasts for the bridge comparison. Those directories are read-only.
  - Writes only under %LOCALAPPDATA%\TurfLab\forecast-lab-dev\<timestamp>. The Worker, formal predictions,
    exchange\, the database and the Web app are not touched or restarted.
  - Default is the dev window (latest 20% untouched). -Final spends the one-shot holdout: do it once, last.
#>
param(
  [string]$CsvDir = (Join-Path $env:LOCALAPPDATA 'TurfLab\local-predictions\nar-csv'),
  [string]$ExchangeDir = (Join-Path $env:LOCALAPPDATA 'TurfLab\local-predictions\exchange'),
  [string]$DevRoot = (Join-Path $env:LOCALAPPDATA 'TurfLab\forecast-lab-dev'),
  [string]$Python = 'python',
  [switch]$Final
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcFull = [IO.Path]::GetFullPath($CsvDir)
$exchFull = [IO.Path]::GetFullPath($ExchangeDir)
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
# Bridge: read-only comparison of 6-eval softmax (exchange/outcomes) vs M forecast (exchange/forecasts)
if (Test-Path $exchFull) {
  Write-Host "bridge -> $out\bridge.json"
  & $Python $cli bridge --exchange-dir $exchFull --out (Join-Path $out 'bridge.json')
  if ($LASTEXITCODE) { Write-Warning 'bridge step failed; continuing' }
} else {
  Write-Host "bridge: exchange dir not found ($exchFull), skipped"
}
Write-Host "done. Send audit.json, backtest-$mode.json and bridge.json for review. Nothing outside $devFull was written."
