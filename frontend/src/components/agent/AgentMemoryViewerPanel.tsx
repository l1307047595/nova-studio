'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBodyScrollLock } from '@/lib/scroll-lock';
import { cn } from '@/lib/utils';
import {
  adoptMemoryProposal,
  deleteMemoryEntry,
  deleteMemorySession,
  fetchMemoryEntries,
  markMemoryReviewed,
  saveMemoryIdentity,
  updateMemoryEntry,
  addMemoryEntry,
  type MemoryEntriesView,
  type MemoryEntryKind,
} from '@/lib/nova-memory';

const TABS: Array<{ key: 'identity' | MemoryEntryKind | 'sessions'; label: string; hint: string }> = [
  { key: 'identity', label: '规则', hint: '违禁词 / 写法 / 基础色板 —— 每轮全量注入；只有你能改，AI 只读' },
  { key: 'feedback', label: '纠错', hint: '命中当前话题时整块注入' },
  { key: 'library', label: '案例 / 色板', hint: '通过版要点、基调句、新试的色板 —— 命中时注入' },
  { key: 'proposals', label: '规则建议', hint: 'AI 提议的规则改动；采纳后会追加进「规则」的采纳记录' },
  { key: 'recent', label: '近期记录', hint: '最近几单的主张/骨架机位/色族 —— 只作记性（避免撞车），刻意不积累、不当复用源' },
  { key: 'sessions', label: '会话状态', hint: '每个会话「进行中的单」，多开对话各存各的' },
];

/**
 * 「记忆」面板：看 / 改 / 删 当前类目的全部记忆，并处理复盘。
 * 只有 identity（规则）是 AI 只读、你本人可写；其余条目你也能改删。
 */
