#!/usr/bin/env bash
# 在 macOS 上打 Nova Studio 的 mac 版安装包。
#
# 为什么必须在 Mac 上跑：dmg 依赖苹果的 hdiutil / codesign，Windows 上打不出来；
# 硬拼出来的 zip 里 .app 的可执行权限也是坏的，拿到 Mac 上打不开。
#
# 用法（项目根目录）：
#   bash build-mac.sh          # L 版（只带通用记忆种子）
#   bash build-mac.sh hk       # HK 版（带全部记忆种子）
#   双击「打包Mac版-L.command」也一样
#
# 产物在 release/：
#   Nova-Studio-L-<版本>-mac-arm64.dmg / -mac-x64.dmg    ← 给人装（苹果芯片 / Intel）
#   Nova-Studio-L-<版本>-mac-arm64.zip / -mac-x64.zip    ← 给自动更新用
#   l-mac.yml                                            ← 更新清单（连同上面文件一起上传）
set -euo pipefail
cd "$(dirname "$0")"

VARIANT="${1:-l}"
case "$VARIANT" in
  l)  PRODUCT="Nova Studio L";  APPID="com.novaimage.studio.l";  CHANNEL="l"; SEED="build-seeds/general" ;;
  hk) PRODUCT="Nova Studio HK"; APPID="com.novaimage.studio.hk"; CHANNEL="hk"; SEED="build-seeds/full" ;;
  *)  echo "用法: bash build-mac.sh [l|hk]"; exit 2 ;;
esac

echo "== 打 $PRODUCT（通道 $CHANNEL，种子 $SEED）=="

command -v node >/dev/null 2>&1 || {
  echo "❌ 没装 Node.js。先装：https://nodejs.org （选 LTS，20 以上）"
  exit 1
}
echo "  node $(node -v)   npm $(npm -v)"

# better-sqlite3 自带 darwin-arm64 / darwin-x64 预编译包，不需要 Xcode 或编译工具
if [ ! -d node_modules ]; then
  echo "== 装依赖（第一次几分钟）=="
  npm ci
fi

echo "== 放记忆种子 =="
rm -rf backend/memory-seed
cp -R "$SEED" backend/memory-seed
echo "  类目数：$(find backend/memory-seed -name agent.json | wc -l | tr -d ' ')"

echo "== 打包（arm64 + x64，未签名）=="
# CSC_IDENTITY_AUTO_DISCOVERY=false：本机没有开发者证书时别去找证书，直接出未签名包
CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:dist:mac -- --publish never --arm64 --x64 \
  -c.productName="$PRODUCT" \
  -c.appId="$APPID" \
  -c.publish.channel="$CHANNEL" \
  -c.mac.icon=build/icon.icns \
  -c.artifactName="$PRODUCT-\${version}-mac-\${arch}.\${ext}" \
  -c.mac.artifactName="$PRODUCT-\${version}-mac-\${arch}.\${ext}"

echo
echo "== 产物 =="
ls -la release/*mac-*.* release/"$CHANNEL"-mac.yml 2>/dev/null | awk '{printf "  %8.1f MB  %s\n", $5/1048576, $9}'
echo
echo "下一步：把这几个文件上传到 GitHub Release（见 Mac打包说明.md）。"
