$ErrorActionPreference = 'Stop'
$name = 'TurfLab-Logon'
if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { Write-Output 'Task is not installed.'; return }
Unregister-ScheduledTask -TaskName $name -Confirm:$false
Write-Output 'Removed TurfLab-Logon; running services and data were retained.'
