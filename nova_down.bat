@echo off
chcp 65001 >nul
echo 正在停止 Nova Image Studio (nova-image-studio\backend\server.js)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*nova-image-studio*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('已停止 PID ' + $_.ProcessId) }"
echo 完成。
pause
