# Run independently of the prediction and settlement worker. An official feed
# adapter or operator places complete JSON card receipts in the inbox.
param(
    [Parameter(Mandatory)][string]$Inbox,
    [Parameter(Mandatory)][string]$Exchange
)
$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot '../python/forecast_lab/track_day_cli.py'
$failed = $false
foreach ($file in (Get-ChildItem -LiteralPath $Inbox -File -Filter '*.json' | Sort-Object Name)) {
    $processed = Join-Path $Inbox 'processed'
    try {
        & python $cli ingest --receipt $file.FullName --out $Exchange
        if ($LASTEXITCODE -ne 0) { throw "Track Day receipt exit code $LASTEXITCODE" }
        [void](New-Item -ItemType Directory -Path $processed -Force)
        Move-Item -LiteralPath $file.FullName -Destination (Join-Path $processed $file.Name)
    } catch {
        $failed = $true
        Write-Warning "$($file.Name): $($_.Exception.Message)"
    }
}
if ($failed) { exit 1 }
