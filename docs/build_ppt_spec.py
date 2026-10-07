# -*- coding: utf-8 -*-
"""生成 Nova Studio 功能培训 PPT 的 JSON spec（深色科技风）。"""
import json

BG = "0E1116"
BAND = "161B24"
CARD = "1B2130"
ACC = "FE8210"      # 品牌橙
TXT = "E6ECF5"      # 正文
MUT = "C6D0DE"      # 次要（深色底 + 投影下小字仍清晰）
WHITE = "FFFFFF"
FONT = "Microsoft YaHei"

SEC_LABEL = {"m1": "模块一 · Agent 记忆", "m2": "模块二 · 提交自检",
             "m3": "模块三 · 在线套图", "home": "Nova Studio 功能培训"}


def line(text, size=16, color=TXT, bold=False, level=0):
    return {"text": text, "size": size, "color": color, "bold": bold,
            "level": level, "font": FONT}


def rail():
    """右侧品牌栏：深色竖条 + 顶部橙色段（平衡左侧文字列，避免右三分之空白）。"""
    return [
        {"type": "rectangle", "left": 12.78, "top": 0.96, "width": 0.55,
         "height": 6.28, "fill": CARD},
        {"type": "rectangle", "left": 12.78, "top": 0.96, "width": 0.55,
         "height": 1.1, "fill": ACC},
    ]


def pills(items, top=4.62):
    """一排要点块：分节页用它把下半页填起来，避免整页空洞。"""
    out = []
    n = len(items)
    gap = 0.15
    width = (12.1 - gap * (n - 1)) / n
    for i, text in enumerate(items):
        out.append({"type": "rounded_rectangle", "left": round(0.5 + i * (width + gap), 2),
                    "top": top, "width": round(width, 2), "height": 0.62,
                    "fill": CARD, "text": text, "text_color": MUT})
    return out


def deck_slide(section, idx, kicker, title, bullets, notes, chip):
    """统一版式：顶部面包屑带 + 橙色分隔线 + 右下角编号章 + 左侧文字列。"""
    bl = [line(kicker, 14, ACC, True), line(title, 30, WHITE, True), line("", 8, TXT)]
    bl += bullets
    return {
        "layout": "blank",
        "background": BG,
        "bullets": bl,
        "shapes": [
            {"type": "rectangle", "left": 0, "top": 0, "width": 13.333, "height": 0.9,
             "fill": BAND, "text": SEC_LABEL[section], "text_color": MUT},
            {"type": "rectangle", "left": 0, "top": 0.9, "width": 13.333, "height": 0.06,
             "fill": ACC},
            {"type": "rectangle", "left": 0, "top": 7.24, "width": 13.333, "height": 0.26,
             "fill": BAND},
            {"type": "rounded_rectangle", "left": 11.55, "top": 1.5, "width": 1.1,
             "height": 0.66, "fill": CARD, "text": chip, "text_color": ACC},
        ] + rail(),
        "notes": notes,
    }


slides = []

# ── 1 封面 ──────────────────────────────────────────────────────────────
slides.append({
    "layout": "blank", "background": BG,
    "bullets": [
        line("Nova Studio", 20, ACC, True),
        line("三个功能，一次讲清", 40, WHITE, True),
        line("Agent 记忆 · 提交自检 · 在线套图", 22, TXT),
        line("", 10, TXT),
        line("培训对象：运营 / 出图同事", 15, MUT),
        line("配套：装上 Nova Studio HK，三个类目已就绪", 15, MUT),
    ],
    "shapes": [
        {"type": "rectangle", "left": 0, "top": 3.02, "width": 6.4, "height": 0.07, "fill": ACC},
        {"type": "rectangle", "left": 0, "top": 0, "width": 13.333, "height": 0.9,
         "fill": BAND, "text": "Nova Studio 功能培训", "text_color": MUT},
        {"type": "rectangle", "left": 0, "top": 7.24, "width": 13.333, "height": 0.26, "fill": BAND},
        {"type": "rounded_rectangle", "left": 11.2, "top": 1.6, "width": 1.45, "height": 0.7,
         "fill": CARD, "text": "HK 版", "text_color": ACC},
    ] + rail(),
    "notes": "开场：今天只讲三件事——它怎么记住你的类目要求、出图前它自己会扫什么、以及一张商品图怎么变成一组套图。"
             "全程你们只要记两条动作：审中文稿、点确认记忆。",
})

