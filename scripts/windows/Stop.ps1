param([string]$DataHome)
. (Join-Path $PSScriptRoot 'Common.ps1')
& (Join-Path $PSScriptRoot 'Stop-GitHubSync.ps1') -DataHome $DataHome
Stop-TurfProcess (Get-TurfHome $DataHome)
Write-Output 'TurfLab stopped. Persistent state was retained. Tailscale Serve settings were retained.'
