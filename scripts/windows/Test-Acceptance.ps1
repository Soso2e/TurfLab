param([string]$BrowserPath)
. (Join-Path $PSScriptRoot 'Common.ps1')
if (Test-TurfPort 8787) { throw 'Stop the current server first. Acceptance never stops an unrelated server.' }
$testHome = Join-Path $env:LOCALAPPDATA ("TurfLab-acceptance-" + [guid]::NewGuid().ToString('N'))
$restoreHome = "$testHome-restore"
$savedAck = $env:TURFLAB_SMOKE_ACK
$savedBrowser = $env:SMOKE_BROWSER_PATH
if (-not $BrowserPath) {
    $BrowserPath = @("${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe", "$env:ProgramFiles/Microsoft/Edge/Application/msedge.exe") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
try {
    & (Join-Path $PSScriptRoot 'Start.ps1') -DataHome $testHome
    $env:TURFLAB_SMOKE_ACK = 'isolated-empty-local-storage'
    $env:SMOKE_BROWSER_PATH = $BrowserPath
    Push-Location $RepoRoot
    try {
        & npm.cmd run test:runtime
        if ($LASTEXITCODE -ne 0) { throw 'Runtime acceptance failed.' }
    } finally { Pop-Location }
    $beforeFile = & (Join-Path $PSScriptRoot 'Backup.ps1') -DataHome $testHome
    $before = Get-Content -LiteralPath $beforeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    & (Join-Path $PSScriptRoot 'Stop.ps1') -DataHome $testHome
    & (Join-Path $PSScriptRoot 'Start.ps1') -DataHome $testHome -SkipBuild
    $afterFile = & (Join-Path $PSScriptRoot 'Backup.ps1') -DataHome $testHome
    $after = Get-Content -LiteralPath $afterFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($before.hash -ne $after.hash -or
        ($before.counts | ConvertTo-Json -Compress) -ne ($after.counts | ConvertTo-Json -Compress)) {
        throw 'Restart changed the canonical backup hash/counts.'
    }
    & (Join-Path $PSScriptRoot 'Stop.ps1') -DataHome $testHome
    & (Join-Path $PSScriptRoot 'Start.ps1') -DataHome $restoreHome -SkipBuild
    & (Join-Path $PSScriptRoot 'Restore.ps1') -DataHome $restoreHome -BackupFile $beforeFile
    $restoredFile = & (Join-Path $PSScriptRoot 'Backup.ps1') -DataHome $restoreHome
    $restored = Get-Content -LiteralPath $restoredFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($before.hash -ne $restored.hash) { throw 'Restored backup hash mismatch.' }
    @{ windows = $true; restart_hash_match = $true; restore_hash_match = $true; counts = $after.counts; fixture_only = $true; iphone = 'unverified'; real_race = 'unverified' } |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $RepoRoot 'test-results/windows-restart-report.json') -Encoding UTF8
    Write-Output "PASS: Windows restart retained the canonical hash and all table counts. Test data: $testHome"
} finally {
    & (Join-Path $PSScriptRoot 'Stop.ps1') -DataHome $testHome
    & (Join-Path $PSScriptRoot 'Stop.ps1') -DataHome $restoreHome
    $env:TURFLAB_SMOKE_ACK = $savedAck
    $env:SMOKE_BROWSER_PATH = $savedBrowser
}
