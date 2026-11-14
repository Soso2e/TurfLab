$ErrorActionPreference = 'Stop'
$name = 'TurfLab-Logon'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    throw "Task $name already exists. Inspect it before changing it."
}
$script = Join-Path $PSScriptRoot 'Start-AtLogon-Hidden.vbs'
$exe = Join-Path $env:SystemRoot 'System32/wscript.exe'
$action = New-ScheduledTaskAction -Execute $exe -Argument "//B //NoLogo `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Start local TurfLab and GitHub sync at user logon.' | Out-Null
Write-Output "Installed $name. Use Status-Autostart.ps1 to inspect it."
