@echo off
chcp 65001 >nul
REM 静默启动（由 启动Nova.vbs 以隐藏窗口调用，不会出现黑窗口）
cd /d "%~dp0backend"

if not exist data mkdir data
if not exist nova-images mkdir nova-images
if not exist logs mkdir logs

REM NODE_ENV 必须在 node 启动前设置：server.js 第 7 行早于 .env 解析就 require('next')
set NODE_ENV=production
set PORT=3111
REM 覆盖 Windows 预设的 HOSTNAME=计算机名，否则会绑到内网 IP 而不是回环
set HOSTNAME=127.0.0.1

node server.js >> "logs\server.log" 2>&1
