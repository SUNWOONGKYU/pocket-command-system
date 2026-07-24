@echo off
chcp 65001 >nul
echo PCSS 워커 업데이트를 시작합니다...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
