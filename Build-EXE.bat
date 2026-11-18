@echo off
setlocal
cd /d "%~dp0"
title Build GitDigest EXE

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Install 64-bit Node.js 22 or newer, then try again.
    goto :failed
)
if not exist "node_modules\" (
    call npm.cmd ci
    if errorlevel 1 goto :failed
)

echo Building GitDigest portable app and installer...
if exist "build\rust-tools\env.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ". './build/rust-tools/env.ps1'; npm.cmd run build:desktop; exit $LASTEXITCODE"
) else (
    call npm.cmd run build:desktop
)
if errorlevel 1 goto :failed

echo.
echo Build complete:
echo %CD%\build\desktop-rust\GitDigest.exe
echo %CD%\build\desktop-rust\GitDigest-Windows-x64-Setup.exe
start "" explorer.exe "%CD%\build\desktop-rust"
pause
exit /b 0

:failed
echo.
echo Build failed. Check the error above.
pause
exit /b 1
