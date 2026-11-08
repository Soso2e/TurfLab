param([string]$DataHome, [string]$Model = 'gpt-6.1-sol')
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
$workerHome = Join-Path $runtimeHome 'local-predictions'
$manifestHome = Join-Path $workerHome 'process'
if (Get-TurfProcess $manifestHome) { Write-Output 'Local prediction worker is running.'; return }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Codex CLI is required.' }
if ($Model -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid model name.' }
$null = New-Item -ItemType Directory -Force -Path $manifestHome, (Join-Path $runtimeHome 'logs')
$stamp = Get-Date -Format yyyyMMdd-HHmmss
$scriptFile = Join-Path $RepoRoot 'scripts/local-predictions.ts'
$child = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import','tsx',"`"$scriptFile`"", '--data-home', "`"$runtimeHome`"", '--model', $Model) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeHome "logs/predictions-$stamp.out.log") -RedirectStandardError (Join-Path $runtimeHome "logs/predictions-$stamp.err.log")
Start-Sleep -Seconds 2
$live = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
if (-not $live) { throw 'Prediction worker exited. Check local logs.' }
@{ pid=$child.Id; command_line=$live.CommandLine; created_at=$live.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $manifestHome 'process.json') -Encoding utf8
Write-Output 'Local Codex prediction worker started.'
