@echo off
chcp 65001 >nul
cd /d "%~dp0backend"

if not exist data mkdir data
if not exist nova-images mkdir nova-images

REM NODE_ENV 必须在 node 启动前设置：server.js 第 7 行早于 .env 解析就 require('next')
set NODE_ENV=production
set PORT=3111
REM 覆盖 Windows 预设的 HOSTNAME=计算机名，否则会绑到内网 IP 而不是回环
set HOSTNAME=127.0.0.1

echo ==================================================
echo  Nova Image Studio
echo  http://127.0.0.1:3111/
echo  停止请按 Ctrl+C，或用 nova_down.bat
echo ==================================================
echo.
start "" http://127.0.0.1:3111/
node server.js
echo.
echo 服务已退出。
pause
