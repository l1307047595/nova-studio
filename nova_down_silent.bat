@echo off
chcp 65001 >nul
REM 静默停止（由 停止Nova.vbs 以隐藏窗口调用）；PowerShell 逻辑放在 nova_down_silent.ps1 里，避免 bat 引号地狱
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3111"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nova_down_silent.ps1" %PORT%
endlocal
