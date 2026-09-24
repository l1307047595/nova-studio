'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBodyScrollLock } from '@/lib/scroll-lock';
import { cn } from '@/lib/utils';
import {
  MEMORY_SESSION_AUTO_KEY,
  isSessionAutoWriteEnabled,
  type MemoryNoteKind,
  type PendingDraft,
} from '@/lib/nova-memory';

const KIND_LABEL: Record<string, string> = {
  feedback: '纠错',
  library: '案例 / 色板',
  proposal: '规则建议',
  session: '会话状态',
  recent: '近期记录',
};

const KIND_ORDER: Array<MemoryNoteKind | 'session'> = ['feedback', 'library', 'proposal', 'recent', 'session'];

/**
 * 待确认面板：心跳只生成草稿，这里逐条确认/驳回。
 * 你不点「写入」，一个字都不会落进记忆文件；驳回过的内容心跳不会再提。
 */
export function AgentMemoryPendingPanel({
  open,
  drafts,
  busyId,
  onClose,
  onApprove,
  onReject,
  onApproveAll,
}: {
  open: boolean;
  drafts: PendingDraft[];
  busyId: string;
  onClose: () => void;
  onApprove: (id: string, override: { kind: MemoryNoteKind | 'session'; text: string }) => void;
  onReject: (id: string) => void;
  onApproveAll: () => void;
}) {
  const [edited, setEdited] = useState<Record<string, { kind: MemoryNoteKind | 'session'; text: string }>>({});
  const [sessionAuto, setSessionAuto] = useState(false);

  useBodyScrollLock();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开面板时读一次本地开关状态（外部存储）
    if (open) setSessionAuto(isSessionAutoWriteEnabled());
  }, [open]);

  if (!open) return null;

  const draftOf = (item: PendingDraft) => edited[item.id] || { kind: item.kind, text: item.text };

  const toggleSessionAuto = () => {
    const next = !sessionAuto;
    setSessionAuto(next);
    try {
      localStorage.setItem(MEMORY_SESSION_AUTO_KEY, next ? '1' : '0');
    } catch { /* 忽略 */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">待确认的记忆（{drafts.length} 条）</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              这些是 AI 起草的，<span className="text-foreground">你不点「写入」就不会进记忆</span>。可改类型、可改内容；驳回的条目以后不会再提。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">会话状态（进行中的单）是否自动写入</span>
          <Button
            size="xs"
            variant={sessionAuto ? 'default' : 'outline'}
            className="text-xs"
            onClick={toggleSessionAuto}
            title="默认关闭：会话状态也要你确认。打开后它直接落盘，不再进这个列表"
          >
            {sessionAuto ? '已开启（自动写入）' : '已关闭（需确认）'}
          </Button>
        </div>

        <div className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1">
          {drafts.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">没有待确认的条目</p>
          )}
          {drafts.map(item => {
            const current = draftOf(item);
            const busy = busyId === item.id;
            return (
              <div key={item.id} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {KIND_ORDER.map(kind => (
                    <Button
                      key={kind}
                      size="xs"
                      variant={current.kind === kind ? 'default' : 'outline'}
                      className={cn('text-xs', current.kind === kind ? '' : 'text-muted-foreground')}
                      disabled={busy}
                      onClick={() => setEdited(prev => ({ ...prev, [item.id]: { ...current, kind } }))}
                    >
                      {KIND_LABEL[kind]}
                    </Button>
                  ))}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {item.source === 'image' ? '来自图片' : item.source === 'heartbeat' ? '来自空闲心跳' : item.source}
                  </span>
                </div>
                <textarea
                  className="mt-2 h-20 w-full resize-none rounded-md border border-border bg-card p-2 text-sm outline-none focus:border-primary"
                  value={current.text}
                  disabled={busy}
                  onChange={event => setEdited(prev => ({ ...prev, [item.id]: { ...current, text: event.target.value } }))}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="xs" variant="ghost" className="text-xs text-muted-foreground" disabled={busy} onClick={() => onReject(item.id)}>
                    {busy ? '处理中…' : '驳回'}
                  </Button>
                  <Button size="xs" className="text-xs" disabled={busy || !current.text.trim()} onClick={() => onApprove(item.id, current)}>
                    写入记忆
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {drafts.length > 1 && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="outline" onClick={onApproveAll}>全部写入（{drafts.length} 条）</Button>
          </div>
        )}
      </div>
    </div>
  );
}
