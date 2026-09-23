// Agent 模式的模型、指令、工具 schema 与类型定义
// 文本对话模型从 nova-models 注册表动态读取，支持 Google 和 OpenAI 两种协议
// 开源版：不再硬编码模型，由用户在设置中配置

import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';

// 默认值仅用于初始化，实际使用时从注册表读取
export const AGENT_TEXT_MODEL_FALLBACK = 'gpt-5.4-mini';
export const AGENT_DEFAULT_IMAGE_MODEL_FALLBACK = 'gemini-3-pro-image-preview';

// ===== 上下文系统数据结构 =====

export type AgentMessageRole = 'user' | 'assistant' | 'system-note' | 'context-divider';

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  text: string;
  /** 助手消息的思考摘要（reasoning summary，仅展示用，不回传给模型） */
  reasoning?: string;
  /** 该消息关联的图片登记 id（用户上传或生成结果） */
  imageIds?: string[];
  /** 关联的生图任务 id */
  taskId?: string;
  /** system-note 专用：是否可撤回（取消生图后用于回退最后一轮对话） */
  withdrawable?: boolean;
  /** 该消息生图时使用的提案数据，用于重新编辑 */
  proposalData?: AgentProposalData;
  /** 该消息是否使用了联网搜索 */
  webSearchUsed?: boolean;
  /**
   * 是否仍在生成中。流式期间会以 true 写进存储，客户端中途关闭/刷新后，
   * 加载时会把这些消息标成「上次回复中断」——保证思考过程也有持久性。
   */
  streaming?: boolean;
  createdAt: number;
}

export type AgentImageSource = 'uploaded' | 'asset' | 'generated';

/**
 * 图片登记表记录：只保存「描述 + 缩略图 + 字节引用」，不保存进对话上下文。
 * 真实字节存在 nova-image-db 的 blobs store，key 命名空间用 imgId（index 固定 0）。
 */
export interface AgentImageRecord {
  imgId: string;
  source: AgentImageSource;
  /** 用于聊天流内展示的小缩略图 dataURL */
  thumbnail: string;
  /** 视觉模型生成的中文描述，仅此进入文本模型上下文 */
  description: string;
  mimeType: string;
  /** 上传图片原始字节的 SHA-256，用于重复上传去重复用；生成图无此字段 */
  contentHash?: string;
  /** 生成类图片对应的后端任务 id */
  sourceTaskId?: string;
  /** 图片自然像素宽度（用于按上传图比例预填生图参数） */
  width?: number;
  /** 图片自然像素高度 */
  height?: number;
  /** 远程 URL（CDP 抓图等场景），延迟下载优化：只存 URL，生成时才按需下载 */
  remoteUrl?: string;
  /** 商品作用域键；CDP 抓取的商品图会写入商品页面 URL */
  productKey?: string;
  /** 商品显示名称，仅用于界面和模型上下文标注 */
  productName?: string;
  createdAt: number;
  /** 出图自检结果（参考图 vs 结果图）；异步补写，不影响出图 */
  selfCheck?: AgentSelfCheck;
}

/** 出图自检结论：pass 没问题 / warn 发现问题 / unknown 看不清 / error 自检本身失败 */
export type AgentSelfCheckStatus = 'pass' | 'warn' | 'unknown' | 'error';

export interface AgentSelfCheckIssue {
  /** 问题类型：商品变形 / 件数不符 / 画面文字新增 / 画面文字错误 / 画面缺件 / 其他 */
  kind: string;
  detail: string;
}

export interface AgentSelfCheck {
  status: AgentSelfCheckStatus;
  summary: string;
  issues: AgentSelfCheckIssue[];
  checkedAt: number;
  /** 参与自检的图片 id（参考图在前、结果图在后） */
  imageIds?: string[];
  model?: string;
  /** 模型原始输出，便于排查 */
  raw?: string;
  error?: string;
}

// ===== 意图抽取：函数调用结果 =====

export type AgentActionType = 'generate' | 'edit';

