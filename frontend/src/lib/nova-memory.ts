// Agent 记忆客户端（本地文件记忆，按 agent 隔离，无公共层）
//
// 读写时机（由调用方控制，本模块只提供能力）：
//   · 读取：会话开始、有新图上传   → loadAgentMemory()
//   · 注入：每轮拼 instructions 时取内存里的当前记忆 → getCurrentMemory()
//   · 写入：空闲心跳（无进行中任务 + 3 分钟无对话）→ appendMemoryEntry() / writeSessionState() / writeProposal()
//
// 设计要点：会话内**不再重复读取**——读一次放内存，之后每轮都用这份，避免上下文漂移。

import { DEFAULT_AGENT_ID } from '@/lib/nova-agents';

export { DEFAULT_AGENT_ID } from '@/lib/nova-agents';
/** 默认会话 id（与 lib/agent-context-store 的 DEFAULT_SESSION_ID 一致）：空 id 要归一到它，否则会话状态读不到 */
export const DEFAULT_SESSION_ID = 'default';

export interface AgentMemoryPayload {
  agent: string;
  version: string;
  exists: boolean;
  identity: string;
  identityTruncated: boolean;
  feedbackHits: string[];
  libraryHits: string[];
  feedbackDropped?: number;
  libraryDropped?: number;
  sessionState: string;
  proposals: string;
  queryTokenCount: number;
}

export type MemoryWriteKind = 'feedback' | 'library' | 'proposal' | 'session';

/** 可手动/由 AI 起草写入的记忆类型（session 是会话状态，不走这里） */
export type MemoryNoteKind = 'feedback' | 'library' | 'proposal';

let currentMemory: AgentMemoryPayload | null = null;
let currentAgentId: string = readStoredAgentId();