# ── 2 目录 ──────────────────────────────────────────────────────────────
slides.append(deck_slide(
    "home", 2, "今天讲三件事", "它在替你做哪三件事",
    [
        line("一、Agent 记忆 —— 你的类目规则、踩过的坑、通过版案例，它记在本地并按需调用", 17),
        line("二、提交自检 —— 出图前它自己先扫：识图字段、判据推导、禁词与一致性", 17),
        line("三、在线套图 —— 一张参考图 → 中文稿给你审 → 英文稿给模型 → 逐张出图", 17),
        line("", 8, TXT),
        line("你只做两件事：审中文稿、点确认记忆", 16, ACC, True),
        line("其余（读图、推导、扫词、记账、沉淀）都由它自己跑", 14, MUT, level=1),
    ],
    "三个模块各 3～4 页。先讲记忆，因为后面两个模块都靠它。",
    "01"))

# ── 3 分节一 ────────────────────────────────────────────────────────────
slides.append({
    "layout": "blank", "background": BG,
    "bullets": [
        line("模块一", 18, ACC, True),
        line("Agent 记忆", 40, WHITE, True),
        line("它记得住，但不会自己乱记", 20, TXT),
    ],
    "shapes": [
        {"type": "rectangle", "left": 0, "top": 2.72, "width": 5.2, "height": 0.07, "fill": ACC},
        {"type": "rectangle", "left": 0, "top": 0, "width": 13.333, "height": 0.9,
         "fill": BAND, "text": "模块一 · Agent 记忆", "text_color": MUT},
        {"type": "rectangle", "left": 0, "top": 7.24, "width": 13.333, "height": 0.26, "fill": BAND},
        {"type": "rounded_rectangle", "left": 11.55, "top": 1.5, "width": 1.1,
         "height": 0.66, "fill": CARD, "text": "01", "text_color": ACC},
    ] + rail() + pills(['记忆结构', '读写时机', '写入判据', '面板·复盘', '类目隔离']),
    "notes": "先讲记忆，因为自检和套图都依赖它：记忆定的是「这个类目该怎么画」。",
})

# ── 4 记忆三层 ──────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m1", 4, "记忆结构", "记忆分三层，各管各的",
    [
        line("① 规则层 identity.md —— 你写（AI 只读）· 每轮全量注入", 17, TXT, True),
        line("类目身份、色板、图型、违禁词库、写法 —— 「这类商品该怎么画」", 14, MUT, level=1),
        line("② 采纳规则 R-0001… —— AI 提议 → 你采纳 · 带编号、可统计效力", 17, TXT, True),
        line("③ 条目层 feedback / library —— AI 起草 → 你确认 · 按命中选择性注入", 17, TXT, True),
        line("纠错（以后该怎么做）与通过版案例（做法 + 适用条件）", 14, MUT, level=1),
        line("④ 会话状态 sessions/<会话>.md —— 这一单做到哪一步，只在本会话注入", 17, TXT, True),
    ],
    "强调分层：常驻注入的只有规则层（稳定、小）；纠错和案例靠命中才进上下文，不会把上下文撑爆。",
    "02"))

# ── 5 读写时机 ──────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m1", 5, "关键规则", "什么时候读、什么时候写",
    [
        line("读记忆：只在两个时点 —— ① 会话开始　② 每次有新图上传", 18, TXT, True),
        line("对话进行中不读、不写（防止上下文漂移，规则换成脏的）", 14, MUT, level=1),
        line("写记忆：空闲 3 分钟且队列没有出图任务 → AI 起草 → 进「待确认」", 18, TXT, True),
        line("你不点确认，一个字都不落盘；驳回即丢弃，并进黑名单不再重复提", 14, MUT, level=1),
        line("", 8, TXT),
        line("所以：改了规则文件 → 下一次会话（或传新图）才生效", 16, ACC, True),
    ],
    "最容易踩的误会：在对话中途改了 memory 文件，期待它马上按新规则走 —— 不会。按设计，改动在下一个读点生效。",
    "03"))

# ── 6 写入判据 ──────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m1", 6, "写入判据", "什么才值得写进记忆",
    [
        line("三条硬判据（必须同时满足）", 17, ACC, True),
        line("① 可复用　② 有依据（你说的 / 出图出的）　③ 是经验，不是复述", 16),
        line("一律禁写", 17, ACC, True),
        line("提示词正文与画面描述 · 图内英文原文与品牌词 · 闲聊与推理 · 半截话", 16),
        line("代码侧还有一道硬门（不信任模型自律）", 17, ACC, True),
        line("太短/太长 · 半截话 · 英文占比 >50% · 没带标签 · 与已有记忆重复 → 直接丢", 16),
    ],
    "为什么要有这道门：早期心跳沉淀把「整段提示词」和「图里的英文文案」当成经验写进来了 —— 那不是记忆，是产物。"
    "现在提示词 + 代码两道过滤，不合格的直接丢，且会给出 filtered 计数便于观察。",
    "04"))

