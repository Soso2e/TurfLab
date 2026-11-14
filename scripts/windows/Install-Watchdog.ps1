# Re-runs the idempotent Start-AtLogon every 15 minutes so a server or worker
# that exits (e.g. overnight) is started again. Running instances are reused,
# never stopped. Remove with: Unregister-ScheduledTask -TaskName TurfLab-Watchdog
$ErrorActionPreference = 'Stop'
$name = 'TurfLab-Watchdog'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    throw "Task $name already exists. Inspect it before changing it."
}
$script = Join-Path $PSScriptRoot 'Start-AtLogon-Hidden.vbs'
$exe = Join-Path $env:SystemRoot 'System32/wscript.exe'
$action = New-ScheduledTaskAction -Execute $exe -Argument "//B //NoLogo `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Restart stopped local TurfLab services every 15 minutes (existing instances are reused).' | Out-Null
Write-Output "Installed $name."
