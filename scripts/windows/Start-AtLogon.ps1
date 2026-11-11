$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'TurfLab/logs'
$null = New-Item -ItemType Directory -Force -Path $logDir
$log = Join-Path $logDir 'logon-start.log'
# TurfLab-Logon and TurfLab-Watchdog are separate tasks, so the per-task
# IgnoreNew setting does not stop them overlapping. Serialize every launcher
# (from any checkout) for this user; a concurrent run simply exits.
$mutex = New-Object System.Threading.Mutex($false, 'Local\TurfLab-Start-AtLogon')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) Another TurfLab launcher is running; skipped."
    exit 0
}
try {
    Start-Transcript -Path $log -Append | Out-Null
    Write-Output "[TurfLab] Launcher checkout: $((Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)"
    # Tailscale may still be connecting at logon. Start-All is idempotent and
    # leaves the local service running if HTTPS is temporarily unavailable.
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            & (Join-Path $PSScriptRoot 'Start-All.ps1') -HttpsPort 8443 -NoBrowser
            exit 0
        } catch {
            Write-Warning "Startup attempt $attempt failed: $($_.Exception.Message)"
            if ($attempt -eq 6) { throw }
            Start-Sleep -Seconds 30
        }
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