# ── 7 面板 / 上限 / 复盘 ────────────────────────────────────────────────
slides.append(deck_slide(
    "m1", 7, "你手上的入口", "记忆面板 · 上限保护 · 复盘",
    [
        line("「记忆」按钮：规则 / 纠错 / 案例 · 色板 / 规则建议 / 会话状态 五个页签", 17),
        line("可看、可改、可删；规则 AI 改不了，你改", 14, MUT, level=1),
        line("上限保护（超了会被挡，不是静默丢）", 17, ACC, True),
        line("单条 800 字符 · 命中注入 8 条 / 6000 字符 · 规则 32768 字符", 16),
        line("规则会退役 + 定期复盘", 17, ACC, True),
        line("复发 ≥3 次标「待修订」· 采纳满 14 天零引用标「待复核」", 16),
        line("累计新增 15 条 → 提醒复盘 → AI 起草该升级的规则 → 你采纳进规则", 16),
    ],
    "面板是你的巡检入口：每周花两分钟看一次「待修订 / 待复核」，比攒半年再翻要好。"
    "复盘的作用是让纠错升级成规则，否则 feedback 会无限膨胀。",
    "05"))

# ── 8 类目隔离 ──────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m1", 8, "隔离", "三个类目，三套独立记忆",
    [
        line("工作类目下拉框：捏捏乐 / 美妆 / 通用", 18, TXT, True),
        line("切类目 = 记忆 + 会话 + 对话记录整套切换，互不可见、没有公共层", 15, MUT, level=1),
        line("为什么不做公共层：各品类违禁词与红线本来就不同", 17),
        line("边界（谁不能做什么）", 17, ACC, True),
        line("AI 只读规则，改规则只能写「规则建议」等你采纳", 16),
        line("违禁词改动只能你手改，AI 不许动", 16),
    ],
    "如果发现「它没按新类目走」——先看下拉框是不是切过去了。三个类目各自的记忆目录完全不同。",
    "06"))

# ── 9 分节二 ────────────────────────────────────────────────────────────
slides.append({
    "layout": "blank", "background": BG,
    "bullets": [
        line("模块二", 18, ACC, True),
        line("提交自检", 40, WHITE, True),
        line("出图前它先自己扫三遍", 20, TXT),
    ],
    "shapes": [
        {"type": "rectangle", "left": 0, "top": 2.72, "width": 5.2, "height": 0.07, "fill": ACC},
        {"type": "rectangle", "left": 0, "top": 0, "width": 13.333, "height": 0.9,
         "fill": BAND, "text": "模块二 · 提交自检", "text_color": MUT},
        {"type": "rectangle", "left": 0, "top": 7.24, "width": 13.333, "height": 0.26, "fill": BAND},
        {"type": "rounded_rectangle", "left": 11.55, "top": 1.5, "width": 1.1,
         "height": 0.66, "fill": CARD, "text": "02", "text_color": ACC},
    ] + rail() + pills(['识图·判据', '铁律', '终审清单', '代码闸门']),
    "notes": "自检分三层：能不能画（识图 + 判据）、许不许画（铁律 + 合规）、画完扫一遍（终审）。",
})

# ── 10 识图 + 判据层 ────────────────────────────────────────────────────
slides.append(deck_slide(
    "m2", 10, "自检第一层", "先读懂商品，再谈画法",
    [
        line("识图八字段（每单第一步，缺字段不进下一步）", 17, ACC, True),
        line("造型轮廓 · 件数与组合 · 材质手感 · 色族 · 包装与印刷 · 可捏部位 · 主题元素 · 是否食品造型", 15),
        line("判据层六步（每步必须写明由什么推来）", 17, ACC, True),
        line("主张 → 视觉机制 → 骨架·机位 → 风格基调句 + 色族 → 文字与卖点 → 冲突检查", 16),
        line("五条硬约束", 17, ACC, True),
        line("必须有推导 · 禁无理由默认值 · 与最近 6 单至少 2 个轴不同 · 主张不许连撞 · 同一单内统一而骨架各异", 15),
    ],
    "这一层是防「每次都给同一套模板」。写不出推导的决策＝无效，要重做。近期记录只用于避让，不是复用源。",
    "07"))

# ── 11 铁律 ─────────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m2", 11, "自检第二层", "铁律：冲突时以它为准",
    [
        line("① 参考图即唯一基准 —— 商品造型/颜色/材质/包装一律照参考图，禁参考图外物品入画", 16),
        line("② 没有参考图就不出图 —— 不许凭文字编商品", 16),
        line("③ 一件商品一组参考图 —— 禁跨商品混用", 16),
        line("④ 只有你明确说「换商品」，才允许改商品本体", 16),
        line("⑤ 图内文字只复刻样式（位置/字号/字体），内容必须新写；禁用词必换合规词", 16),
        line("⑥ 比例与物理真实 —— 一手只捏一件；捏变形要像玩具，不得出现破损爆裂感", 16),
    ],
    "铁律是硬性拦截：空参考图的提案会被代码直接拦下并在对话里提示你「已拦下 N 条」，不是静默失败。",
    "08"))

