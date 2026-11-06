@echo off
chcp 65001 >nul
setlocal
title wb-fleet autostart installer

set "SCRIPT=%~dp0install-service.ps1"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] Administrator privileges required. Requesting elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%SCRIPT%" (
  echo [x] Missing file: %SCRIPT%
  pause
  exit /b 1
)

where pwsh >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action install
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action install
)

echo.
echo Done. Press any key to close.
pause >nul