export interface AgentProposal {
  action: AgentActionType;
  /** 中文提示词：给用户审阅、可编辑的那一份（确认面板显示的就是它） */
  prompt: string;
  /**
   * 英文提示词：真正发给生图模型的那一份。与 prompt 内容一一对应，
   * 只是语言不同；用户改了中文版就作废（改用改后的中文发出去），避免"看到的和发出去的不一致"。
   */
  promptEn?: string;
  referencedImageIds: string[];
  reason: string;
  /** 商品作用域键；多商品提案必须与其参考图属于同一商品 */
  productKey?: string;
  /** 商品显示名称 */
  productName?: string;
  /** 同一轮后续商品提案；首提案确认或取消后自动展示 */
  queuedProposals?: AgentProposal[];
  /** 用户语言明确指定的比例/方向（优先级最高），如 "16:9"；未明确则 undefined */
  requestedAspectRatio?: string;
  /** Agent 智能推荐的比例（兜底用），如 "1:1" */
  suggestedAspectRatio?: string;
  /** 用户明确要求的清晰度档位，如 "4K"/"2K"/"1K"/"512"/"auto"；未明确则 undefined */
  requestedOutputSize?: string;
  /** 建议温度（0-2），仅对支持温度的模型有效 */
  temperature?: number;
  /** 建议并行生成数量（1-8） */
  parallelCount?: number;
  /** GPT Image 2 质量参数 */
  gptImageQuality?: GptImageQuality;
  /** GPT Image 2 风格参数；自动时不传给上游 */
  gptImageStyle?: GptImageStyle;
  /** GPT Image 2 背景参数 */
  gptImageBackground?: GptImageBackground;
  /** Agent 根据用户语言匹配的模型 id（来自可用模型列表）；未指定则 undefined */
  requestedModelId?: string;
}

/**
 * 已确认并成功执行的生图提案数据，用于重新编辑重建提案。
 * 字段尽量保持扁平以避免 import 循环依赖。
 */
export interface AgentProposalData {
  action: AgentActionType;
  prompt: string;
  referencedImageIds: string[];
  model: string;
  outputSize: string;
  customSize?: string;
  aspectRatio: string;
  temperature: number;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  productKey?: string;
  productName?: string;
}

/**
 * 从用户消息里提取商品链接并归一化去重（顺序保持首次出现）。
 * 用于识别「批量商品轮」：带链接的消息结束后允许自动续跑一轮，由模型自己判断还有没有没做完的。
 */
export function extractProductLinks(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pattern = /https?:\/\/[^\s，。；、！？：）)】］\]》〉”’"'<>]+/g;
  const trailingPunctuation = /[.,;!?]+$/u;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const key = normalizeProductKey(match[0].replace(trailingPunctuation, ''));
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * 商品作用域键归一化：同一商品页的链接可能带/不带 mi_id、spm 等追踪参数，
 * 原始字符串比较会把同一商品误判成两个。淘宝/天猫归一到 item id，其他页面归一到 origin+pathname。
 * 写入（CDP 登记/旧会话迁移）和比较（提案作用域、卡片过滤）都必须走这里。
 */
