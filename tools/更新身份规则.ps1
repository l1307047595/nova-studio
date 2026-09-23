# 更新身份规则.ps1
#
# 作用：把本安装包附带的「身份规则」（identity.md）覆盖到本机活记忆里。
#
# 为什么要这一步：应用更新**不会改动你本机已有的记忆**（这是刻意设计 ——
# 身份 / 纠错 / 案例 / 近期记录都存在 %APPDATA%\<应用名>\memory，和安装目录分离，
# 所以更新不会丢你的数据）。代价是：新版带来的身份规则**不会自动覆盖**你已有的记忆。
# 想让新版身份规则立即生效，就跑一下本脚本。
#
# 本脚本【只换 identity.md】：
#   会动    ：<类目>\identity.md          （旧文件自动备份为 identity.md.bak-<时间戳>）
#   不会动  ：feedback.md（纠错）、library.md（案例）、recent.md（近期记录）、sessions/
#
# 用法：双击本文件（或在 PowerShell 里执行）。全新安装的机器不需要跑 ——
# 首次打开时记忆会自动从种子生成，那时就已经是新身份了。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$res        = $PSScriptRoot                                  # ...\<应用>\resources
$installDir = Split-Path -Parent $res
$seedRoot   = Join-Path $res 'memory-seed'

Write-Host ""
Write-Host "  Nova Studio 身份规则更新"
Write-Host "  ========================"
Write-Host ""

if (-not (Test-Path $seedRoot)) {
    Write-Host "  ✗ 没找到种子目录：$seedRoot"
    Write-Host "    请确认本脚本是从安装目录的 resources 文件夹里运行的。"
    Read-Host "  按回车关闭"; exit 1
}

# 从安装目录的主程序名推出应用名（决定活记忆的位置：%APPDATA%\<应用名>\memory）
$exe = Get-ChildItem -Path $installDir -Filter 'Nova Studio*.exe' -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -notlike '*Uninstall*' } | Select-Object -First 1
if ($exe) { $appName = [IO.Path]::GetFileNameWithoutExtension($exe.Name) }
else {
    $appName = Read-Host "  没能自动识别应用名，请手动输入（例如 Nova Studio L）"
}

$liveMem = Join-Path (Join-Path $env:APPDATA $appName) 'memory'

Write-Host "  应用    ：$appName"
Write-Host "  活记忆  ：$liveMem"
Write-Host "  种子    ：$seedRoot"
Write-Host ""

if (-not (Test-Path $liveMem)) {
    Write-Host "  本机还没有活记忆目录 —— 说明是全新安装。"
    Write-Host "  首次打开 Nova Studio 时，记忆会自动从本包种子生成，那时就已经是新身份了，"
    Write-Host "  不需要执行本脚本。"
    Write-Host ""
    Read-Host "  按回车关闭"; exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$done  = 0
foreach ($cat in Get-ChildItem -Path $seedRoot -Directory) {
    $src = Join-Path $cat.FullName 'identity.md'
    if (-not (Test-Path $src)) { continue }

    $catDir = Join-Path $liveMem $cat.Name
    if (-not (Test-Path $catDir)) {
        Write-Host ("  - 跳过 {0}（本机没有这个类目）" -f $cat.Name)
        continue
    }

    $dst = Join-Path $catDir 'identity.md'
    if (Test-Path $dst) {
        $bak = "$dst.bak-$stamp"
        Copy-Item $dst $bak -Force
        Write-Host ("  · 已备份旧文件 → {0}\identity.md.bak-{1}" -f $cat.Name, $stamp)
    }
    Copy-Item $src $dst -Force
    Write-Host ("  ✓ 已更新 {0}\identity.md  ({1} 字节)" -f $cat.Name, (Get-Item $dst).Length)
    $done++
}

Write-Host ""
if ($done -gt 0) {
    Write-Host "  完成：更新了 $done 个类目的身份规则。纠错 / 案例 / 近期记录都没有动。"
    Write-Host "  请重启 Nova Studio 生效。"
} else {
    Write-Host "  没有可更新的类目（本机活记忆里没有种子涵盖的类目）。"
}
Write-Host ""
Read-Host "  按回车关闭"
