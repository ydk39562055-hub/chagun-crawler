@echo off
chcp 65001 >nul
title Chagun Local Crawler
cd /d "%~dp0"
echo.
echo ====================================
echo   Chagun Local Crawler
echo   Do NOT close this window
echo   Stop: Ctrl + C
echo ====================================
echo.
powershell.exe -ExecutionPolicy Bypass -File "%~dp0local-runner.ps1"
echo.
echo === Stopped. Press any key to close ===
pause >nul
