// 记忆沉淀器：空闲心跳触发（无进行中任务 + 3 分钟无新对话）
//
// 流程：把「自上次沉淀以来的对话记录」交给文本模型 → 模型只回一个 JSON
//   {"feedback":[...],"library":[...],"session":"..."}
// → 分别追加写入 feedback.md / library.md / sessions/<id>.md
//
// 只追加、不覆盖；identity（规则/违禁词）不在这里写——规则改动只能走 proposals.md 由人工确认。

import { buildSimpleProxyTextRequestBody, extractTextOutput } from '@/lib/nova-proxy-text';
import {
  appendMemoryEntry,
  getCurrentMemory,
  listPendingDrafts,
  queueMemoryDraft,
} from '@/lib/nova-memory';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

/**
 * 把已加载的类目规则里的「已采纳规则」抽成索引（### R-0001 标题），
 * 起草时给模型看编号，它才能把「复发」标出来 → 规则效力统计的输入。
 */
function buildRuleIndexBlock(): string {
  const identity = getCurrentMemory()?.identity || '';
  const rules: string[] = [];
  const re = /^###\s*(R-\d{4})\s*(.+)$/gm;
  let match: RegExpExecArray | null = re.exec(identity);
  while (match !== null) {
    rules.push(`- ${match[1]} ${match[2].trim()}`);
    match = re.exec(identity);
  }
  if (rules.length === 0) return '';
  return `\n\n【本类目已采纳的规则（带编号）】\n${rules.slice(0, 40).join('\n')}\n若本次纠错属于某条规则**复发**，请在该条末尾附上（复发：R-0007）。`;
}

/** 标签与复发的统一写法要求（三个起草指令共用） */
const TAG_RULES = `写法要求：
- 每条末尾必须带 2~4 个标签，维度固定为「商品类型 / 图型 / 风格色板 / 合规」，标签值自由（如 #捏捏乐 #主图 #圣诞红绿 #平台红线）。
- 标签放在同一条的最后，用空格分隔，不要单独一行、不要写进括号。
- 如果某条属于已采纳规则的复发，在标签前附上（复发：R-0007）。`;

export interface MemorySinkInput {
  apiKey: string;
  model: string;
  protocol: TextProviderProtocol;
  baseUrl: string;
  sessionId: string;
  transcript: string;
  /** 最后一条用户消息，用于 session 字段为空时兜底 */
  lastUserMessage?: string;
  /** 你驳回过、不要再重复提的条目 */
  rejectedTexts?: string[];
  /** 会话状态是否直接写入（默认否：也进待确认队列） */
  sessionAutoWrite?: boolean;
}

export interface MemorySinkResult {
  ok: boolean;
  feedback: number;
  library: number;
  proposals: number;
  /** 入队的「近期记录」条数 */
  recent: number;
  sessionWritten: boolean;
  /** 全部进待确认队列的条数（会话状态自动写入时不计入） */
  queued: number;
  /** 被写入判据挡掉、没有进队列的条数（模型写了但不合格） */
  filtered?: number;
  error?: string;
}

/**
 * 记忆写入判据（起草端与代码端共用同一套；改这里就够，不要在别处再写一份）。
 * 目的：把「复述这一单做了什么」挡在外面，只放「下次还用得上的经验」。
 */
