@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   CharacterArc Web - Deploy
echo ========================================
echo.

set SERVER_IP=124.222.218.97
set SERVER_USER=ubuntu
set SERVER_PASS=000125Ljj
set SERVER_PORT=22

cd /d "%~dp0"

powershell -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" "%SERVER_IP%" "%SERVER_USER%" "%SERVER_PASS%" "%SERVER_PORT%"
if %errorlevel% neq 0 (
    echo ERROR: Deploy failed
    pause
    exit /b 1
)
pause
