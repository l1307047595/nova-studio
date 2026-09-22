'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBodyScrollLock } from '@/lib/scroll-lock';
import { cn } from '@/lib/utils';
import type { MemoryNoteKind } from '@/lib/nova-memory';

export type { MemoryNoteKind };

const KIND_OPTIONS: Array<{ value: MemoryNoteKind; label: string; hint: string }> = [
  { value: 'feedback', label: '纠错', hint: '我纠正过的点，下次别犯（追加进 feedback.md）' },
  { value: 'library', label: '案例 / 色板', hint: '通过版要点、可复用基调句、新试的色板（追加进 library.md）' },
  { value: 'proposal', label: '规则建议', hint: '建议改类目规则（违禁词 / 写法 / 基础色板），只提议、待你确认' },
];

/**
 * 「记一条」：AI 起草、你审、你确认才写。
 * 打开即让 AI 从当前对话提炼一条（可换类型/重新生成/手改），你不点「写入记忆」就什么都不写。
 */
export function AgentMemoryNoteDialog({
  open,
  saving,
  onClose,
  onSubmit,
  onDraft,
}: {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (kind: MemoryNoteKind, text: string) => void;
  onDraft: (kind: MemoryNoteKind) => Promise<{ kind: MemoryNoteKind; text: string } | null>;
}) {
  const [kind, setKind] = useState<MemoryNoteKind>('feedback');
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');
  const requestRef = useRef(0);

  useBodyScrollLock();

  const runDraft = useCallback(async (nextKind: MemoryNoteKind) => {
    const requestId = ++requestRef.current;
    setDrafting(true);
    setDraftError('');
    const result = await onDraft(nextKind);
    if (requestId !== requestRef.current) return;   // 被更新的请求取代，丢弃
    setDrafting(false);
    if (result) {
      setKind(result.kind);
      setText(result.text);
    } else {
      setText('');
      setDraftError('AI 没能从当前对话提炼出内容，你可以自己写一条，或先在对话里聊两句再点。');
    }
  }, [onDraft]);

  useEffect(() => {
    if (!open) return;
    setText('');
    setDraftError('');
    void runDraft('feedback');
    return () => { requestRef.current += 1; };
  }, [open, runDraft]);

  if (!open) return null;

  const active = KIND_OPTIONS.find(option => option.value === kind);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">记一条记忆</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              AI 从当前对话提炼，<span className="text-foreground">你审过才写入</span>；只写进当前类目，别的类目看不到。写入是追加，不覆盖。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>关闭</Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {KIND_OPTIONS.map(option => (
            <Button
              key={option.value}
              type="button"
              size="xs"
              variant={option.value === kind ? 'default' : 'outline'}
              className={cn('text-xs', option.value === kind ? '' : 'text-muted-foreground')}
              onClick={() => { setKind(option.value); void runDraft(option.value); }}
              disabled={drafting || saving}
            >
              {option.label}
            </Button>
          ))}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto text-xs text-muted-foreground"
            onClick={() => void runDraft(kind)}
            disabled={drafting || saving}
          >
            {drafting ? 'AI 提炼中…' : '重新生成'}
          </Button>
        </div>
        {active && <p className="mt-2 text-xs text-muted-foreground">{active.hint}</p>}

        <textarea
          className="mt-3 h-32 w-full resize-none rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-primary"
          placeholder={drafting
            ? 'AI 正在从当前对话提炼…'
            : '（AI 会填好这里，你也可以直接改；改完点右下角写入记忆）'}
          value={text}
          onChange={event => setText(event.target.value)}
          disabled={saving}
        />
        {draftError && <p className="mt-2 text-xs text-destructive">{draftError}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
          <Button
            size="sm"
            onClick={() => onSubmit(kind, text)}
            disabled={saving || drafting || !text.trim()}
          >
            {saving ? '写入中…' : '写入记忆'}
          </Button>
        </div>
      </div>
    </div>
  );
}
