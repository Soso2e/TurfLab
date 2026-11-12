param([string]$DataHome, [string]$Model = 'gpt-6.1-sol', [string]$ReasoningEffort = 'low', [string]$HelperModel = 'gemini-3.8-flash-medium')
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
$workerHome = Join-Path $runtimeHome 'local-predictions'
$manifestHome = Join-Path $workerHome 'process'
$runningWorker = Get-TurfProcess $manifestHome
if ($runningWorker) { Write-Output 'Local prediction worker is running.'; Test-TurfCheckout $runningWorker 'Prediction worker'; return }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Codex CLI is required.' }
if ($Model -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid model name.' }
if ($ReasoningEffort -notmatch '^(low|medium|high)$') { throw 'Invalid reasoning effort.' }
if ($HelperModel -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid helper model name.' }
# No recorded worker is alive. A lock left by a killed worker can name a PID
# that Windows has since reused (e.g. smartscreen.exe); the worker would then
# refuse to start forever. Archive it only when that PID is not a TurfLab
# prediction worker. No process is ever stopped here.
$lock = Join-Path $workerHome 'worker.lock'
if (Test-Path -LiteralPath $lock) {
    $lockPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(), [ref]$lockPid) -and $lockPid -gt 0) {
        $holder = Get-CimInstance Win32_Process -Filter "ProcessId = $lockPid"
        if ($holder -and $holder.Name -eq 'node.exe' -and $holder.CommandLine -match 'local-predictions\.ts') {
            throw "Prediction worker PID $lockPid holds the lock but has no manifest. Inspect it; nothing was changed."
        }
        Move-Item -LiteralPath $lock -Destination ($lock + '.stale-' + [guid]::NewGuid().ToString('N'))
        Write-Output "Archived stale prediction worker lock (PID $lockPid is not a prediction worker)."
    }
}
$null = New-Item -ItemType Directory -Force -Path $manifestHome, (Join-Path $runtimeHome 'logs')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$scriptFile = Join-Path $RepoRoot 'scripts/local-predictions.ts'
$child = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import','tsx',"`"$scriptFile`"", '--data-home', "`"$runtimeHome`"", '--model', $Model, '--reasoning-effort', $ReasoningEffort, '--helper-model', $HelperModel) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeHome "logs/predictions-$stamp.out.log") -RedirectStandardError (Join-Path $runtimeHome "logs/predictions-$stamp.err.log")
Start-Sleep -Seconds 2
$live = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
if (-not $live) { throw 'Prediction worker exited. Check local logs.' }
@{ pid=$child.Id; command_line=$live.CommandLine; created_at=$live.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $manifestHome 'process.json') -Encoding utf8
Write-Output 'Local Codex prediction worker started.'
