import { generateUUID } from '@/lib/uuid';
import { DEFAULT_AGENT_ID, getLastSessionForAgent, setLastSessionForAgent } from '@/lib/nova-agents';

export interface AgentSession {
  id: string;
  name: string;
  /** 归属类目（agent）。老会话没有这个字段，按默认类目算。 */
  agentId?: string;
}

const SESSIONS_KEY = 'nova-agent-sessions';
const ACTIVE_SESSION_KEY = 'nova-agent-active-session';
const DEFAULT_SESSION: AgentSession = { id: 'default', name: '默认会话' };

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 只保留有值的字段：agentId 为 undefined 时不要写成「有这个键」，否则严格比较（toEqual）会被无意义的 undefined 干扰 */
function cloneSession(session: AgentSession): AgentSession {
  return session.agentId
    ? { id: session.id, name: session.name, agentId: session.agentId }
    : { id: session.id, name: session.name };
}

function normalizeSessions(values: unknown[]): AgentSession[] {
  const unique = new Map<string, AgentSession>();
  for (const value of values) {
    if (!isAgentSession(value) || unique.has(value.id)) continue;
    unique.set(value.id, cloneSession(value));
  }

  const defaultSession = unique.get(DEFAULT_SESSION.id) || cloneSession(DEFAULT_SESSION);
  const otherSessions = [...unique.values()].filter(session => session.id !== DEFAULT_SESSION.id);
  return [defaultSession, ...otherSessions];
}

function getStoredSessions(): AgentSession[] {
  const storage = getStorage();
  if (!storage) return [cloneSession(DEFAULT_SESSION)];

  try {
    const raw = storage.getItem(SESSIONS_KEY);
    if (!raw) return [cloneSession(DEFAULT_SESSION)];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [cloneSession(DEFAULT_SESSION)];
    return normalizeSessions(parsed);
  } catch {
    return [cloneSession(DEFAULT_SESSION)];
  }
}

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === 'string' && session.id.length > 0
    && typeof session.name === 'string' && session.name.length > 0;
}

function saveSessions(sessions: AgentSession[]): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Keep the in-memory registry usable when storage is unavailable.
  }
}

/** 某类目的会话归属：老会话（无 agentId）算默认类目 */
function sessionAgentId(session: AgentSession): string {
  return session.agentId || DEFAULT_AGENT_ID;
}

/**
 * 每个类目有自己的默认会话 id：默认类目沿用 'default'（保住已有对话记录），
 * 其他类目用 'default-<agentId>'。会话 id 决定 IndexedDB 库名，所以绝不能跨类目共用，
 * 否则两个类目会读到同一份对话。
 */
export function defaultSessionIdForAgent(agentId: string): string {
  return agentId === DEFAULT_AGENT_ID ? DEFAULT_SESSION.id : `default-${agentId}`;
}

export function listAgentSessions(): AgentSession[] {
  return getStoredSessions();
}

/** 该类目的会话列表（没有就自动建一个默认会话） */
export function listAgentSessionsForAgent(agentId: string): AgentSession[] {
  const normalized = agentId || DEFAULT_AGENT_ID;
  const owned = getStoredSessions().filter(session => sessionAgentId(session) === normalized);
  if (owned.length > 0) return owned;

  const created: AgentSession = {
    id: defaultSessionIdForAgent(normalized),
    name: DEFAULT_SESSION.name,
    agentId: normalized,
  };
  saveSessions([...getStoredSessions(), created]);
  return [created];
}

export function createAgentSession(name = '新会话', agentId = DEFAULT_AGENT_ID): AgentSession {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('会话名称不能为空');

  const session = { id: generateUUID(), name: normalizedName, agentId: agentId || DEFAULT_AGENT_ID };
  saveSessions([...getStoredSessions(), session]);
  return session;
}

export function renameAgentSession(id: string, name: string): boolean {
  const normalizedName = name.trim();
  if (!normalizedName) return false;

  const sessions = getStoredSessions();
  const index = sessions.findIndex(session => session.id === id);
  if (index < 0) return false;

  const renamed = sessions.map(session => session.id === id ? { ...session, name: normalizedName } : session);
  saveSessions(renamed);
  return true;
}

export function deleteAgentSession(id: string): boolean {
  if (id === DEFAULT_SESSION.id) return false;

  const sessions = getStoredSessions();
  const target = sessions.find(session => session.id === id);
  if (!target) return false;
  if (id === defaultSessionIdForAgent(sessionAgentId(target))) return false;

  const wasActive = getActiveAgentSessionId() === id;
  saveSessions(sessions.filter(session => session.id !== id));
  if (wasActive) setActiveAgentSessionId(DEFAULT_SESSION.id);
  return true;
}

/** 取当前类目上次用的会话（给了 agentId 就按类目各记一份） */
export function getActiveAgentSessionId(agentId?: string): string {
  if (agentId) {
    const stored = getLastSessionForAgent(agentId);
    if (listAgentSessionsForAgent(agentId).some(session => session.id === stored)) return stored;
    return listAgentSessionsForAgent(agentId)[0]?.id || defaultSessionIdForAgent(agentId);
  }

  const storage = getStorage();
  if (!storage) return DEFAULT_SESSION.id;

  try {
    const activeId = storage.getItem(ACTIVE_SESSION_KEY);
    if (!activeId || !getStoredSessions().some(session => session.id === activeId)) {
      return DEFAULT_SESSION.id;
    }
    return activeId;
  } catch {
    return DEFAULT_SESSION.id;
  }
}

export function setActiveAgentSessionId(id: string, agentId?: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  const target = getStoredSessions().find(session => session.id === id);
  if (!target) return false;

  if (agentId) setLastSessionForAgent(agentId, id);

  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(ACTIVE_SESSION_KEY, id);
    return true;
  } catch {
    return false;
  }
}
