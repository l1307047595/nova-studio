# 静默停止 Nova：三条线索一起用（pid 文件 / 监听端口 / 命令行兜底）
param([int]$Port = 3111)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'nova.pid'

$pids = @()
if (Test-Path $pidFile) { $pids += (Get-Content $pidFile) }
$pids += (Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -ExpandProperty OwningProcess)
$pids += (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
          Where-Object { $_.CommandLine -like '*nova-image-studio*server.js*' } |
          Select-Object -ExpandProperty ProcessId)

$targets = $pids | Where-Object { $_ } | Sort-Object -Unique
foreach ($target in $targets) { Stop-Process -Id $target -Force }

Remove-Item $pidFile -ErrorAction SilentlyContinue

if ($targets) { Write-Output ("已停止 PID: " + ($targets -join ', ')) }
else { Write-Output '没有正在运行的 Nova 服务' }