/** 当前工作类目（启动时从浏览器记住的选择恢复） */
function readStoredAgentId(): string {
  if (typeof window === 'undefined') return DEFAULT_AGENT_ID;
  try {
    const stored = String(window.localStorage.getItem('nova-current-agent') || '').trim();
    return stored || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

export function getCurrentAgentId(): string {
  return currentAgentId;
}

/**
 * 切类目：必须同时清掉内存里的记忆，否则会把上一个类目的记忆注入到新类目的对话里。
 * 会话切换由调用方负责（会话 id 决定对话库，不同类目不能共用）。
 */
export function setMemoryAgent(agentId: string): void {
  const next = String(agentId || '').trim() || DEFAULT_AGENT_ID;
  if (next === currentAgentId) return;
  currentAgentId = next;
  currentMemory = null;
}

export function getCurrentMemory(): AgentMemoryPayload | null {
  return currentMemory;
}

export function clearCurrentMemory(): void {
  currentMemory = null;
}

/** 读取记忆（只在会话开始 / 新图上传时调用）。失败返回 null，不影响出图。 */
export async function loadAgentMemory(options: {
  agentId?: string;
  query?: string;
  sessionId?: string;
} = {}): Promise<AgentMemoryPayload | null> {
  // 不传 agentId 时按「当前工作类目」走：多类目下写死默认值会串类目。
  const agentId = String(options.agentId || currentAgentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  const query = String(options.query || '').slice(0, 600);
  const sessionId = String(options.sessionId || '').trim() || DEFAULT_SESSION_ID;
  try {
    const url = `/api/nova/memory?agent=${encodeURIComponent(agentId)}`
      + `&q=${encodeURIComponent(query)}`
      + `&session=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = (await res.json()) as AgentMemoryPayload;
    if (!payload || typeof payload.identity !== 'string') return null;
    currentMemory = payload;
    currentAgentId = agentId;
    return payload;
  } catch {
    return null;
  }
}

/** 写入记忆（追加式）。kind=session 时必须给 sessionId。 */
export async function appendMemoryEntry(
  kind: MemoryWriteKind,
  text: string,
  sessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  const targetSession = kind === 'session'
    ? (String(sessionId || '').trim() || DEFAULT_SESSION_ID)
    : '';
  try {
    const res = await fetch(`/api/nova/memory?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text: body, session: targetSession }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    return { ok: Boolean(data?.ok) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '写入失败' };
  }
}

/** 把记忆拼成注入块（每轮拼 instructions 时调用，纯内存操作，不发请求）。 */
export function formatMemoryBlock(memory: AgentMemoryPayload | null = currentMemory): string {
  if (!memory) return '';
  const hasIdentity = Boolean(memory.identity.trim());
  const hasFeedback = memory.feedbackHits.length > 0;
  const hasLibrary = memory.libraryHits.length > 0;
  const hasSession = Boolean(memory.sessionState.trim());
  const hasProposals = Boolean(memory.proposals.trim());
  if (!hasIdentity && !hasFeedback && !hasLibrary && !hasSession) return '';

  const parts: string[] = [];
  parts.push('════════ 本类目记忆（本地文件，仅本 agent 可见） ════════');
  parts.push('以下内容是本类目的专属记忆，**优先于前面的通用规则**；与前面规则冲突时以本记忆为准。');

  if (hasIdentity) {
    parts.push(`【类目规则 · identity.md】\n${memory.identity.trim()}`
      + (memory.identityTruncated ? '\n（注意：identity 已按上限截断，未展示部分不代表不存在）' : ''));
  }
  if (hasSession) {
    parts.push(`【本会话进行中的单 · sessions】\n${memory.sessionState.trim()}`);
  }
  if (hasFeedback) {
    parts.push(`【相关纠错 · feedback.md（命中本轮关键词）】\n${memory.feedbackHits.map(item => `- ${item}`).join('\n')}`
      + (memory.feedbackDropped ? `\n（另有 ${memory.feedbackDropped} 条相关但未注入，避免上下文膨胀；需要时可让我查）` : ''));
  }
  if (hasLibrary) {
    parts.push(`【相关案例与色板 · library.md（命中本轮关键词）】\n${memory.libraryHits.map(item => `- ${item}`).join('\n')}`
      + (memory.libraryDropped ? `\n（另有 ${memory.libraryDropped} 条相关但未注入）` : ''));
  }
  if (hasProposals) {
    parts.push(`【待确认的规则改动建议 · proposals.md（只提示存在，不要当成已生效规则）】\n${memory.proposals.trim().slice(0, 1200)}`);
  }
  return `\n\n${parts.join('\n\n')}`;
}

/** 取最近一条用户消息作为检索关键词。 */
export function latestUserQuery(history: Array<{ role: string; text: string }>): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message.role === 'user' && message.text.trim()) return message.text.slice(0, 600);
  }
  return '';
}

// ===== 待确认队列 =====
// 心跳只生成草稿放这里；你确认后才写进真记忆文件。驳回的条目会被记下，不再重复提。

export interface PendingDraft {
  id: string;
  kind: MemoryNoteKind | 'session';
  text: string;
  source: string;
  session: string;
  createdAt: string;
}

export interface PendingStore {
  items: PendingDraft[];
  rejected: string[];
  review?: MemoryReviewStatus;
}

export async function listPendingDrafts(agentId: string = currentAgentId): Promise<PendingStore> {
  try {
    const res = await fetch(`/api/nova/memory/pending?agent=${encodeURIComponent(agentId)}`, { cache: 'no-store' });
    if (!res.ok) return { items: [], rejected: [] };
    const data = (await res.json()) as PendingStore;
    return {
      items: Array.isArray(data.items) ? data.items : [],
      rejected: Array.isArray(data.rejected) ? data.rejected : [],
      review: data.review,
    };
  } catch {
    return { items: [], rejected: [] };
  }
}

