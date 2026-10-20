param([string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
if (-not (Get-TurfProcess $runtimeHome)) { throw 'Start TurfLab before taking a logical API backup.' }
$token = Get-TurfToken
$folder = Join-Path $runtimeHome 'backups'
$null = New-Item -ItemType Directory -Force -Path $folder
$path = Join-Path $folder ("turflab-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
# Preserve the response bytes (Unicode and numeric values) for canonical hashes.
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/backup' -Headers @{ Authorization = "Bearer $token" } -OutFile $path
Write-Output $path
