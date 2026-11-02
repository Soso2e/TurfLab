$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'TurfLab/logs'
$null = New-Item -ItemType Directory -Force -Path $logDir
$log = Join-Path $logDir 'logon-start.log'
try {
    Start-Transcript -Path $log -Append | Out-Null
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
}
