param([string]$DataHome, [switch]$SkipBuild)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
if (Get-TurfProcess $runtimeHome) { throw 'TurfLab is already running. Stop it before updating.' }
if (Test-TurfPort 8787) { throw 'Port 8787 is occupied. No process was stopped.' }
if (Test-TurfPort 9230) { throw 'Inspector port 9230 is occupied. No process was stopped.' }
if ([int]((& node --version).TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22+ is required.' }
$token = Get-TurfToken
Push-Location $RepoRoot
try {
    if (-not $SkipBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'dist/index.html'))) { throw 'Build is missing.' }
    $null = New-Item -ItemType Directory -Force -Path $runtimeHome, (Join-Path $runtimeHome 'logs')
    # Pin local mode and keep every Google credential out of the runtime config.
    # Reuse the existing Worker, owner DO binding, class and migration.
    $config = Get-Content -LiteralPath (Join-Path $RepoRoot 'workers/api/wrangler.jsonc') -Raw | ConvertFrom-Json
    $config.main = Join-Path $RepoRoot 'workers/api/src/index.ts'
    $config.assets.directory = Join-Path $RepoRoot 'dist'
    $config.vars = @{ STORAGE_MODE = 'local'; AUTOMATION_ENABLED = 'false' }
    $config.PSObject.Properties.Remove('triggers')
    $configFile = Join-Path $runtimeHome 'wrangler.json'
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText((Join-Path $runtimeHome '.dev.vars'), "API_TOKEN=`"$token`"`n", (New-Object Text.UTF8Encoding $false))
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $out = Join-Path $runtimeHome "logs/$stamp.stdout.log"
    $err = Join-Path $runtimeHome "logs/$stamp.stderr.log"
    $cli = Join-Path $RepoRoot 'node_modules/wrangler/bin/wrangler.js'
    $state = Join-Path $runtimeHome 'state'
    $arguments = @("`"$cli`"", 'dev', '--config', "`"$configFile`"", '--local', '--ip', '127.0.0.1', '--port', '8787', '--inspector-ip', '127.0.0.1', '--inspector-port', '9230', '--persist-to', "`"$state`"", '--show-interactive-dev-session=false')
    $previousEnvironment = @{}
    $runtimeEnvironment = @{
        X_LOCAL_EXPLORER = 'false'; X_LOCAL_OBSERVABILITY = 'false'
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'; CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false'
        WRANGLER_SEND_METRICS = 'false'; WRANGLER_SEND_ERROR_REPORTS = 'false'
    }
    try {
        foreach ($key in $runtimeEnvironment.Keys) {
            $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $runtimeEnvironment[$key], 'Process')
        }
        $child = Start-Process -FilePath (Get-Command node).Source -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    } finally {
        foreach ($key in $runtimeEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process') }
    }
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
    if (-not $live) { throw "Worker exited. See $err" }
    @{ pid = $child.Id; command_line = $live.CommandLine; created_at = $live.CreationDate.ToUniversalTime().ToString('o'); stdout = $out; stderr = $err; repo = $RepoRoot } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeHome 'process.json') -Encoding UTF8
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($child.HasExited) { break }
        try {
            $status = Invoke-RestMethod 'http://127.0.0.1:8787/api/status' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 2
            if ($status.storage_mode -eq 'local') { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { Stop-TurfProcess $runtimeHome; throw "Startup failed. See $err and $out" }
    Write-Output "TurfLab: http://127.0.0.1:8787 | local state: $state"
} finally { Pop-Location }