const WRITE_RULES = `═══ 什么才值得写（判据，逐条对照）═══
一条要写进去，必须**同时**满足：
① 可复用：下次遇到同类商品/同类图型还会用到它；
② 有依据：能追溯到「用户明确说过的话」或「出图实际出过的问题」；
③ 是经验不是复述：讲的是「以后该怎么做 / 不该怎么做」，不是「这一单做了什么」。

一律禁写（写了算错）：
- 提示词正文、画面描述、构图细节（那是本次产物，不是经验。反例：「箔光点/柔焦金色光斑 + 琥珀色微光大理事台面」）
- 图里出现的英文文案原文、卖点短句、品牌词（那是素材，还带合规风险。反例：「ALL-IN-ONE GEL VENOM NAIL CAN | NOURISH, PROTECT, SHINE.」）
- 对话过程、AI 自己的推理、闲聊、参数试错过程
- 用户没说过、没有依据的「经验」（宁可给空数组）
- 半截话：以「（待补充）」「…」「等」结尾、或明显没写完的，一条都不要提

═══ 每条怎么写（固定模板，一条只讲一件事）═══
- feedback（纠错）：\`<以后该怎么做> —— <为什么 / 什么情况下适用>\`，一句话，≤80 字。
- library（案例与取值）：\`<通过版的做法或取值> —— <适用条件>\`，一句话，≤80 字。
  用中文描述做法（正例：「主图用高对比背景 + 商品居中，避免纯白底 —— 白底会被判成通用产品摄影域」）。
  **唯一允许写英文的情形**是「英文基调句」，且必须以 \`Consistent style:\` 开头并注明适用条件（如「适用于圣诞套图」）；其余任何英文原文一律不写。
- proposal（规则建议）：首行 = 规则标题；然后 \`- 标签：…\` / \`- 判据：…\` / \`- 规则：…\` / \`- 来源：…\`（写清依据哪几句话或哪几次单）。没写完就别提。
- session（会话状态）：\`<商品>：已出 <图型>；还差 <下一步>\`，已完成写 \`已完成：<商品>\`。

═══ 数量与自检（宁缺勿滥）═══
- 上限：feedback ≤ 2 条、library ≤ 2 条、proposals ≤ 1 条。没把握就给空数组。
- 提之前先在内部自检三问：① 这条是经验还是复述？② 下次什么情况会用到它？③ 依据是用户说的还是出图出的？
  有一问答不上来，就不要提。
- 不要与本类目已有条目重复；被驳回过的条目，换个说法也不要再提。`;

/**
 * 标签归一化：模型经常把标签写成「维度:值」（如 `商品类型:趾甲护理液 图型:主图/海报`），
 * 而命中打分与规则统计认的是 `#标签`。这里统一转回来，避免合格条目因为格式被误杀。
 */
