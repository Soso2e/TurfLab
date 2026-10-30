[CmdletBinding()]
param(
    [ValidateSet(443, 8443, 10000)][int]$HttpsPort = 8443,
    [string]$DataHome,
    [switch]$SkipTailscale,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$runtimeHome = Get-TurfHome $DataHome
$localUrl = 'http://127.0.0.1:8787'

# Never stop or replace an existing instance.
$running = Get-TurfProcess $runtimeHome
if ($running) {
    Write-Output "[TurfLab] Existing server detected (PID $($running.ProcessId))."
} else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 22+ and reopen this terminal before starting TurfLab.'
    }
    $wrangler = Join-Path $RepoRoot 'node_modules/wrangler/bin/wrangler.js'
    $devVars = Join-Path $RepoRoot 'workers/api/.dev.vars'
    if (-not (Test-Path -LiteralPath $wrangler) -or
        -not (Test-Path -LiteralPath $devVars)) {
        Write-Output '[TurfLab] First-run setup: dependencies, tests, build and personal key.'
        & (Join-Path $PSScriptRoot 'Initialize.ps1')
    }
    Write-Output '[TurfLab] Starting the local server...'
    & (Join-Path $PSScriptRoot 'Start.ps1') -DataHome $DataHome
}

# Verify the authenticated local application, not just an open port.
$token = Get-TurfToken
$status = Invoke-RestMethod "$localUrl/api/status" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15
if ($status.storage_mode -ne 'local') {
    throw 'The responding TurfLab instance is not in local storage mode.'
}
Write-Output "[TurfLab] Local Web/API ready: $localUrl"
& (Join-Path $PSScriptRoot 'Start-GitHubSync.ps1') -DataHome $runtimeHome
Write-Output "[TurfLab] Persistent data: $(Join-Path $runtimeHome 'state')"
Write-Output '[TurfLab] Personal login key: workers/api/.dev.vars (never share it).'

if (-not $NoBrowser) {
    try {
        Start-Process $localUrl
    } catch {
        Write-Warning "Open $localUrl manually; the browser could not be launched."
    }
}

if ($SkipTailscale) {
    Write-Output '[TurfLab] Tailscale skipped (local access only).'
    return
}

try {
    Write-Output "[TurfLab] Starting tailnet-only Tailscale Serve HTTPS on port $HttpsPort..."
    & (Join-Path $PSScriptRoot 'Tailscale.ps1') -Action Start -HttpsPort $HttpsPort
    & (Join-Path $PSScriptRoot 'Test-Tailscale.ps1') -HttpsPort $HttpsPort
} catch {
    Write-Warning "Tailscale setup or HTTPS verification failed: $($_.Exception.Message)"
    Write-Warning "The local server is still running at $localUrl; persistent data was not touched."
    Write-Warning 'Install/sign in to Tailscale on Windows and iPhone, check tailnet HTTPS permissions, then run this launcher again.'
    throw 'TurfLab is ready locally but tailnet access is not verified.'
}

Write-Output ''
Write-Output '[TurfLab] READY: Windows local Web/API and tailnet HTTPS are verified.'
Write-Output '[TurfLab] On iPhone, enable Tailscale and open the HTTPS URL printed above.'
Write-Output '[TurfLab] iPhone and real-race operation still require manual verification.'
