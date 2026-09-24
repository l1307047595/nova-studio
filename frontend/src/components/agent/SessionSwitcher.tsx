'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Boxes, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { deleteAgentSessionDatabase } from '@/lib/agent-context-store';
import {
  createAgentSession,
  defaultSessionIdForAgent,
  deleteAgentSession,
  listAgentSessionsForAgent,
  renameAgentSession,
  type AgentSession,
} from '@/lib/agent-sessions';
import { DEFAULT_AGENT_ID, createAgent, fetchAgents, type NovaAgent } from '@/lib/nova-agents';
import { cn } from '@/lib/utils';

export interface SessionSwitcherProps {
  activeSessionId: string;
  onSessionChange: (sessionId: string) => void | Promise<void>;
  /** 当前工作类目（不传按默认类目走，便于单测独立渲染） */
  agentId?: string;
  onAgentChange?: (agentId: string) => void | Promise<void>;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}

type NameDialogState = { mode: 'create' } | { mode: 'rename'; session: AgentSession } | null;

export function SessionSwitcher({ activeSessionId, onSessionChange, agentId = DEFAULT_AGENT_ID, onAgentChange, mobileOpen, onMobileOpenChange }: SessionSwitcherProps) {
  /*
   * 会话列表直接从本地存储派生（useMemo + 版本号），不再用 state + effect 同步。
   * 之前 agentId 一变就在 effect 里 setState，会多一次级联渲染
   * （react-hooks/set-state-in-effect）；这里读的是同步存储，派生即可。
   * 增删改名之后调 refreshSessions() 递增版本号，效果与原 setSessions 等价。
   */
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const sessions = useMemo(() => {
    // sessionsVersion 只用于「强制重算」：增删改名后递增它，让这里重新读一次存储。
    void sessionsVersion;
    return listAgentSessionsForAgent(agentId);
  }, [agentId, sessionsVersion]);
  const [agents, setAgents] = useState<NovaAgent[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentIdDraft, setAgentIdDraft] = useState('');
  const [agentNameDraft, setAgentNameDraft] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSession | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);

  const isMobileOpen = mobileOpen !== undefined ? mobileOpen : internalMobileOpen;
  // useCallback：这个 setter 被下面的 keydown effect 依赖，每次渲染换身份会让 effect 反复重挂
  const setMobileOpenState = useCallback((open: boolean) => {
    if (onMobileOpenChange) onMobileOpenChange(open);
    else setInternalMobileOpen(open);
  }, [onMobileOpenChange]);

  const defaultSessionId = defaultSessionIdForAgent(agentId);
  const agentOptions: NovaAgent[] = agents.length > 0 ? agents : [{ id: agentId, name: agentId }];
  const currentAgentName = agentOptions.find(a => a.id === agentId)?.name || agentId;

  useEffect(() => {
    let cancelled = false;
    void fetchAgents().then(list => {
      if (!cancelled && list.length > 0) setAgents(list);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (!isMobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpenState(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileOpen, setMobileOpenState]);

  const refreshSessions = () => setSessionsVersion(version => version + 1);

  /** 切换工作类目（记忆与会话整体切走，由父层重挂载工作区） */
  const handleAgentSelect = async (nextAgentId: string) => {
    if (!nextAgentId || nextAgentId === agentId || agentBusy || !onAgentChange) return;
    setAgentBusy(true);
    try {
      await onAgentChange(nextAgentId);
    } finally {
      setAgentBusy(false);
    }
  };

  const openAgentDialog = () => {
    setAgentIdDraft('');
    setAgentNameDraft('');
    setAgentError(null);
    setAgentDialogOpen(true);
  };

  const handleAgentCreate = async (event: FormEvent) => {
    event.preventDefault();
    const id = agentIdDraft.trim().toLowerCase();
    if (!id) return;

    setAgentBusy(true);
    setAgentError(null);
    try {
      const result = await createAgent({ id, name: agentNameDraft.trim() || id });
      if (!result.ok) {
        setAgentError(result.error || '新建类目失败');
        return;
      }
      const list = await fetchAgents();
      if (list.length > 0) setAgents(list);
      setAgentDialogOpen(false);
      if (onAgentChange) await onAgentChange(id);
    } finally {
      setAgentBusy(false);
    }
  };

  const handleSessionChange = async (sessionId: string) => {
    if (busy || sessionId === activeSessionId) return;

    setBusy(true);
    try {
      await onSessionChange(sessionId);
    } finally {
      setBusy(false);
    }
  };

  const openCreateDialog = () => {
    setNameDraft('');
    setNameDialog({ mode: 'create' });
  };

  const openRenameDialog = (session: AgentSession) => {
    setNameDraft(session.name);
    setNameDialog({ mode: 'rename', session });
  };

  const handleNameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = nameDraft.trim();
    if (!name || !nameDialog || busy) return;

    setBusy(true);
    try {
      if (nameDialog.mode === 'create') {
        const session = createAgentSession(name, agentId);
        refreshSessions();
        setNameDialog(null);
        setMobileOpenState(false);
        await onSessionChange(session.id);
      } else {
        renameAgentSession(nameDialog.session.id, name);
        refreshSessions();
        setNameDialog(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target || target.id === 'default' || busy) return;

    setDeleteError(null);
    setBusy(true);
    let switchedToDefault = false;
    try {
      if (target.id === activeSessionId) {
        await onSessionChange('default');
        switchedToDefault = true;
      }
      await deleteAgentSessionDatabase(target.id);
      deleteAgentSession(target.id);
      refreshSessions();
      setDeleteTarget(null);
      setMobileOpenState(false);
    } catch {
      if (switchedToDefault) {
        try { await onSessionChange(target.id); } catch { /* keep the deletion error visible */ }
      }
      setDeleteError('删除会话失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const renderSessionItems = (isMobile: boolean = false) => (
    sessions.map(session => {
      const isActive = session.id === activeSessionId;
      return (
        <div
          key={session.id}
          className={cn(
            'group flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 transition-all text-sm',
            isActive
              ? 'bg-primary/10 text-primary font-medium border border-primary/20 shadow-xs dark:bg-primary/15'
              : 'border border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <button
            type="button"
            aria-current={isActive ? 'true' : undefined}
            disabled={busy || isActive}
            onClick={() => {
              void handleSessionChange(session.id);
              if (isMobile) setMobileOpenState(false);
            }}
            className={cn(
              'min-w-0 flex-1 truncate text-left transition-colors',
              isActive ? 'text-primary font-medium' : 'text-foreground/80 hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              {isActive && (
                <span className="size-1.5 rounded-full bg-primary shrink-0 animate-pulse" />
              )}
              <span className="truncate">{session.name}</span>
            </span>
          </button>
          <button
            type="button"
            aria-label={`重命名会话 ${session.name}`}
            title="重命名"
            disabled={busy}
            onClick={() => openRenameDialog(session)}
            className={cn(
              'shrink-0 rounded-md p-1 transition-colors disabled:opacity-40',
              isActive
                ? 'text-primary/70 hover:bg-primary/15 hover:text-primary'
                : 'text-muted-foreground/60 hover:bg-background hover:text-foreground opacity-70 sm:opacity-0 group-hover:opacity-100 focus:opacity-100',
            )}
          >
            <Pencil className="size-3.5" />
          </button>
          {session.id !== defaultSessionId && (
            <button
              type="button"
              aria-label={`删除会话 ${session.name}`}
              title="删除"
              disabled={busy}
              onClick={() => {
                setDeleteError(null);
                setDeleteTarget(session);
              }}
              className={cn(
                'shrink-0 rounded-md p-1 transition-colors disabled:opacity-40',
                isActive
                  ? 'text-primary/70 hover:bg-destructive/10 hover:text-destructive'
                  : 'text-muted-foreground/60 hover:bg-background hover:text-destructive opacity-70 sm:opacity-0 group-hover:opacity-100 focus:opacity-100',
              )}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      );
    })
  );

  return (
    <>
      {/* 桌面端正常展示侧边栏 */}
      <aside
        aria-label="Agent 会话"
        className="hidden md:flex w-52 shrink-0 flex-col self-stretch rounded-2xl border border-border bg-card/60"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">会话</span>
          <span className="text-xs text-muted-foreground">{sessions.length}</span>
        </div>
        <div className="border-b border-border px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Boxes className="size-3.5" />
              工作类目
            </span>
            <button
              type="button"
              onClick={openAgentDialog}
              disabled={agentBusy}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              ＋ 新建
            </button>
          </div>
          <select
            aria-label="选择工作类目"
            value={agentId}
            disabled={agentBusy}
            onChange={event => void handleAgentSelect(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/40 focus:border-primary/60 disabled:opacity-50"
          >
            {agentOptions.map(agent => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <p className="text-[11px] leading-tight text-muted-foreground/70">
            「{currentAgentName}」的记忆与会话独立，不与其他类目相通
          </p>
        </div>
        <div className="border-b border-border p-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full justify-center gap-2 rounded-xl border-dashed border-primary/35 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 text-primary font-medium shadow-xs transition-all"
            onClick={openCreateDialog}
            disabled={busy}
          >
            <Plus className="size-4" />
            新建会话
          </Button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {renderSessionItems(false)}
        </div>
      </aside>

      {/* 移动端抽屉侧边栏（由 Agent 顶栏左侧按钮触发打开） */}
      {isMobileOpen && typeof document !== 'undefined' && createPortal(
        <div className="md:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="会话侧边栏">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setMobileOpenState(false)}
          />
          <div className="relative z-10 flex h-full w-72 max-w-[82vw] flex-col border-r border-border bg-card/95 p-3 shadow-2xl backdrop-blur-xl animate-in slide-in-from-left duration-200">
            <div className="flex items-center justify-between border-b border-border/80 pb-2.5">
              <div className="flex items-center gap-2">
                <MessageSquare className="size-4 text-primary" />
                <span className="text-sm font-semibold">会话管理</span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {sessions.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpenState(false)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="关闭侧边栏"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="border-b border-border/60 px-0.5 py-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Boxes className="size-3.5" />
                  工作类目
                </span>
                <button
                  type="button"
                  onClick={openAgentDialog}
                  disabled={agentBusy}
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  ＋ 新建
                </button>
              </div>
              <select
                aria-label="选择工作类目"
                value={agentId}
                disabled={agentBusy}
                onChange={event => void handleAgentSelect(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-medium text-foreground outline-none"
              >
                {agentOptions.map(agent => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </div>

            <div className="py-2.5 border-b border-border/60">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full justify-center gap-2 rounded-xl border-dashed border-primary/35 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 text-primary font-medium shadow-xs transition-all"
                onClick={openCreateDialog}
                disabled={busy}
              >
                <Plus className="size-4" />
                新建会话
              </Button>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto pt-2 pb-1">
              {renderSessionItems(true)}
            </div>
          </div>
        </div>,
        document.body
      )}

      <Dialog
        open={agentDialogOpen}
        onOpenChange={open => {
          if (!open && !agentBusy) setAgentDialogOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={event => void handleAgentCreate(event)}>
            <DialogHeader>
              <DialogTitle>新建类目</DialogTitle>
              <DialogDescription>
                每个类目有独立的记忆（违禁词 / 写法 / 色板）和独立会话，互不相通。
              </DialogDescription>
            </DialogHeader>
            <label className="mt-4 block space-y-1.5 text-sm">
              <span>类目标识（小写字母、数字、_ 或 -，用作目录名）</span>
              <Input
                autoFocus
                aria-label="类目标识"
                value={agentIdDraft}
                onChange={event => setAgentIdDraft(event.target.value)}
                placeholder="beauty"
                maxLength={32}
              />
            </label>
            <label className="mt-3 block space-y-1.5 text-sm">
              <span>显示名称</span>
              <Input
                aria-label="类目名称"
                value={agentNameDraft}
                onChange={event => setAgentNameDraft(event.target.value)}
                placeholder="美妆"
                maxLength={40}
              />
            </label>
            {agentError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {agentError}
              </p>
            )}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setAgentDialogOpen(false)} disabled={agentBusy}>
                取消
              </Button>
              <Button type="submit" disabled={!agentIdDraft.trim() || agentBusy}>
                创建并切换
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={nameDialog !== null}
        onOpenChange={open => {
          if (!open && !busy) setNameDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={event => void handleNameSubmit(event)}>
            <DialogHeader>
              <DialogTitle>{nameDialog?.mode === 'create' ? '新建会话' : '重命名会话'}</DialogTitle>
              <DialogDescription>
                会话记录分别保存在本机，仅当前会话会载入 Agent。
              </DialogDescription>
            </DialogHeader>
            <label className="mt-4 block space-y-1.5 text-sm">
              <span>会话名称</span>
              <Input
                autoFocus
                aria-label="会话名称"
                value={nameDraft}
                onChange={event => setNameDraft(event.target.value)}
                maxLength={80}
              />
            </label>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setNameDialog(null)} disabled={busy}>
                取消
              </Button>
              <Button type="submit" disabled={!nameDraft.trim() || busy}>
                {nameDialog?.mode === 'create' ? '创建' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!busy && !open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              确定删除{deleteTarget?.name}吗？该会话的聊天记录和图片将从本机清除，且无法恢复。
            </DialogDescription>
            {deleteError && (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={busy}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
