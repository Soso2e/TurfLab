param([Parameter(Mandatory = $true)][string]$BackupFile, [string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeHome = Get-TurfHome $DataHome
if (-not (Get-TurfProcess $runtimeHome)) { throw 'Start the empty local target before restoring.' }
$token = Get-TurfToken
# The existing API verifies hash, counts, references, and refuses nonempty targets.
$null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/restore' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token" } -InFile (Resolve-Path -LiteralPath $BackupFile).Path
Write-Output 'Restored to the empty target. Compare a new backup hash/counts before using it.'
