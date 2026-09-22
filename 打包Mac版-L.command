#!/usr/bin/env bash
# 双击这个文件 → 自动打「L 版（只带通用记忆种子）」的 mac 包。
# 第一次双击若提示没有执行权限，先在「终端」里跑一次：chmod +x "打包Mac版-L.command"
cd "$(dirname "$0")"
bash build-mac.sh l
echo
echo "（按回车关闭这个窗口）"
read -r _
