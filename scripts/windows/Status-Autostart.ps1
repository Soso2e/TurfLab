$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'TurfLab-Logon' -ErrorAction SilentlyContinue
if (-not $task) { Write-Output 'TurfLab-Logon is not installed.'; return }
$task | Select-Object TaskName, State, Actions, Triggers | Format-List
Get-ScheduledTaskInfo -TaskName 'TurfLab-Logon' | Select-Object LastRunTime, LastTaskResult, NextRunTime | Format-List
Write-Output "Log: $env:LOCALAPPDATA\TurfLab\logs\logon-start.log"