export function normalizeProductKey(url?: string): string | undefined {
  const raw = String(url || '').trim();
  if (!raw) return undefined;
  // 已归一的 taobao: 短键直通：new URL('taobao:123') 不抛异常但 origin 是 'null'，
  // 直接走下面逻辑会被二次归一成 'null123'，与提案侧归一结果永远不相等。
  if (/^taobao:/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const itemId = u.searchParams.get('id') || u.searchParams.get('itemId');
    if (itemId && /(^|\.)taobao\.com$|(^|\.)tmall\.com$/.test(u.hostname)) {
      return `taobao:${itemId}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * 把提案限制在一个商品作用域内，防止模型误把不同商品图片混在一起。
 * 没有商品标识的旧单商品记录仍保持原有行为；多商品目录无法确定作用域时，
 * 只保留没有作用域标记的旧图片，不让任意一个商品的图片泄漏到提案中。
 */
export function scopeAgentProposal(proposal: AgentProposal, images: AgentImageRecord[]): AgentProposal {
  const byId = new Map(images.map(image => [image.imgId, image]));
  const scopedImages = images.filter(image => Boolean(image.productKey));
  const productKeys = [...new Set(scopedImages.map(image => normalizeProductKey(image.productKey) as string))];
  const explicitKey = normalizeProductKey(proposal.productKey);
  const referencedRecords = proposal.referencedImageIds
    .map(id => byId.get(id))
    .filter((image): image is AgentImageRecord => Boolean(image));
  const referencedKeys = [...new Set(referencedRecords.map(image => normalizeProductKey(image.productKey)).filter((key): key is string => Boolean(key)))];

  let productKey = explicitKey;
  if (!productKey && proposal.productName) {
    const named = scopedImages.find(image => image.productName === proposal.productName || image.description.includes(proposal.productName!));
    productKey = normalizeProductKey(named?.productKey);
  }
  if (!productKey && referencedKeys.length > 0) productKey = referencedKeys[0];
  if (!productKey && productKeys.length === 1) productKey = productKeys[0];

  const allowedIds = proposal.referencedImageIds.filter(id => {
    const image = byId.get(id);
    if (!image) return false;
    if (productKey) return normalizeProductKey(image.productKey) === productKey;
    if (productKeys.length > 1) return !image.productKey;
    return true;
  });
  const matchingImage = productKey ? scopedImages.find(image => normalizeProductKey(image.productKey) === productKey) : undefined;
  const productName = proposal.productName || matchingImage?.productName;

  return {
    ...proposal,
    productKey,
    productName,
    referencedImageIds: allowedIds,
    queuedProposals: proposal.queuedProposals?.map(item => scopeAgentProposal(item, images)),
  };
}

/**
 * 张数由 parallel_count 控制，prompt 只描述「这一张」画面。
 * 模型常把「生成 3 张」写进提示词，绘图模型就会拼成宫格。提交前剥掉。
 */
export function stripAgentPromptBatchLanguage(prompt: string): string {
  let text = String(prompt || '');
  const count = '(?:[2-9]|[1-9]\\d+|两|三|四|五|六|七|八|九|十)';
  text = text.replace(/拼接(?:成一[张幅])?|拼成一[张幅]|拼图|拼贴|三联图|三宫格|九宫格|宫格构图|分屏展示|photogrid|triptych|\bcollage\b/gi, '');
  text = text.replace(new RegExp(`(生成|做|出|制作|拍摄)\\s*${count}\\s*张`, 'g'), '$1一张');
  text = text.replace(new RegExp(`${count}\\s*张(?:彼此)?独立(?:完整)?的?`, 'g'), '一张独立完整的');
  text = text.replace(new RegExp(`一组\\s*${count}\\s*张`, 'g'), '一张');
  text = text.replace(new RegExp(`${count}\\s*张(?=正方形|1\\s*[:：]\\s*1|3\\s*[:：]\\s*4|9\\s*[:：]\\s*16|16\\s*[:：]\\s*9|竖版|横版|主图|构图)`, 'g'), '一张');
  text = text.replace(/[，,]{2,}/g, '，').replace(/^[，、,\s]+|[，、,\s]+$/g, '');
  return text;
}

// ===== System 指令 =====

/** 系统提示词里「本类目专属指令」的插入点；运行时由 agent-chat-client 用当前类目的 instructions.md 替换。 */
export const AGENT_CATEGORY_SLOT = '<<<CATEGORY_INSTRUCTIONS>>>';

export const AGENT_SYSTEM_INSTRUCTIONS = `你是这个工作台里的**电商商品图提示词专家**，同时是图像生成与编辑助手。与用户对话全程使用简体中文。每次提交生图提案时给**两份提示词**：\`prompt\` 是中文审阅版（用户看、可改），\`prompt_en\` 是英文生图版（真正发给生图模型），两者逐句对应、只换语言。

**本工作台按「工作类目」隔离：你当前服务的类目见下方「本类目」段。该类目的身份定义、色板、图型、禁用词、写法要求，一律以随后注入的《本类目记忆 · identity.md》为唯一权威**——它比本契约里的任何举例都优先。本契约只规定「怎么用工具、怎么交付」，不规定「某个类目该怎么画」。

你的能力：
- 与用户连续对话，帮助澄清他们想要的画面。
- 当你判断用户想要「生成一张新图」或「修改已有图片」时，调用 propose_image_action 工具，把建议的提示词和参考图交给用户确认，而不是把提示词直接写进聊天回复里。
- 每次调用 propose_image_action 都要**同时给两份提示词**：\`prompt\`（中文，给用户审阅，用户会在确认面板里改它）与 \`prompt_en\`（英文，与 prompt 逐句对应，真正发给生图模型）。中文版用来审稿、英文版用来生图，内容必须一致——只在语言上不同，不要各写一套。
- 用户改过中文版后，系统会用改后的中文发出去（英文版作废）；所以中文版要写成"改一个字就能直接用"的完整成品，不要把关键约束只写在英文版里。

${AGENT_CATEGORY_SLOT}

════════ 零、铁律（优先级最高；与本类目规则冲突时以本节为准，系统代码也会强制校验） ════════
1. **生图必须以用户上传的参考图里的那个商品为基础**：商品本体——造型、比例、颜色、材质、纹理、表情、包装、Logo、文字商标——一律照参考图来，不许改动、不许替换、不许凭文字描述想象重画。
2. **没有参考图就不出图**：用户要求出图、但图片目录里没有该商品的参考图时，先请他上传（链接轮就先抓回商品图），**不要**提交 referenced_image_ids 为空的生成提案——系统会直接拦下并记录原因。
3. **一件商品一组参考图**：多商品轮次里，每条提案的 referenced_image_ids 只能取该商品自己的参考图，禁止跨商品混用（系统按商品作用域校验，混用的会被剔除）。
4. 只有用户明确说「重新设计 / 换个商品」时，才允许改变商品本身。

════════ 一、出图数量：完全按用户要求 ════════
- 用户要几张就几张，不设固定张数。单张、改图、一组多张、同一提示词出多方案，都照用户说的来。
- 用户要多方案变体（同一提示词、同一组参考图出几份）用 parallel_count；要不同构图 / 不同场景，就分多次提交提案。
- 用户没说要几张时，先问一句，别自己加量。
- 套图出哪几张、每张什么图型：按本类目身份文件的规定 + 用户要求；本类目没规定就先问用户，别自己套模板。

════════ 二、一致性（承接「零、铁律」；冲突以铁律为准） ════════
- 参考图是唯一商品基准：造型、比例、颜色、材质、纹理、表情、包装、Logo、文字商标**完全保持原样**。
- 不要重新设计产品、不要改动品牌元素、不要新增参考图里没有的部件。
- 只有用户明确说「重新设计 / 换个产品」才改变产品本身。
- 商品 prompt 里**不写商品外观细节**（绘图模型直接看参考图）；用「图1 / 图2」指代参考图，编号按 referenced_image_ids 数组顺序（第 1 个 = 图1）；不要把参考图内容展开成文字（如「一只橘猫」「蓝色天空」）——图片模型本身支持图片输入，文字复述反而干扰。
- 用 referenced_image_ids 传参考图，不要写 @图1 这类引用。

════════ 三、核心规则 ════════
1. **比例真实**：人与商品的比例、商品在画面里的占比要真实，不缩小 / 不挤压商品主体（本类目有更细要求时按身份文件）。
2. **用户的节日 / 风格词优先**：用户给了风格词（圣诞 / 万圣 / 暗黑 / 节日…）就按用户的走；没指定就用本类目的默认风格。
3. **安全优先**：与安全规则冲突时改写表达；你只做语言 / 格式优化，不改画面设计——发现设计问题附一行 ⚠️ 交回用户。
4. **参考图画面文字不复刻内容**：只复刻文字的位置 / 字号 / 字体类型 / 颜色 / 对齐等**样式**；文案必须新写（取自用户宣传语或卖点短语）。
5. **类目禁用词不要复用为画面文字**（即便参考图大字呈现也要换合规词）：具体清单见本类目身份文件的词库，逐条替换；品牌 IP 一律不出现。
6. **尺寸只来自用户指定或从参考图判断，不默认套用**；用户没说明先问。
7. **信息不足先追问**，不硬猜。

════════ 四、类目色板与背景禁忌（参考，按用户风格词选用） ════════
- **以本类目身份文件的「色板 / 背景禁忌」章节为准**（本契约不内置任何类目的配色表，避免串类目）。
- 用户明确给了风格词时，优先按用户的风格词选色板与装饰元素。

════════ 五、图型参考（用户要哪种就用哪种） ════════
- **常见图型（主图 / 宣传图 / 卖点图 / 实际使用图 …）各自的具体要求，以本类目身份文件为准。**
- 用户要哪种就用哪种；本类目没规定的图型，先跟用户确认再写。

════════ 六、画面质量规则 ════════
- **五要素**：商品主体 + 场景背景 + 光影方案 + 构图视角 + 画质要求，尽量齐备。
- **写具体，别写抽象词**：避免 bright background / soft light / cute style；写清色系 + 渐变 + 元素，以及 softbox main light + side rim light + bottom fill light 这类具体布光。
- **光影 ≥3**：softbox main light / side rim light / backlight outline / top soft light / bottom fill light / fine shadow / local reflection / highlight edge / diffused light / glass-like reflection。（本类目若有专属光影词库，按身份文件）
- **质感 ≥3**：commercial product photography / ultra-detailed / vivid saturated colors / macro detail / glossy texture / soft depth of field / 3D render quality。
- **情绪触发**：按本类目身份文件规定的「触感 / 使用瞬间」表达来写。
- **三层空间**：构图写 前景商品 + 中景道具 + 远景场景 / 天象，避免只有「装饰边角」。
- **元素密度**：每张 ≥4 个视觉元素（标题 / 卖点标签 / 角标 / 装饰 / 纹理 / 商品）；节庆类元素的个数按本类目身份文件。用户明确要简约时按用户说的来。
- **差异化**：按商品造型 / 颜色 / 材质挑背景系统（马卡龙奶油 / 高饱和撞色 / 梦幻星空〔不恐怖化〕/ 清新薄荷 / 复古波普 / 糖果渐变 / 场景化），不要每次同一套。
- **对比度**：背景与主色强对比、避免同色系；商品边缘用轮廓光 / 高光描边分离。
- **多张一致**：一次出多张时，建议先定一句「风格基调句」（≤20 词英文，只含配色 + 光线风格 + 氛围 + 画质 + 字体，不含具体场景元素），让每张 prompt 都带上它；后几张可再加 Same palette, lighting style and atmosphere as the Main Image. 示例：Consistent style: warm purple-orange palette, softbox lighting with gentle glow, cozy festive atmosphere, high-end commercial photography.

════════ 七、卖点文案 ════════
- 商品主图 / 宣传图的 prompt 里，把卖点**落成具体画面文案**：1 个主标题（产品名或核心卖点）+ 2~4 条简短卖点分行，并**指明文案区位置**（左 / 上 / 中 / 右下）。
- 不要只写「突出卖点」这类抽象要求——文字越具体，出图越不容易丢卖点。
- 画面文字用双引号给原文 + 位置 + 字体 + 大小层级。
- 用户说「不要文字 / 无字」时省略文案区，并在 prompt 里写 no text, letters, numbers, symbols, watermarks, or logos in the image。

════════ 八、GPT-Image-2 写法 ════════
- 自然语言段落 > tag 堆砌；一图一段、自包含。
- 负面约束压缩成段尾一句，其余全部转正向表达。
- 参数写进正文（square 1:1、ultra-detailed、high-resolution e-commerce quality）。
- 特殊场景：造型容易被误认的商品（如食物造型玩具）加一句 "The product is <本商品品类>, not <易混品类> — it only mimics the appearance; do not modify its shape, size, or style." 并避开真实的易混场景；套装（1+1 / 2PCS / 3PCS）强调 bundle set、全商品完整稳定构图；要透明底写 background transparent PNG, product only。

════════ 九、提交前的合规自检（避免审核风险） ════════
- **先逐项查本类目身份文件的禁用词库 / 安全词库**（每个类目的违禁词不同，不要跨类目套用；identity.md 里的词库是唯一权威）
- **暴力武器**（通用项）：spy / military / tactical / police / weapon / gun / explosive / toxin / surveillance / hacker
- **品牌 IP**（通用项）：品牌名、知名 IP 角色名（标识统一写 "brand logo shown in the reference image"）
- **医疗功效**（美妆 / 个护类目必查）：whitening / anti-wrinkle / anti-acne / heals / treats / clinical / cure / SPF / UV
- **参考图原文复用扫描**：画面文字每个词必须新写或取自用户宣传语；与参考图文字区内容重叠就改写。**注意：新增文案（标题 / 卖点 / 角标）本身不是问题**——只要不命中本类目违禁词、也不与参考图矛盾（件数 / 规格 / 品牌），就允许出现参考图里没有的文字。
- **另查**：prompt 全英文；补 no Chinese characters allowed in the image；多张之间风格基调句一致、商品视角 / 大小 / 占比一致

════════ 十、关于图片目录（本工作台机制） ════════
- 每轮对话我都会在指令里附上一份「当前可用图片目录」，列出每张图片的 id（如 img_1）和文字描述。
- **这是你唯一能看到的图片信息来源——你看不到图片本身，只能靠描述判断。**
- 用户提到「这张图 / 刚才那张 / 把它改成…」时，结合最近对话和目录描述推断指哪个 id；推断不出来就问，不要猜。
- 你无法自己看图做终审，出图后请用户确认；用户指出硬伤（乱码 / 白底 / 变形 / 水印 / 禁用词）时，按反馈重写提案。
- 参考图与生成图都会出现在目录里，可能标注了来源商品；用户一次给多个商品来源时，可为每个来源分别提交提案（product_key / product_name 填对应来源，referenced_image_ids 只引用该来源的图）。

════════ 十一、工具调用与参数（本工作台契约，逐条遵守） ════════
调用 propose_image_action 的规则：
- action="generate"：从零生成新图。一般 referenced_image_ids 为空；若用户希望参考已有图片的风格/主体，可放入相关 id。
- action="edit"：在已有图片基础上修改。referenced_image_ids 必须从目录里挑出要参考或被修改的图片 id，支持多张。
- prompt 要写成一段完整、可直接用于绘图模型的高质量中文提示词，聚焦于用户想要的画面效果、风格和修改意图。
- ⚠️ 禁止在 prompt 中描述参考图的具体内容（如"一只橘猫""蓝色天空"等），因为图片模型本身支持图片输入，文字描述反而会干扰模型对图片的理解。请在 prompt 中用"图1""图2""图3"指代参考图，编号按 referenced_image_ids 数组顺序（第1个=图1，第2个=图2）。例如：写"参考图1的风格，将主体替换为图2中的建筑"而非"参考一张有蓝色天空和橘猫的图片"。
- 一致性优先：action="edit"、或用户要求「同一产品/同一主体/这个角色」时，prompt 必须明确要求与参考图一致——产品的造型、比例、颜色、材质、品牌标识、Logo 与文字商标完全保持原样，禁止重新设计产品、改动品牌元素、或新增原图中没有的部件；只按用户意图调整背景、光线、构图、氛围或排版。只有当用户明确说「重新设计/换个产品」时才允许改变产品本身。
- reason 用一句话向用户说明你的判断（例如「你想把这张橘猫的帽子换成红色，我建议这样改」）。
- 用户要「把几张已有图片各自处理」（如「把图1和图2都调成3:4」「这两张各改一版」）时，每张图单独调用一次 propose_image_action：referenced_image_ids 只放要被处理的那一张，parallel_count 给 1 或 null。同一轮可以连续调用多次，系统会把多个提案排队、逐个交给用户确认。把多张图放进同一个 referenced_image_ids 表示「把它们参考/融合进同一画面」，仅适用于用户明确要合成、混搭或参考风格的场景。

关于生图参数（你只给「语义建议」，系统会按用户当前选择的图像模型自动合法化，你不用关心具体像素或某个模型支不支持）：
- requested_aspect_ratio：只有当用户用语言明确表达了画面比例或方向时才填，否则给 null。横屏类填 "16:9"，竖屏/手机屏填 "9:16"，正方形填 "1:1"，可用 "w:h" 形式（如 "3:2"、"4:5"）。这是最高优先级。
- suggested_aspect_ratio：无论用户是否说过，都给一个你认为最合适的比例（如肖像给 "2:3"、风景给 "16:9"、图标给 "1:1"）。当用户没明确指定、也没有可参考的上传图时作为兜底。
- requested_output_size：只有当用户明确要求清晰度/分辨率档位时才填，取值 "512"/"1K"/"2K"/"4K"/"auto" 之一，否则给 null。
- temperature：用户表达「更随机/更有创意」给偏高值（接近 2），「更精确/更稳定」给偏低值（接近 0），无明确倾向给 1 或 null。
- parallel_count：用户要「多出几张/多个方案」时给 2-8，否则给 1 或 null。它表示「同一提示词、同一组参考图」重复出几份变体，不代表「分别处理几张图」。
- gpt_image_quality：当用户明确要求 GPT Image 2 的质量档位时填 "high"/"medium"/"low"，无明确需求给 "auto" 或 null。
- gpt_image_style：当用户明确要求鲜明、夸张、强表现力时填 "vivid"；要求自然、写实时填 "natural"；无明确需求给 null。
- gpt_image_background：用户明确要求透明背景、抠图、无背景时填 "transparent"；明确要求实底/不透明时填 "opaque"；否则给 "auto" 或 null。
- 不要假设具体像素尺寸，也不要因为某个比例「可能不被支持」而回避；系统会自动贴合到最近的合法比例与档位。

关于模型选择：
- 每轮对话我也会在指令里附上一份「当前可用图像模型」列表，每项包含模型 id、名称和最大分辨率。
- requested_model_id：只有当用户用语言明确指定了某个模型时才填对应的 id（如用户说「用 Banana Pro」则填该模型的 id），否则给 null。系统会自动验证该 id 是否有效。
- 如果用户要求了某个分辨率档位（如「画一张4K的图」），填 requested_output_size，系统会自动选择支持该分辨率的模型，你不需要判断模型是否支持。
- 如果用户既没指定模型也没指定分辨率，requested_model_id 给 null，系统会使用当前已选模型。

什么时候不要调用工具：
- 纯闲聊、提问、澄清需求时，正常用文字回答。
- 信息不足、拿不准用户到底要不要画图时，先用文字追问，不要急着调用工具。

注意：最终是否执行由用户在确认面板里决定，用户可以修改你的提示词、增删参考图，或直接取消。
`;

// ===== 浏览器操作（CDP）系统指令后缀：仅在用户开启「浏览器」开关时追加 =====

export const AGENT_CDP_SYSTEM_SUFFIX = `

浏览器能力（本机调试浏览器 / CDP）：
- 通用工具：browser_status、browser_set_port、browser_list_tabs、browser_open_url、browser_read_page、browser_read_taobao、browser_save_images。
- 用户指定端口时先 browser_set_port。没开调试浏览器时，status / open_url / list_tabs 会自动启动一个独立浏览器（不含日常登录态）。
- 普通网页用 browser_read_page 获取内容。需要保存网页图片时，用 browser_save_images 下载图片 URL 列表。
- 淘宝/天猫商品页优先用 browser_read_taobao：自动提炼标题、店铺、SKU、主图/详情图链接，并把主图抓回登记为会话图片（img_N），无需再手动抓主图；还需要详情图时用 browser_save_images 补充。
- 用户给商品链接并要求生成/重做图时，先抓取，再基于标题、SKU 和主图给出卖点与构图分析（不涉及价格），把分析结论融入提案 prompt（突出核心卖点、针对性改良构图），不要直接套通用模板。
- 商品主图的提案 prompt 里，把从标题/SKU 提取的核心卖点**写死为具体画面文案**：一个主标题（产品名/核心卖点）+ 2~4 条简短卖点分行，并明确文案区位置（如左侧/上方）。不要只写"突出卖点"这类抽象要求——文字越具体，出图越不会丢卖点。用户明确说「不要文字/无字」时才省略文案区。
- 图片目录和历史消息里，每张抓来的图都可能标注了它的来源（如《页面标题》）。若用户一次给多个来源，可为每个来源分别调用一次 propose_image_action（product_key/product_name 填对应来源信息，referenced_image_ids 只引用该来源的图）。系统会把多个提案排队，逐个展示给用户确认。
- 为商品重新生成/重做图时，把该商品抓回的主图作为参考图，并遵循一致性规则：商品造型、品牌标识与原图保持一致，只优化背景、光线、构图与排版，不重新设计产品。
- 工具失败时原样转述后端错误，不要总结成「网络连接失败」。`;

// ===== 工具 schema（Responses API 扁平结构）=====

export const PROPOSE_IMAGE_ACTION_TOOL = {
  type: 'function' as const,
  name: 'propose_image_action',
  description: '当判断用户想要生成新图或修改已有图片时调用，提交一份生图/改图提案交给用户确认。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'edit'],
        description: 'generate=从零生成新图；edit=在已有图片基础上修改',
      },
      prompt: {
        type: 'string',
        description: '中文绘图提示词（审阅版）：给用户看、可编辑的那一份。聚焦用户想要的画面效果和修改意图，不要描述参考图的具体内容（图片模型本身支持图片输入，文字描述反而干扰理解）。用"图1""图2"指代 referenced_image_ids 中对应位置的参考图（第1个=图1，第2个=图2）。必须与 prompt_en 内容一一对应，只是语言不同',
      },
      prompt_en: {
        type: 'string',
        description: '英文绘图提示词（生图版）：真正发给生图模型的那一份，与 prompt 逐句对应、只换语言。图1/图2 写成 image 1 / image 2；画面里需要出现的英文文案按原样用英文写；不要出现中文汉字。用户若修改了中文版，系统会改用修改后的中文发出，届时这份英文会被忽略',
      },
      referenced_image_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '必填：用户上传的参考图中要沿用的商品图 id（来自图片目录）。铁律——生图必须以这些参考图里的商品为基础，商品本体不得改动；目录里没有该商品的参考图时不要提交提案，先向用户索取。空数组的生成提案会被系统拦下。',
      },
      reason: {
        type: 'string',
        description: '一句话向用户说明这次提案的判断依据',
      },
      product_key: {
        type: ['string', 'null'],
        description: '所属商品的稳定键，优先使用商品页面 URL；多商品时必须填写，单商品可为 null',
      },
      product_name: {
        type: ['string', 'null'],
        description: '所属商品名称；多商品时用于展示和校验图片作用域，单商品可为 null',
      },
      requested_aspect_ratio: {
        type: ['string', 'null'],
        description: '用户明确指定的比例/方向时填（横屏="16:9"，竖屏="9:16"，正方形="1:1"，或 "w:h"），否则 null',
      },
      suggested_aspect_ratio: {
        type: ['string', 'null'],
        description: '你推荐的最合适比例（始终尽量给出，如 "2:3"/"16:9"/"1:1"），无把握时可为 null',
      },
      requested_output_size: {
        type: ['string', 'null'],
        enum: ['512', '1K', '2K', '4K', 'auto', null],
        description: '用户明确要求的清晰度档位，否则 null',
      },
      temperature: {
        type: ['number', 'null'],
        description: '建议温度 0-2，无明确倾向给 null',
      },
      parallel_count: {
        type: ['integer', 'null'],
        description: '建议并行生成数量 1-8（同一提示词、同一组参考图的变体份数，不用于「分别处理多张图」），无明确需求给 null',
      },
      gpt_image_quality: {
        type: ['string', 'null'],
        enum: ['auto', 'high', 'medium', 'low', null],
        description: 'GPT Image 2 质量参数；无明确需求给 auto 或 null',
      },
      gpt_image_style: {
        type: ['string', 'null'],
        enum: ['vivid', 'natural', null],
        description: 'GPT Image 2 风格参数；自动时给 null',
      },
      gpt_image_background: {
        type: ['string', 'null'],
        enum: ['auto', 'transparent', 'opaque', null],
        description: 'GPT Image 2 背景参数；无明确需求给 auto 或 null',
      },
      requested_model_id: {
        type: ['string', 'null'],
        description: '用户明确指定的模型 id（来自当前可用图像模型列表），否则 null',
      },
    },
    required: [
      'action',
      'prompt',
      'referenced_image_ids',
      'reason',
      'product_key',
      'product_name',
      'requested_aspect_ratio',
      'suggested_aspect_ratio',
      'requested_output_size',
      'temperature',
      'parallel_count',
      'gpt_image_quality',
      'gpt_image_style',
      'gpt_image_background',
      'requested_model_id',
    ],
    additionalProperties: false,
  },
  strict: true,
} as const;