/** 入队一条草稿（心跳自动起草、图片存案例都走这里） */
export async function queueMemoryDraft(
  kind: MemoryNoteKind | 'session',
  text: string,
  options: { source?: string; session?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  try {
    const res = await fetch(`/api/nova/memory/pending?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add', kind, text: body,
        source: options.source || 'heartbeat',
        session: options.session || '',
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '入队失败' };
  }
}

/** 确认一条：可改类型和内容，写入真记忆文件 */
export async function approvePendingDraft(
  id: string,
  override: { kind?: MemoryNoteKind | 'session'; text?: string; session?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/nova/memory/pending?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', id, ...override }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '确认失败' };
  }
}

/** 驳回一条：不写入，并记下内容避免重复提 */
export async function rejectPendingDraft(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/nova/memory/pending?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', id }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '驳回失败' };
  }
}

/** 全部确认 */
export async function approveAllPendingDrafts(): Promise<{ ok: boolean; approved: number; error?: string }> {
  try {
    const res = await fetch(`/api/nova/memory/pending?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approveAll' }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; approved?: number; error?: string };
    return res.ok && data.ok
      ? { ok: true, approved: Number(data.approved || 0) }
      : { ok: false, approved: 0, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, approved: 0, error: error instanceof Error ? error.message : '批量确认失败' };
  }
}

/** 会话状态是否自动写入（默认否：也要你确认） */
export const MEMORY_SESSION_AUTO_KEY = 'nova-memory-session-auto';
export function isSessionAutoWriteEnabled(): boolean {
  try {
    return localStorage.getItem(MEMORY_SESSION_AUTO_KEY) === '1';
  } catch {
    return false;
  }
}

// ===== 记忆查看 / 编辑（你本人操作） =====

export interface MemoryReviewStatus {
  due: boolean;
  count: number;
  threshold: number;
  lastReviewAt: string;
}

export interface MemoryRule {
  id: string;
  title: string;
  tags: string[];
  criteria: string;
  rule: string;
  source: string;
  adoptedAt: string;
  status: string;
  body: string;
  /** 被纠错/案例引用的次数（复发） */
  refs: number;
  days: number;
}

export interface MemoryEntriesView {
  identity: string;
  identityChars: number;
  entries: { feedback: string[]; library: string[]; proposals: string[] };
  sessions: Array<{ id: string; content: string; updatedAt: string }>;
  rules?: MemoryRule[];
  limits: {
    entryChars: number;
    identityLimit: number;
    hitCount: number;
    hitTotalChars: number;
    reviewThreshold: number;
    ruleReviseRefs?: number;
    ruleStaleDays?: number;
    tagWeight?: number;
  };
  review: MemoryReviewStatus;
}

export type MemoryEntryKind = 'feedback' | 'library' | 'proposals';

export async function fetchMemoryEntries(agentId: string = currentAgentId): Promise<MemoryEntriesView | null> {
  try {
    const res = await fetch(`/api/nova/memory/entries?agent=${encodeURIComponent(agentId)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as MemoryEntriesView;
  } catch {
    return null;
  }
}

async function postMemoryEntries(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/nova/memory/entries?agent=${encodeURIComponent(currentAgentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '操作失败' };
  }
}

export const addMemoryEntry = (kind: MemoryEntryKind, text: string) =>
  postMemoryEntries({ op: 'add', kind, text });
export const updateMemoryEntry = (kind: MemoryEntryKind, index: number, text: string) =>
  postMemoryEntries({ op: 'update', kind, index, text });
export const deleteMemoryEntry = (kind: MemoryEntryKind, index: number) =>
  postMemoryEntries({ op: 'delete', kind, index });
export const saveMemoryIdentity = (text: string) =>
  postMemoryEntries({ op: 'saveIdentity', text });
export const adoptMemoryProposal = (text: string) =>
  postMemoryEntries({ op: 'adopt', text });
export const deleteMemorySession = (session: string) =>
  postMemoryEntries({ op: 'deleteSession', session });
export const markMemoryReviewed = () =>
  postMemoryEntries({ op: 'reviewed' });
