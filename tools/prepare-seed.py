"""打包前准备记忆种子：从 build-seeds/<variant> 生成 backend/memory-seed。

为什么需要这一步（都是真踩过的）：
1. 种子目录里会混进运行期垃圾 —— `identity.md.bak-<时间戳>`（应用改身份时的备份）、
   `pending.json`（未确认的草稿）等。它们会跟着安装包发给同事。✗
2. 滚动记录类文件（如 `recent.md` 「最近 6 单」）是**个人运营记性**，
   不能外发；但它被 identity.md 的固定工作流引用，**删了会读不到文件** ——
   所以只清空记录、保留模板头。✗→✓

只读 build-seeds，不改它；只写 backend/memory-seed。

用法：python tools/prepare-seed.py full     # HK 全量
      python tools/prepare-seed.py general  # L 仅通用
"""
import fnmatch
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 运行期垃圾：备份、临时、日志、未确认草稿、系统文件
JUNK_PATTERNS = [
    # 用 *.bak* 而不是 "*.bak"/"*.bak-*" —— 后者漏掉 .bak2-<时间戳> 这种命名
    # （踩过：备份文件跟着安装包发给了同事）
    "*.bak*", "*.orig", "*.tmp", "*.log", "*.old", "*~", "*.swp",
    ".DS_Store", "Thumbs.db",
    "pending.json",       # 待确认草稿，属于个人工作现场
    "pending.json.*",
]

# 滚动记录：保留模板头（# 开头、> 开头、空行），丢掉记录行
ROLLING_FILES = ["recent.md", "recent-*.md"]


def is_junk(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in JUNK_PATTERNS)


def is_rolling(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in ROLLING_FILES)


def clean_rolling(path: str) -> tuple[int, int]:
    """只留模板头（# 与 > 开头的行 + 空行），返回（原行数, 保留行数）。"""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    kept = [ln for ln in lines if ln.startswith("#") or ln.startswith(">") or ln.strip() == ""]
    # 去掉尾部多余空行
    while kept and kept[-1].strip() == "":
        kept.pop()
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(kept) + "\n")
    return len(lines), len(kept)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("full", "general"):
        print("用法: python tools/prepare-seed.py full|general")
        return 1
    variant = sys.argv[1]
    src = os.path.join(ROOT, "build-seeds", variant)
    dst = os.path.join(ROOT, "backend", "memory-seed")

    if not os.path.isdir(src):
        print(f"✗ 找不到种子源目录: {src}")
        return 1

    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    print(f"[种子] {variant} → backend/memory-seed")

    removed, blanks = [], []
    for base, _dirs, files in os.walk(dst):
        for name in files:
            path = os.path.join(base, name)
            rel = os.path.relpath(path, dst).replace("\\", "/")
            if is_junk(name):
                os.remove(path)
                removed.append(rel)
            elif is_rolling(name):
                before, after = clean_rolling(path)
                blanks.append(f"{rel}（{before} 行 → {after} 行）")

    for rel in sorted(removed):
        print(f"  ✗ 已剔除运行期垃圾: {rel}")
    for rel in sorted(blanks):
        print(f"  ✂ 已清空个人记录（保留模板）: {rel}")

    cats = sorted(os.listdir(dst))
    print(f"[种子] 类目 = {cats}")
    for cat in cats:
        files = sorted(os.listdir(os.path.join(dst, cat)))
        print(f"  {cat}: {files}")
    total = sum(len(fs) for _, _, fs in os.walk(dst))
    print(f"[种子] 文件总数 = {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
