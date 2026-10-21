param([ValidateSet('Start', 'Status', 'Stop')][string]$Action = 'Status', [ValidateSet(443, 8443, 10000)][int]$HttpsPort = 8443)
. (Join-Path $PSScriptRoot 'Common.ps1')
$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe' }
if (-not (Test-Path -LiteralPath $tailscale)) { throw 'Install Tailscale and sign in first.' }
if ($Action -eq 'Status') { & $tailscale serve status; if ($LASTEXITCODE -ne 0) { throw 'Serve status failed.' }; return }
$raw = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing Serve settings.' }
$config = $raw | ConvertFrom-Json
$existing = @($config.Web.PSObject.Properties | Where-Object { $_.Name -match ":${HttpsPort}$" })
foreach ($entry in $existing) {
    $handlers = @($entry.Value.Handlers.PSObject.Properties)
    if ($handlers.Count -ne 1 -or $handlers[0].Name -ne '/' -or $handlers[0].Value.Proxy -ne 'http://127.0.0.1:8787') {
        throw "HTTPS $HttpsPort belongs to another service. Select an unused HTTPS port."
    }
}
if ($config.AllowFunnel) {
    foreach ($entry in $config.AllowFunnel.PSObject.Properties) {
        if ($entry.Name -match ":${HttpsPort}$" -and $entry.Value) {
            throw 'Public ingress is enabled on this port. Disable it in your existing configuration before using TurfLab.'
        }
    }
}
if ($Action -eq 'Stop') {
    if ($existing.Count) { & $tailscale serve "--https=$HttpsPort" off }
} else {
    $state = (& $tailscale status --json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $state.BackendState -ne 'Running') { throw 'Sign in to the same tailnet as your iPhone first.' }
    $token = Get-TurfToken
    $status = Invoke-RestMethod 'http://127.0.0.1:8787/api/status' -Headers @{ Authorization = "Bearer $token" }
    if ($status.storage_mode -ne 'local') { throw 'Start the local TurfLab instance first.' }
    & $tailscale serve --bg "--https=$HttpsPort" http://127.0.0.1:8787
}
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve operation failed. Review the CLI instructions.' }
& $tailscale serve status