# ── 12 终审 + 代码闸门 ──────────────────────────────────────────────────
slides.append(deck_slide(
    "m2", 12, "自检第三层", "终审清单：出图前最后一遍",
    [
        line("禁词逐词扫（命中即换合规词）", 17, ACC, True),
        line("暴力武器 · 儿童敏感 · 品牌 IP · 医疗功效 · 万圣恐怖分级 · 近似词 · 氛围组合 · 食品造型", 15),
        line("参考图原文复用扫描 —— 图内每个词必须新写，或取自你给的宣传语", 16),
        line("同一单内一致性 —— 共用同一条风格基调句；商品视角 / 占比一致", 16),
        line("另查 —— 全英文、`//` 仅结尾一处、补 no Chinese characters allowed", 16),
        line("代码闸门 —— 空参考图的提案一律拦下，并明确告诉你原因", 16, ACC, True),
    ],
    "禁词表按类目各写一份（美妆的红线与玩具不同），都在各类目的 identity.md 里，你可以直接改。",
    "09"))

# ── 13 分节三 ───────────────────────────────────────────────────────────
slides.append({
    "layout": "blank", "background": BG,
    "bullets": [
        line("模块三", 18, ACC, True),
        line("在线套图", 40, WHITE, True),
        line("一张参考图，一组套图", 20, TXT),
    ],
    "shapes": [
        {"type": "rectangle", "left": 0, "top": 2.72, "width": 5.2, "height": 0.07, "fill": ACC},
        {"type": "rectangle", "left": 0, "top": 0, "width": 13.333, "height": 0.9,
         "fill": BAND, "text": "模块三 · 在线套图", "text_color": MUT},
        {"type": "rectangle", "left": 0, "top": 7.24, "width": 13.333, "height": 0.26, "fill": BAND},
        {"type": "rounded_rectangle", "left": 11.55, "top": 1.5, "width": 1.1,
         "height": 0.66, "fill": CARD, "text": "03", "text_color": ACC},
    ] + rail() + pills(['六步流程', '中文审·英文出', '图生图', '张数按需']),
    "notes": "这一步是你日常打交道最多的：上传商品图 → 拿中文提示词稿 → 生图。",
})

# ── 14 套图六步 ─────────────────────────────────────────────────────────
slides.append(deck_slide(
    "m3", 14, "流程", "六步，不可跳步",
    [
        line("1 读图 —— 按八字段读你的商品图", 16),
        line("2 读记忆 —— 规则 + 命中的纠错/案例 + 最近 6 单记录（避让，不复用）", 16),
        line("3 定主张 → 跑判据层六步 + 五条硬约束自检", 16),
        line("4 出中文稿给你审 —— 你没 OK，不进下一步", 16, ACC, True),
        line("5 OK 后出英文（与中文逐句对应），再跑一次终审", 16),
        line("6 逐张生图 —— 重传参考图，不写 @图1", 16),
        line("", 8, TXT),
        line("张数与图型按你要：不预设固定图型、不写死张数", 15, MUT, True),
    ],
    "第 4 步是关键卡点：中文稿是给你审的，第 5 步的英文稿才是发给生图模型的。你改了中文稿，就以你改后的为准。",
    "10"))

# ── 15 约定 + 培训要点 ──────────────────────────────────────────────────
slides.append(deck_slide(
    "m3", 15, "约定与要点", "三条约定 + 三个不要",
    [
        line("中文稿给你审，英文稿发模型（两份逐句对应，只换语言）", 16, TXT, True),
        line("全程图生图：有参考图就走图生图接口，不是文生图", 16, TXT, True),
        line("张数按需 —— 要几张说几张；没说它按商品自己判断", 16, TXT, True),
        line("", 8, TXT),
        line("不要　指望对话中途改规则立即生效（下次读点才生效）", 15, MUT),
        line("不要　在图里要求参考图之外的东西（铁律会拦）", 15, MUT),
        line("不要　换商品了还沿用旧参考图（一件商品一组参考图）", 15, MUT),
    ],
    "收尾：你们只需要把关两处 —— 中文稿、记忆确认。其余的读图、推导、扫词、记账、沉淀都交给它。"
    "有拿不准的，先把商品图丢进去让它给方案，再判断。",
    "11"))

spec = {"slide_size": "16:9", "slides": slides}
out = r"D:\ai\123\nova-image-studio\docs\ppt-spec.json"
with open(out, "w", encoding="utf-8") as fh:
    json.dump(spec, fh, ensure_ascii=False, indent=1)
print("slides:", len(slides), "->", out)
