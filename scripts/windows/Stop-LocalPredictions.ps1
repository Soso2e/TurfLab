param([string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
Stop-TurfProcess (Join-Path (Get-TurfHome $DataHome) 'local-predictions/process')