export function AgentMemoryViewerPanel({
  open,
  busy,
  onClose,
  onRefreshPending,
  onReview,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onRefreshPending: () => void;
  onReview: () => void;
}) {
  const [view, setView] = useState<MemoryEntriesView | null>(null);
  const [tab, setTab] = useState<'identity' | MemoryEntryKind | 'sessions'>('identity');
  const [identityDraft, setIdentityDraft] = useState('');
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [newEntry, setNewEntry] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useBodyScrollLock();

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchMemoryEntries();
    setLoading(false);
    if (!data) {
      setMessage('读取记忆失败');
      return;
    }
    setView(data);
    setIdentityDraft(data.identity);
  }, []);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置编辑态（一次性）
      setMessage('');
      setEditing(null);
      setNewEntry('');
      void reload();
    }
  }, [open, reload]);

  if (!open) return null;

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setMessage('');
    const result = await fn();
    setMessage(result.ok ? okText : (result.error || '操作失败'));
    if (result.ok) {
      await reload();
      onRefreshPending();
    }
  };

  const entryList = view && tab !== 'identity' && tab !== 'sessions' ? view.entries[tab] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">记忆（本类目 · 只有它自己能看到）</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {view ? `规则 ${view.identityChars} 字符（上限 ${view.limits.identityLimit}）｜ 单条限长 ${view.limits.entryChars} 字符 ｜ 命中注入上限 ${view.limits.hitTotalChars} 字符` : '读取中…'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </div>

        {view?.review.due && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
            <span className="text-xs text-foreground">
              该复盘了：上次复盘后已新增 {view.review.count} 条（阈值 {view.review.threshold}）
            </span>
            <Button size="xs" className="ml-auto text-xs" disabled={busy} onClick={onReview}>
              让 AI 起草该升级的规则
            </Button>
            <Button size="xs" variant="ghost" className="text-xs text-muted-foreground" onClick={() => void run(markMemoryReviewed, '已标记本次复盘完成')}>
              标记已复盘
            </Button>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {TABS.map(item => (
            <Button
              key={item.key}
              size="xs"
              variant={tab === item.key ? 'default' : 'outline'}
              className={cn('text-xs', tab === item.key ? '' : 'text-muted-foreground')}
              onClick={() => { setTab(item.key); setEditing(null); }}
            >
              {item.label}
              {item.key !== 'identity' && item.key !== 'sessions' && view ? ` ${view.entries[item.key].length}` : ''}
              {item.key === 'sessions' && view ? ` ${view.sessions.length}` : ''}
            </Button>
          ))}
          <Button size="xs" variant="ghost" className="ml-auto text-xs text-muted-foreground" disabled={loading} onClick={() => void reload()}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{TABS.find(item => item.key === tab)?.hint}</p>

        <div className="mt-3 flex-1 overflow-y-auto pr-1">
          {tab === 'identity' && (
            <>
              <textarea
                className="h-72 w-full resize-none rounded-md border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
                value={identityDraft}
                onChange={event => setIdentityDraft(event.target.value)}
                disabled={busy}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="xs" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setIdentityDraft(view?.identity || '')}>
                  还原
                </Button>
                <Button size="xs" className="text-xs" disabled={busy || identityDraft === (view?.identity || '')} onClick={() => void run(() => saveMemoryIdentity(identityDraft), '规则已保存')}>
                  保存规则
                </Button>
              </div>

              {/* 已采纳规则：带编号，统计复发次数与状态（规则会退役，不然只会越堆越多） */}
              {view && view.rules && view.rules.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      已采纳规则 {view.rules.length} 条（复发 ≥ {view.limits.ruleReviseRefs ?? 3} 次标「待修订」）
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {view.rules.map(rule => (
                      <div key={rule.id} className="rounded-md border border-border bg-background p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">{rule.id}</span>
                          <span className="text-xs font-medium">{rule.title || '（无标题）'}</span>
                          <span className={cn(
                            'rounded px-1.5 py-0.5 text-[11px]',
                            rule.status === '待修订'
                              ? 'bg-destructive/15 text-destructive'
                              : rule.status === '待复核'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                : rule.status === '已废弃'
                                  ? 'bg-muted text-muted-foreground line-through'
                                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                          )}>
                            {rule.status}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            复发 {rule.refs} 次 · 采纳 {rule.adoptedAt || '未知'}
                            {rule.days > 0 ? ` · ${rule.days} 天前` : ''}
                          </span>
                        </div>
                        {rule.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {rule.tags.map(tag => (
                              <span key={`${rule.id}-${tag}`} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">#{tag}</span>
                            ))}
                          </div>
                        )}
                        {rule.rule && <p className="mt-1 text-xs text-muted-foreground">{rule.rule}</p>}
                        {rule.refs >= (view.limits.ruleReviseRefs ?? 3) && (
                          <p className="mt-1 text-[11px] text-destructive">
                            这条规则没拦住（被引用 {rule.refs} 次）→ 建议改判据或在规则正文里补更硬的判据
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {tab !== 'identity' && tab !== 'sessions' && (
            <>
              <div className="space-y-2">
                {entryList.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">（暂无条目）</p>}
                {entryList.map((entry, index) => (
                  <div key={`${tab}-${index}`} className="rounded-md border border-border bg-background p-2">
                    {editing && editing.index === index ? (
                      <>
                        <textarea
                          className="h-20 w-full resize-none rounded-md border border-border bg-card p-2 text-sm outline-none focus:border-primary"
                          value={editing.text}
                          onChange={event => setEditing({ index, text: event.target.value })}
                        />
                        <div className="mt-1.5 flex justify-end gap-2">
                          <Button size="xs" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setEditing(null)}>取消</Button>
                          <Button size="xs" className="text-xs" onClick={() => { void run(() => updateMemoryEntry(tab as MemoryEntryKind, index, editing.text), '已保存'); setEditing(null); }}>
                            保存
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-start gap-2">
                        <p className="flex-1 whitespace-pre-wrap text-sm">{entry}</p>
                        <div className="flex shrink-0 gap-1">
                          {tab === 'proposals' && (
                            <Button size="xs" variant="outline" className="text-xs" disabled={busy} onClick={() => void run(() => adoptMemoryProposal(entry), '已采纳进规则（追加到「采纳记录」段）')}>
                              采纳进规则
                            </Button>
                          )}
                          <Button size="xs" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setEditing({ index, text: entry })}>改</Button>
                          <Button size="xs" variant="ghost" className="text-xs text-destructive" disabled={busy} onClick={() => void run(() => deleteMemoryEntry(tab as MemoryEntryKind, index), '已删除')}>删</Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-md border border-dashed border-border p-2">
                <textarea
                  className="h-16 w-full resize-none rounded-none border-0 bg-transparent p-1 text-sm outline-none"
                  placeholder={`手动新增一条到「${TABS.find(item => item.key === tab)?.label}」…`}
                  value={newEntry}
                  onChange={event => setNewEntry(event.target.value)}
                />
                <div className="flex justify-end">
                  <Button size="xs" className="text-xs" disabled={busy || !newEntry.trim()} onClick={() => { void run(() => addMemoryEntry(tab as MemoryEntryKind, newEntry), '已新增'); setNewEntry(''); }}>
                    新增
                  </Button>
                </div>
              </div>
            </>
          )}

          {tab === 'sessions' && (
            <div className="space-y-2">
              {(!view || view.sessions.length === 0) && <p className="py-6 text-center text-sm text-muted-foreground">（暂无会话状态）</p>}
              {view?.sessions.map(session => (
                <div key={session.id} className="rounded-md border border-border bg-background p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{session.id}</span>
                    <Button size="xs" variant="ghost" className="text-xs text-destructive" disabled={busy} onClick={() => void run(() => deleteMemorySession(session.id), '已删除该会话状态')}>
                      删
                    </Button>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-foreground/80">{session.content.trim()}</pre>
                </div>
              ))}
            </div>
          )}
        </div>

        {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
