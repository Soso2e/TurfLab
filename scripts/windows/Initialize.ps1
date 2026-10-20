. (Join-Path $PSScriptRoot 'Common.ps1')
if ([int]((& node --version).TrimStart('v').Split('.')[0]) -lt 22) {
    throw 'Node.js 22+ is required.'
}
$vars = Join-Path $RepoRoot 'workers/api/.dev.vars'
if (-not (Test-Path -LiteralPath $vars)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($vars, "API_TOKEN=`"$key`"`n", (New-Object Text.UTF8Encoding $false))
}
$null = Get-TurfToken
Push-Location $RepoRoot
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'npm run check failed.' }
} finally { Pop-Location }
Write-Output 'Ready. API_TOKEN is in workers/api/.dev.vars (never print it to logs).'
