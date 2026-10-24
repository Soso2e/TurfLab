@echo off
setlocal
cd /d "%~dp0"
echo.
echo [TurfLab] One-click Windows and Tailscale launcher
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-All.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
    echo.
    echo [TurfLab] Not fully ready. Read the error above.
    echo [TurfLab] The local server may still be running.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %RESULT%
