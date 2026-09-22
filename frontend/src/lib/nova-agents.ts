// 多 Agent（类目）注册表客户端
//
// 设计：同一套代码、多份独立数据。每个类目 = 一个 agent id = 服务端一个记忆目录，
// 类目之间记忆与会话完全隔离、无公共层。选择在浏览器里记住（每个类目各自记最后用的会话）。

export const DEFAULT_AGENT_ID = 'squeeze';

const CURRENT_AGENT_KEY = 'nova-current-agent';
const AGENT_SESSION_MAP_KEY = 'nova-agent-active-sessions';

export interface NovaAgent {
  id: string;
  name: string;
  description?: string;
  hasIdentity?: boolean;
  /** 类目专属的工作台指令（来自 <类目>/instructions.md，可为空） */
  instructions?: string;
  counts?: { feedback: number; library: number; proposals: number };
  updatedAt?: string;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 当前工作类目（浏览器级记忆；切类目只影响这个浏览器） */
export function getCurrentAgentId(): string {
  const store = storage();
  if (!store) return DEFAULT_AGENT_ID;
  try {
    const id = String(store.getItem(CURRENT_AGENT_KEY) || '').trim();
    return id || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

export function setCurrentAgentId(agentId: string): void {
  const store = storage();
  if (!store || !agentId) return;
  try {
    store.setItem(CURRENT_AGENT_KEY, agentId);
  } catch {
    // 存不下也不影响当前会话使用
  }
}

function readAgentSessionMap(): Record<string, string> {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(AGENT_SESSION_MAP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 该类目上次用的会话（每个类目各记一份） */
export function getLastSessionForAgent(agentId: string): string {
  const map = readAgentSessionMap();
  return map[agentId] || 'default';
}

export function setLastSessionForAgent(agentId: string, sessionId: string): void {
  const store = storage();
  if (!store || !agentId || !sessionId) return;
  try {
    const map = readAgentSessionMap();
    map[agentId] = sessionId;
    store.setItem(AGENT_SESSION_MAP_KEY, JSON.stringify(map));
  } catch {
    // 忽略
  }
}

// 类目清单缓存：系统提示词要在每次发消息时同步拿到「当前类目」的名字与指令，
// 不能等异步请求。所以 fetchAgents 成功后写进内存 + localStorage，取用时同步读。
const AGENT_CACHE_KEY = 'nova-agents-cache';

let agentCache: { at: number; agents: NovaAgent[] } | null = null;

function writeAgentCache(agents: NovaAgent[]): void {
  agentCache = { at: Date.now(), agents };
  const store = storage();
  if (!store) return;
  try {
    store.setItem(AGENT_CACHE_KEY, JSON.stringify({ at: agentCache.at, agents }));
  } catch {
    // 存不下不影响本次会话
  }
}

function readAgentCache(): { at: number; agents: NovaAgent[] } | null {
  if (agentCache) return agentCache;
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(AGENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; agents?: NovaAgent[] };
    if (!Array.isArray(parsed.agents)) return null;
    agentCache = { at: Number(parsed.at) || 0, agents: parsed.agents };
    return agentCache;
  } catch {
    return null;
  }
}

/** 同步取某个类目（含它的 instructions）；缓存没有就返回 null */
export function getCachedAgent(agentId: string): NovaAgent | null {
  const cache = readAgentCache();
  if (!cache) return null;
  return cache.agents.find(item => item && item.id === agentId) || null;
}

export async function fetchAgents(): Promise<NovaAgent[]> {
  try {
    const res = await fetch('/api/nova/agents', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { agents?: NovaAgent[] };
    const agents = Array.isArray(data.agents) ? data.agents : [];
    writeAgentCache(agents);
    return agents;
  } catch {
    return [];
  }
}

export async function createAgent(input: { id: string; name: string; description?: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/nova/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '新建类目失败' };
  }
}