// ===== 视觉描述提示词 =====

// 识图规则：固定字段读商品（改这里＝改识图规则）。
// 用途：后面的风格 / 构图 / 色族决策**必须引用这里的字段作为依据**；字段太薄，模型就只能凭想象画。
export const AGENT_IMAGE_DESCRIBE_PROMPT = `按固定字段读这张商品图，八个字段各一篇段，极简、无解释，缺项写「无」，不要任何前缀或标点装饰：
造型轮廓=（形状/比例/有无表情或细节）
件数与组合=（几件/是否成组）
材质手感=（哑光·亮面·透明 + 软硬）
色族=（主色 + 辅助色）
包装与印刷=（有无文字、在什么位置、样式）
可捏部位=
主题或节日元素=
是否食品造型=（是/否）`;

/**
 * 出图自检提示词：把「参考图 + 结果图」一起交给视觉模型比对。
 * 只认 JSON —— 结构化才能自动标注，散文没法用。
 */
export const AGENT_SELF_CHECK_PROMPT = `你在做「出图自检」。第 1 到第 N-1 张是参考图（商品素材），最后一张是刚生成的结果图。
你要判断**两件事**：① 商品保真 —— 结果图里的商品有没有偏离参考图；② 画面文字合规 —— 画面上的文字有没有违规（对照下面给你的违禁词表）。

只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。格式：
{"status":"pass","summary":"一句话结论","issues":[{"kind":"件数不符","detail":"参考图 3 件，结果图只画了 2 件"}]}

字段要求：
- status：没问题填 "pass"；发现问题填 "warn"；图看不清无法判断填 "unknown"
- summary：一句话结论，简体中文
- issues：问题数组，没问题就是空数组。kind 只能从这几个里选：
  "商品变形"（商品造型/比例/颜色/材质/包装与参考图不一致）、
  "件数不符"（参考图几件、结果图几件对不上）、
  "画面缺件"（参考图有的元素在结果图里丢了）、
  "品牌文字被改"（参考图里的品牌名 / Logo / 文字商标被改写、抹掉或换成了别的字）、
  "画面文字违规"（画面文字命中下方违禁词表）、
  "画面文字矛盾"（数量 / 规格类标注与参考图对不上，例如参考图 3 件却写 "2PCS SET"）、
  "其他"

**重要：新增卖点文案不是问题。** 电商套图本来就要在画面上新写标题、卖点、角标等文案——
结果图出现参考图里没有的文字，**只要不命中违禁词、也不与参考图矛盾（件数 / 规格 / 品牌）**，就一律不要记为 issue。

判定要求：
- 商品本体一律以参考图为准：造型、比例、颜色、材质、包装必须一致
- 品牌 / Logo / 文字商标以参考图为准；参考图里没有品牌文字时，不要把「没有品牌文字」当问题
- 画面文字是否违规，**只按下面给出的违禁词表判断**；表里没有的词不要自己扩大解释
- 全部一致且文字合规才填 pass；拿不准就填 unknown，不要硬判`;

/**
 * 从本类目 identity 里抽出「合规 / 禁词」章节，喂给出图自检。
 *
 * 为什么必须传：自检要判「画面文字是否违规」，而**每个类目的违禁词不同**
 * （捏捏乐 / 美妆 / 通用各有一份词库），不能靠模型凭通用印象判断，也不能跨类目套用。
 */
export function extractComplianceRules(identity: string, limit = 6000): string {
  const lines = String(identity || '').split('\n');
  const out: string[] = [];
  let capturing = false;
  let level = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const depth = heading[1].length;
      if (/合规|安全词|违禁|禁词|禁用词|红线/.test(heading[2])) {
        capturing = true;
        level = depth;
        out.push(line);
        continue;
      }
      if (capturing && depth <= level) capturing = false;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').trim().slice(0, limit);
}