export function normalizeDraftTags(rawText: string): string {
  return String(rawText || '')
    // 维度:值 → #值（值里用 / 、 , | 分隔的多项拆成多个标签）
    .replace(
      /(商品类型|图型|风格色板|合规|色板|场景)\s*[:：]\s*([^\s]+)/g,
      (_m, _dim, value: string) => value.split(/[、,，/|]+/).filter(Boolean).map(item => `#${item}`).join(' '),
    )
    .replace(/#\s*([^\s#]+)/g, (_m, value: string) => `#${String(value).replace(/[，。、；;,.]+$/, '')}`)
    .replace(/#{2,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 代码侧硬校验：不信任模型自律。
 * 起草端写得再严，模型仍可能漏；这里做最后一道过滤，不合格的直接丢掉（宁缺勿滥）。
 */
const DRAFT_BANNED = [
  /待补充/, /\(待/, /（待/, /未完成/, /TODO/i, /^\.\.\./, /嘛$/, /略$/,
];
/** 英文占比过高（且不是基调句）→ 视为「抄原文」，丢掉 */
function looksLikeRawEnglish(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < 12) return false;
  const ratio = letters / Math.max(1, text.length);
  if (ratio < 0.5) return false;
  return !/^Consistent style:/i.test(text.trim());
}
/** 是否是一条可写的草稿（传入前先过 normalizeDraftTags） */
export function isUsableDraft(kind: 'feedback' | 'library' | 'proposal' | 'session' | 'recent', rawText: string): boolean {
  // 近期记录是「记性」不是「经验」：不要求标签，但必须是字段式一句话（主张/骨架机位/色族）
  if (kind === 'recent') {
    const line = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (line.length < 12 || line.length > 260) return false;
    if (DRAFT_BANNED.some(re => re.test(line))) return false;
    return /主张\s*=|骨架|机位|色族/.test(line);
  }
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (text.length < 8) return false;
  if (kind !== 'proposal' && kind !== 'session' && text.length > 160) return false;  // 「一句话」不该这么长
  if (text.length > 600) return false;
  if (DRAFT_BANNED.some(re => re.test(text))) return false;
  if (looksLikeRawEnglish(text)) return false;
  // 规则/案例必须带标签：#标签 或「维度:值」都算（后者会被 normalizeDraftTags 转成 #标签）
  if ((kind === 'feedback' || kind === 'library')
    && !/#/.test(text) && !/(商品类型|图型|风格色板|合规|色板|场景)\s*[:：]/.test(text)) {
    return false;
  }
  return true;
}

/** 批内去重 + 与已有条目去重（归一化后比较，避免「换个标点重复提」） */
function normalizeForCompare(text: string): string {
  return String(text || '')
    .replace(/#[^\s#]+/g, '')                                   // 标签不参与比较
    .replace(/[\s，。、；：,.;:（）()「」【】\[\]\-—–－~～·…_!！?？"'“”‘’]/g, '')  // 各类标点与分隔符（破折号最容易漏）
    .toLowerCase();
}
export function dedupeDrafts(items: string[], existing: string[] = []): string[] {
  const seen = new Set(existing.map(normalizeForCompare).filter(item => item.length > 6));
  const out: string[] = [];
  for (const item of items) {
    const key = normalizeForCompare(item);
    if (key.length <= 6) continue;
    const duplicate = [...seen].some(prev => prev === key || (prev.length > 12 && key.length > 12 && (prev.includes(key) || key.includes(prev))));
    if (duplicate) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const SINK_INSTRUCTION = `你是商品图工作流的记忆沉淀器。下面是刚结束（或已空闲）的一段创作对话记录。
只输出一个 JSON，不要任何解释、前后缀、代码块标记：
{"feedback":["..."],"library":["..."],"proposals":["..."],"session":"...","recent":"..."}

字段含义：
- feedback：用户明确纠正过的点，或出图出过的硬伤。
- library：本次通过的方案要点，或新试出来的、可复用的取值。
- proposals：只有当出现「该改类目规则」的信号时才写（同一条纠错反复出现、某套色板/图型被验证稳定该升级进基础规则、违禁词或写法需要调整）。你只能提议，不能改规则本身。
- session：**必填，不能为空**（这一单做到哪一步）。
- recent：**近期记录**，只在这一单确实定了套图方向时写，格式固定一行：「主张=… | 骨架机位=… | 色族=…」（各 ≤20 字，不写提示词正文、不写画面细节）；没定方向就写空字符串。它只是「记性」，用来让下一次不撞车。

${WRITE_RULES}

${TAG_RULES}`;

/** session 为空时的兜底：用最后一条用户消息生成一句，避免会话状态永远不推进 */
function buildSessionFallback(lastUserMessage: string): string {
  const text = String(lastUserMessage || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `本轮进展（自动兜底）：${text.slice(0, 80)}`;
}

function parseSinkJson(text: string): { feedback: string[]; library: string[]; proposals: string[]; session: string; recent: string } | null {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      feedback?: unknown; library?: unknown; proposals?: unknown; session?: unknown; recent?: unknown;
    };
    const toStringArray = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5) : [];
    return {
      feedback: toStringArray(parsed.feedback),
      library: toStringArray(parsed.library),
      proposals: toStringArray(parsed.proposals),
      session: typeof parsed.session === 'string' ? parsed.session.trim() : '',
      recent: typeof parsed.recent === 'string' ? parsed.recent.trim() : '',
    };
  } catch {
    return null;
  }
}

export async function sinkAgentMemory(input: MemorySinkInput): Promise<MemorySinkResult> {
  const transcript = String(input.transcript || '').trim();
  const fail = (error: string): MemorySinkResult =>
    ({ ok: false, feedback: 0, library: 0, proposals: 0, recent: 0, sessionWritten: false, queued: 0, error });
  if (!transcript) return fail('没有可沉淀的内容');

  const rejected = (input.rejectedTexts || []).map(item => String(item || '').trim()).filter(Boolean).slice(-10);
  const rejectedBlock = rejected.length
    ? `\n\n【已被用户驳回的条目，不要再提，也不要把它们换个说法重提】\n${rejected.map(item => `- ${item}`).join('\n')}`
    : '';

  const body = buildSimpleProxyTextRequestBody(
    input.protocol,
    input.model,
    [{ type: 'text', text: `${SINK_INSTRUCTION}${rejectedBlock}${buildRuleIndexBlock()}\n\n---\n\n对话记录：\n${transcript.slice(0, 12000)}` }],
    { stream: false, reasoningEffort: 'low' },
  );

  try {
    const res = await fetch('/api/nova/proxy/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        stream: false,
        requestBody: body,
      }),
    });
    if (!res.ok) {
      return fail(`上游 HTTP ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const text = extractTextOutput(input.protocol, data);
    const parsed = parseSinkJson(text);
    if (!parsed) {
      return fail('模型未返回可解析的 JSON');
    }

    // 心跳只生成「草稿」放待确认队列：你不确认，一个字都不落盘
    // 过滤两道：① isUsableDraft 按判据硬扫（禁写项/半截话/英文原文/无标签）② 与待确认队列和本轮已注入记忆去重
    let existingBaseline: string[] = [];
    try {
      const pending = await listPendingDrafts();
      existingBaseline = (pending.items || []).map(item => String(item.text || ''));
    } catch {
      // 拿不到就当没有基线，不影响主流程
    }
    const injected = getCurrentMemory();
    if (injected) {
      existingBaseline = existingBaseline.concat(injected.feedbackHits || [], injected.libraryHits || []);
    }

    let filtered = 0;
    const clean = (kind: 'feedback' | 'library' | 'proposal' | 'session' | 'recent', items: string[]): string[] => {
      const usable = items
        .map(item => normalizeDraftTags(item))                     // 先把「维度:值」标签转成 #标签
        .filter(item => {
          const ok = isUsableDraft(kind, item);
          if (!ok) filtered += 1;
          return ok;
        });
      return dedupeDrafts(usable, existingBaseline);
    };

    const feedbackItems = clean('feedback', parsed.feedback);
    const libraryItems = clean('library', parsed.library);
    const proposalItems = clean('proposal', parsed.proposals);

    let feedbackCount = 0;
    let queued = 0;
    for (const item of feedbackItems) {
      const result = await queueMemoryDraft('feedback', item, { source: 'heartbeat', session: input.sessionId });
      if (result.ok) { feedbackCount += 1; queued += 1; }
    }
    let libraryCount = 0;
    for (const item of libraryItems) {
      const result = await queueMemoryDraft('library', item, { source: 'heartbeat', session: input.sessionId });
      if (result.ok) { libraryCount += 1; queued += 1; }
    }
    // 规则改动建议：进待确认队列，确认后才落到 proposals.md（永远不会直接改 identity.md）
    let proposalCount = 0;
    for (const item of proposalItems) {
      const result = await queueMemoryDraft('proposal', item, { source: 'heartbeat', session: input.sessionId });
      if (result.ok) { proposalCount += 1; queued += 1; }
    }
    // 近期记录：进待确认队列（你不确认就不落盘）；确认后写进滚动窗口，旧条目自动丢弃
    let recentCount = 0;
    for (const item of clean('recent', parsed.recent ? [parsed.recent] : [])) {
      const result = await queueMemoryDraft('recent', item, { source: 'heartbeat', session: input.sessionId });
      if (result.ok) { recentCount += 1; queued += 1; }
    }

    // 会话状态：默认也要你确认（进队列）；开了「自动写入」才直接落盘
    const rawSession = parsed.session || buildSessionFallback(input.lastUserMessage || '');
    const sessionText = rawSession && isUsableDraft('session', rawSession) ? rawSession : '';
    let sessionWritten = false;
    if (sessionText) {
      if (input.sessionAutoWrite) {
        const result = await appendMemoryEntry('session', sessionText, input.sessionId);
        sessionWritten = result.ok;
      } else {
        const result = await queueMemoryDraft('session', sessionText, { source: 'heartbeat', session: input.sessionId });
        if (result.ok) { sessionWritten = true; queued += 1; }
      }
    }
    return {
      ok: true, feedback: feedbackCount, library: libraryCount,
      proposals: proposalCount, recent: recentCount, sessionWritten, queued, filtered,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : '沉淀失败');
  }
}

/** 把最近的消息拼成给沉淀器看的对话记录。 */
export function buildSinkTranscript(
  messages: Array<{ role: string; text: string }>,
  limit = 40,
): string {
  const usable = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .filter(message => String(message.text || '').trim().length > 0)
    .slice(-limit);
  return usable
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${String(message.text).trim().slice(0, 800)}`)
    .join('\n\n');
}

// ===== AI 起草一条记忆（「记一条」按钮：AI 写、你审） =====

const DRAFT_INSTRUCTION = `你是商品图工作流的记忆提炼器。下面是一段创作对话记录。
请从对话里提炼出**一条**最值得记住的记忆，只输出一个 JSON，不要解释、不要代码块：
{"kind":"feedback","text":"..."}

kind 只能是这四种之一：
- feedback：用户明确纠正过的点，或出图出过的硬伤。
- library：本次通过的方案要点，或新试出来的、可复用的取值。
- recent：**近期记录** —— 这一单定下的套图方向，格式固定一行「主张=… | 骨架机位=… | 色族=…」（各 ≤20 字，不写提示词正文与画面细节）。只是「记性」，用来让下一单不撞车。
- proposal：该改类目规则的信号（同一条纠错反复出现、某色板/图型已验证稳定该升级进基础规则、违禁词或写法要调整）。

${WRITE_RULES}

${TAG_RULES}`;

export interface DraftMemoryNoteInput {
  apiKey: string;
  model: string;
  protocol: TextProviderProtocol;
  baseUrl: string;
  transcript: string;
  /** 用户当前选中的类型，作为倾向（模型可以改） */
  preferredKind?: 'feedback' | 'library' | 'proposal' | 'recent';
}

/** 让模型从对话里起草一条记忆，交给用户审。失败返回 null。 */
export async function draftMemoryNote(
  input: DraftMemoryNoteInput,
): Promise<{ kind: 'feedback' | 'library' | 'proposal' | 'recent'; text: string } | null> {
  const transcript = String(input.transcript || '').trim();
  if (!transcript) return null;
  const hint = input.preferredKind ? `\n\n（用户当前选的是 ${input.preferredKind}，如果对话内容更适合别的类型，就改成更合适的那个）` : '';
  const body = buildSimpleProxyTextRequestBody(
    input.protocol,
    input.model,
    [{ type: 'text', text: `${DRAFT_INSTRUCTION}${hint}\n\n---\n\n对话记录：\n${transcript.slice(0, 10000)}` }],
    { stream: false, reasoningEffort: 'low' },
  );
  try {
    const res = await fetch('/api/nova/proxy/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        stream: false,
        requestBody: body,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const text = extractTextOutput(input.protocol, data);
    const cleaned = String(text || '')
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { kind?: unknown; text?: unknown };
    const noteText = typeof parsed.text === 'string' ? normalizeDraftTags(parsed.text) : '';
    if (!noteText) return null;
    const kind = parsed.kind === 'library' || parsed.kind === 'proposal' || parsed.kind === 'recent'
      ? parsed.kind
      : 'feedback';
    // 同一条写入判据：不合格就不给用户看（宁缺勿滥，别让脏草稿污染审核队列）
    if (!isUsableDraft(kind, noteText)) return null;
    return { kind, text: noteText };
  } catch {
    return null;
  }
}

// ===== 复盘：从最近的纠错/案例里起草「该升级进基础规则」的建议 =====

const REVIEW_INSTRUCTION = `你是商品图工作流的复盘器。下面是一段时间内新增的纠错条目与通过版案例。
请找出其中**应该升级成类目基础规则**的东西（同一条纠错反复出现、某套色板/图型已被多次验证、写法需要固化），
只输出一个 JSON 数组，不要解释、不要代码块，最多 4 条：
[{"text":"首行=规则标题，然后换行写：- 标签：#… #… / - 判据：… / - 规则：… / - 来源：依据哪几条"}]

要求：
- 每条要具体（带商品/颜色/数字等判据），判据写清「什么情况下适用」。
- 只写值得固化的；宁少勿滥，没有就给 []。
- 不要重复原文，要给出「规则化」的表述。
- 标签维度固定为「商品类型 / 图型 / 风格色板 / 合规」，标签值自由。`;

/** 复盘起草：返回最多 4 条「该升级进基础规则」的建议 */
export async function draftReviewProposals(input: {
  apiKey: string;
  model: string;
  protocol: TextProviderProtocol;
  baseUrl: string;
  transcript: string;
}): Promise<string[]> {
  const transcript = String(input.transcript || '').trim();
  if (!transcript) return [];
  const body = buildSimpleProxyTextRequestBody(
    input.protocol,
    input.model,
    [{ type: 'text', text: `${REVIEW_INSTRUCTION}\n\n---\n\n近期新增：\n${transcript.slice(0, 12000)}` }],
    { stream: false, reasoningEffort: 'low' },
  );
  try {
    const res = await fetch('/api/nova/proxy/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        stream: false,
        requestBody: body,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, unknown>;
    const text = String(extractTextOutput(input.protocol, data) || '');
    const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Array<{ text?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => String((item && item.text) || '').trim())
      .filter(Boolean)
      .slice(0, 4);
  } catch {
    return [];
  }
}
