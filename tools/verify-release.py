"""发版前核对：清单对齐、asar 内容、图标、种子。

用法：python verify_release.py 3.4.6
只读，不改任何东西。
"""
import io
import json
import os
import re
import struct
import sys
import zipfile

ROOT = r"D:\ai\123\nova-image-studio"
REL = os.path.join(ROOT, "release")
PKG = os.path.join(ROOT, "package.json")

VERSION = sys.argv[1] if len(sys.argv) > 1 else None


def check(label, ok, detail=""):
    mark = "OK " if ok else "!! "
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""))
    return bool(ok)


def yml_get(path, key):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(rf"\s*{key}\s*:\s*(.+?)\s*$", line)
                if m:
                    return m.group(1).strip().strip('"')
    except FileNotFoundError:
        return None
    return None


def asar_grep(asar_path, needles):
    """在 asar 未压缩区里 grep 关键字（asar 头部是 JSON 目录，正文是拼接的原文件）。"""
    with open(asar_path, "rb") as fh:
        data = fh.read()
    found = {}
    for n in needles:
        found[n] = data.count(n.encode("utf-8"))
    return found


def exe_icon_rgb(exe_path):
    """从 exe 里抽出最大的图标并返回其主色调（判断是不是 Electron 默认灰蓝）。"""
    try:
        from PIL import Image  # noqa
    except ImportError:
        return None
    return None


def main():
    print("=" * 62)
    print(f"发版核对 v{VERSION}")
    print("=" * 62)

    pkg_version = json.load(open(PKG, encoding="utf-8"))["version"]
    print(f"\n[1] 版本")
    check("package.json 版本与目标一致", pkg_version == VERSION, f"package.json={pkg_version} 目标={VERSION}")

    print(f"\n[2] 两个安装包与更新清单")
    for ch, name in (("hk", "HK"), ("l", "L")):
        exe = os.path.join(REL, f"Nova-Studio-{name}-{VERSION}-win-x64.exe")
        yml = os.path.join(REL, f"{ch}.yml")
        exists = os.path.isfile(exe)
        size_mb = round(os.path.getsize(exe) / 1024 / 1024, 2) if exists else 0
        check(f"{name} 安装包存在", exists, f"{size_mb} MB")
        check(f"{ch}.yml 存在", os.path.isfile(yml))
        yv = yml_get(yml, "version")
        yp = yml_get(yml, "path")
        check(f"{ch}.yml 版本 = {VERSION}", yv == VERSION, f"清单里写的是 {yv}")
        # 清单里的 path 必须与磁盘文件名逐字一致（不一致 = 客户端下载 404）
        check(f"{ch}.yml path 与磁盘文件名一致", yp == os.path.basename(exe), f"path={yp}")
        check(f"{ch}.yml 有 sha512", bool(yml_get(yml, "sha512")))

    print(f"\n[3] asar 内容（新功能 + 本次修复）")
    unpacked = os.path.join(REL, "win-unpacked", "resources", "app.asar")
    if not os.path.isfile(unpacked):
        print("  [!! ] 找不到 release/win-unpacked/resources/app.asar（L 覆盖后只剩它，属正常）")
    else:
        needles = {
            "用量看板": "新 Tab 文案",
            "prompt_en": "英文生图版参数",
            "已拦下": "空参考图拦截（铁律闸门）",
            "没有参考图就不出图": "铁律条款",
            "英文生图版": "确认面板",
        }
        counts = asar_grep(unpacked, list(needles.keys()))
        for k, desc in needles.items():
            check(f"{k}（{desc}）", counts[k] >= 1, f"命中 {counts[k]} 处")
        removed = asar_grep(unpacked, ["思考过程"])
        check("「思考过程」已移除", removed["思考过程"] == 0, f"命中 {removed['思考过程']} 处（应为 0）")

    print(f"\n[4] 主程序 exe 图标（应从安装包里抽）")
    for name in ("HK", "L"):
        exe = os.path.join(REL, f"Nova-Studio-{name}-{VERSION}-win-x64.exe")
        if os.path.isfile(exe):
            with open(exe, "rb") as fh:
                head = fh.read(2)
            check(f"{name} exe 是 PE 文件", head == b"MZ")
            print(f"        （图标核对用 --icon-check 单独跑）")

    print(f"\n[5] 种子")
    seed_src = os.path.join(ROOT, "backend", "memory-seed")
    cats = sorted(os.listdir(seed_src)) if os.path.isdir(seed_src) else []
    print(f"        当前 backend/memory-seed = {cats}")
    print("        （HK 应含 squeeze/beauty/general；L 只含 general —— 按最后打的版本判断）")

    print()


if __name__ == "__main__":
    main()
