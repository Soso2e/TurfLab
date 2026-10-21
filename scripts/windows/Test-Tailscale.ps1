param([ValidateSet(443, 8443, 10000)][int]$HttpsPort = 8443)
. (Join-Path $PSScriptRoot 'Common.ps1')
$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe' }
$config = (& $tailscale serve status --json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Serve settings.' }
$entry = @($config.Web.PSObject.Properties | Where-Object { $_.Name -match ":${HttpsPort}$" -and $_.Value.Handlers.'/'.Proxy -eq 'http://127.0.0.1:8787' })
if ($entry.Count -ne 1) { throw 'Start the TurfLab Serve endpoint first.' }
# The URL comes only from the actual Serve response; certificate validation stays on.
$origin = 'https://' + $entry[0].Name
$page = Invoke-WebRequest -UseBasicParsing $origin -MaximumRedirection 0 -TimeoutSec 15
if ($page.StatusCode -ne 200 -or $page.Headers['Content-Type'] -notmatch 'text/html') { throw 'HTTPS Web check failed.' }
foreach ($path in @('/api', '/api/status', '/api/races')) {
    $code = 0
    try { $code = (Invoke-WebRequest -UseBasicParsing "$origin$path" -MaximumRedirection 0 -TimeoutSec 15).StatusCode }
    catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { throw } }
    if ($code -ne 401) { throw "Unauthenticated HTTPS API did not return 401: $path" }
}
$token = Get-TurfToken
$status = Invoke-RestMethod "$origin/api/status" -Headers @{ Authorization = "Bearer $token" } -MaximumRedirection 0 -TimeoutSec 15
if ($status.storage_mode -ne 'local') { throw 'Authenticated HTTPS status failed.' }
try {
    $internal = Invoke-WebRequest -UseBasicParsing "$origin/cdn-cgi/local/explorer/api" -MaximumRedirection 0 -TimeoutSec 15
    if ($internal.StatusCode -eq 200 -and $internal.Headers['Content-Type'] -notmatch 'text/html') { throw 'Wrangler Explorer is exposed.' }
} catch {
    if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -notin @(400, 403, 404)) { throw }
}
$null = Invoke-RestMethod "$origin/api/races" -Headers @{ Authorization = "Bearer $token" } -MaximumRedirection 0 -TimeoutSec 15
$null = New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot 'test-results')
@{ https = $true; unauthorized_status = 401; authenticated_local_api = $true; explorer_disabled = $true; origin = $origin; client = 'Windows same node'; iphone = 'unverified' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RepoRoot 'test-results/turflab-tailnet-report.json') -Encoding UTF8
Write-Output "PASS: $origin (HTTPS Web, API 401, authenticated local API, Explorer disabled). iPhone still requires device acceptance."
