#!/usr/bin/env bash
# 发版：把打好的安装包 + 更新元数据传到 GitHub Releases，客户端就能自动更新。
#
# 用法：
#   GH_TOKEN=ghp_xxx bash publish-release.sh              # 用 package.json 的版本号，发 hk 和 l 两条通道
#   GH_TOKEN=ghp_xxx bash publish-release.sh 3.4.1        # 指定版本
#   GH_TOKEN=ghp_xxx bash publish-release.sh 3.4.1 hk     # 只发一条通道
#   bash publish-release.sh 3.4.1 --notes "改了记忆命中排序"
#
# token 也可以放在项目根的 .gh-token 文件里（已在 .gitignore 里排除）。
# PAT 权限只需要：Contents → Read and write（fine-grained token）。
set -euo pipefail

OWNER="l1307047595"
REPO="nova-studio-release"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  # 纯 shell 取版本号：不要用 python/node 读 $ROOT/package.json ——
  # $ROOT 是 MSYS 风格路径（/d/...），原生 Windows 程序不认，会报 No such file
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
fi
shift || true

NOTES="Nova Studio $VERSION"
CHANNELS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    hk|l) CHANNELS+=("$1"); shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done
[ ${#CHANNELS[@]} -eq 0 ] && CHANNELS=(hk l)

TOKEN="${GH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ROOT/.gh-token" ]; then
  TOKEN="$(tr -d '\r\n' < "$ROOT/.gh-token")"
fi
if [ -z "$TOKEN" ]; then
  echo "❌ 缺 token。两种给法："
  echo "   1) GH_TOKEN=ghp_xxx bash publish-release.sh $VERSION"
  echo "   2) 把 PAT 写进 $ROOT/.gh-token"
  exit 1
fi

API="https://api.github.com/repos/$OWNER/$REPO"
TAG="v$VERSION"

echo "== 仓库 $OWNER/$REPO  标签 $TAG  通道 ${CHANNELS[*]} =="

# 1) 取或建 release
RELEASE_ID="$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/releases/tags/$TAG" | python -c "import sys,json;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null || true)"

if [ -z "$RELEASE_ID" ]; then
  echo "  新建 release $TAG"
  RELEASE_ID="$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "$API/releases" \
    -d "$(python -c "
import json,sys
print(json.dumps({'tag_name': sys.argv[1], 'name': 'Nova Studio ' + sys.argv[2], 'body': sys.argv[3], 'draft': False, 'prerelease': False}))
" "$TAG" "$VERSION" "$NOTES")" \
    | python -c "import sys,json;d=json.load(sys.stdin);print(d.get('id','') or d.get('message',''))")"
else
  echo "  复用已有 release（id=$RELEASE_ID）"
fi

if ! [[ "$RELEASE_ID" =~ ^[0-9]+$ ]]; then
  echo "❌ 建 release 失败：$RELEASE_ID"
  exit 1
fi

if [ -n "${LOCALAPPDATA:-}" ]; then
  TMP_DIR="$LOCALAPPDATA/Temp/nova-release"   # Windows(git-bash)
else
  TMP_DIR="${TMPDIR:-/tmp}/nova-release"      # macOS / Linux
fi
mkdir -p "$TMP_DIR" 2>/dev/null || true

upload() {
  local file="$1"
  [ -f "$file" ] || { echo "  跳过（不存在）: $(basename "$file")"; return 0; }
  local name encoded native_file native_resp code
  name="$(basename "$file")"
  # curl 是原生 Windows 程序：① 读文件要 Windows 路径 ② -o /dev/null 在关掉 MSYS 路径转换的环境里会写失败（curl 退出码 23，
  # 表现为「文件其实传上去了，但脚本立刻死掉」）→ 一律写真实临时文件。
  native_file="$(cygpath -w "$file" 2>/dev/null || echo "$file")"
  native_resp="$(cygpath -w "$TMP_DIR/$name.json" 2>/dev/null || echo "$TMP_DIR/$name.json")"
  encoded="$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$name")"
  code="$(curl -s -o "$native_resp" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$native_file" \
    "https://uploads.github.com/repos/$OWNER/$REPO/releases/$RELEASE_ID/assets?name=$encoded" || echo '000')"
  case "$code" in
    201)
      local size
      size="$(python -c "import json,sys;print(round(json.load(open(sys.argv[1],encoding='utf-8')).get('size',0)/1048576,1))" "$native_resp" 2>/dev/null || echo '?')"
      echo "  上传 $name → 成功（${size} MB）"
      ;;
    422)
      echo "  上传 $name → 已存在，跳过（GitHub 不允许同名资产；要覆盖先在 Release 里删掉旧的）"
      ;;
    *)
      echo "  上传 $name → HTTP $code：$(head -c 200 "$native_resp" 2>/dev/null)"
      ;;
  esac
}

for CH in "${CHANNELS[@]}"; do
  if [ "$CH" = "hk" ]; then PREFIX="Nova-Studio-HK"; else PREFIX="Nova-Studio-L"; fi
  echo "== 通道 $CH（$PREFIX）=="
  # 注意：electron-builder 的更新清单名就是「通道名.yml」（不是 latest-<通道>.yml），
  # 客户端按 app-update.yml 里的 channel 去找同名文件，名字错一位就永远收不到更新。
  upload "$ROOT/release/$PREFIX-$VERSION-win-x64.exe"
  upload "$ROOT/release/$PREFIX-$VERSION-win-x64.exe.blockmap"
  upload "$ROOT/release/$CH.yml"
  # mac 版产物（在 Mac 上用 build-mac.sh 打出来后一起传；没有就自动跳过）
  # 注意 mac 的清单叫「通道名-mac.yml」，客户端在 mac 上找的是这个文件名。
  for ARCH in arm64 x64; do
    upload "$ROOT/release/$PREFIX-$VERSION-mac-$ARCH.dmg"
    upload "$ROOT/release/$PREFIX-$VERSION-mac-$ARCH.zip"
  done
  upload "$ROOT/release/$CH-mac.yml"
done

echo
echo "== 回读核对（不只信退出码）=="
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/releases/tags/$TAG" | python -c "
import sys, json
d = json.load(sys.stdin)
assets = d.get('assets') or []
print(f\"  release {d.get('tag_name')} | 资产 {len(assets)} 个\")
for a in sorted(assets, key=lambda x: x['name']):
    print(f\"    - {a['name']:52s} {a['size']/1048576:8.2f} MB\")
missing = [n for n in ('hk.yml', 'l.yml') if n not in [a['name'] for a in assets]]
if missing:
    print('  ⚠️ 缺少清单文件:', ', '.join(missing), '（缺了客户端收不到更新）')
else:
    print('  ✅ 两个通道的清单都在')
"
echo
echo "客户端启动后会自动检查并提示更新；校验地址：https://github.com/$OWNER/$REPO/releases/tag/$TAG"
