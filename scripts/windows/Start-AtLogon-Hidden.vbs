Option Explicit

Dim shell, files, scriptPath, powershellPath
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "Start-AtLogon.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

WScript.Quit shell.Run("""" & powershellPath & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, True)
