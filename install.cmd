@echo off
rem Vault Gantt installer: double-click or run "install" from this folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\updater\Quick-Install.ps1" %*
set VG_EXIT=%ERRORLEVEL%
pause
exit /b %VG_EXIT%
