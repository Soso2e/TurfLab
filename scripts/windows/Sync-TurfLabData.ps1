param(
    [string]$DataRepo = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'TurfLab-data')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $DataRepo '.git'))) {
    throw "TurfLab-data checkout not found: $DataRepo"
}

$root = (& git -C $DataRepo rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or (Resolve-Path $root).Path -ne (Resolve-Path $DataRepo).Path) {
    throw "Invalid TurfLab-data Git checkout: $DataRepo"
}

$branch = (& git -C $DataRepo branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "TurfLab-data must be checked out on main before AI reads it (current: '$branch')."
}

$dirty = & git -C $DataRepo status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect TurfLab-data working tree.'
}
if ($dirty) {
    throw 'TurfLab-data working tree is not clean; refusing to overwrite local changes.'
}

& git -C $DataRepo fetch --prune origin main
if ($LASTEXITCODE -ne 0) {
    throw 'Could not fetch origin/main; do not read the local checkout.'
}

& git -C $DataRepo merge --ff-only origin/main
if ($LASTEXITCODE -ne 0) {
    throw 'Could not fast-forward to origin/main; do not read the local checkout.'
}

$sha = (& git -C $DataRepo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Could not verify synchronized commit SHA.'
}
$remoteSha = (& git -C $DataRepo rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -ne $remoteSha) {
    throw 'Local HEAD does not match origin/main; do not read the local checkout.'
}

Write-Output "TurfLab-data synchronized: branch=main sha=$sha path=$root"
