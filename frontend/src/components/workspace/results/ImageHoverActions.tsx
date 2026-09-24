'use client';

import { Copy, Download, Eye, ImagePlus, Wand2 } from 'lucide-react';
import type React from 'react';
import { runImageAction, type ImageActionPayload } from '@/lib/image-actions';
import { cn } from '@/lib/utils';

interface ImageHoverActionsProps {
  payload: ImageActionPayload;
  onPreview?: () => void;
  compact?: boolean;
  /**
   * 图外横排模式：按钮**不叠在图片上**，作为普通 flex 行渲染在图片下方，
   * 「悬浮图片才显示」由外层容器（group/thumb + opacity）控制。
   *
   * 为什么要有：聊天里的缩略图小、按钮有 5~7 个，叠在图上会把商品本身糊住，
   * 用户既看不清图也点不准按钮。叠层模式仍保留给图库/结果卡等大图场景。
   */
  inline?: boolean;
  showPreview?: boolean;
  showDownload?: boolean;
  showCopy?: boolean;
  showAddToAssets?: boolean;
  showUseAsReference?: boolean;
  extraActions?: React.ReactNode;
  className?: string;
}

function stop(event: React.MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function ActionButton({
  title,
  onClick,
  compact,
  inline,
  children,
}: {
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
  inline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'pointer-events-auto flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2',
        inline
          // 图外模式：按钮落在气泡底色上，用边框+卡片底色，不再是半透明白
          ? 'border border-border bg-card text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground focus-visible:ring-ring'
          : 'bg-white/20 text-white shadow-sm backdrop-blur-sm hover:bg-white/35 focus-visible:ring-white/80',
        // 图外模式下按钮大一点（24px），图小的时候也好点
        compact ? (inline ? 'h-6 w-6' : 'h-5 w-5') : 'h-7 w-7',
      )}
      title={title}
    >
      {children}
    </button>
  );
}

export function ImageHoverActions({
  payload,
  onPreview,
  compact = false,
  inline = false,
  showPreview = true,
  showDownload = true,
  showCopy = false,
  showAddToAssets = true,
  showUseAsReference = true,
  extraActions,
  className,
}: ImageHoverActionsProps) {
  const buttons = (
    <>
      {showPreview && onPreview && (
        <ActionButton
          title="看大图"
          compact={compact}
          inline={inline}
          onClick={event => {
            stop(event);
            onPreview();
          }}
        >
          <Eye className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showAddToAssets && (
        <ActionButton
          title="添加到素材库"
          compact={compact}
          inline={inline}
          onClick={event => {
            stop(event);
            void runImageAction('add-to-assets', payload);
          }}
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showDownload && (
        <ActionButton
          title="下载"
          compact={compact}
          inline={inline}
          onClick={event => {
            stop(event);
            void runImageAction('download', payload);
          }}
        >
          <Download className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showCopy && (
        <ActionButton
          title="复制图片"
          compact={compact}
          inline={inline}
          onClick={event => {
            stop(event);
            void runImageAction('copy', payload);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showUseAsReference && (
        <ActionButton
          title="作为图生图参考"
          compact={compact}
          inline={inline}
          onClick={event => {
            stop(event);
            void runImageAction('use-as-reference', payload);
          }}
        >
          <Wand2 className="h-3.5 w-3.5" />
        </ActionButton>
      )}
    </>
  );

  if (inline) {
    return (
      <div className={cn('flex flex-wrap items-center gap-1', className)}>
        {buttons}
        {extraActions}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-20 hidden items-center justify-center bg-black/0 opacity-0 transition-all group-hover:flex group-hover:bg-black/40 group-hover:opacity-100 md:flex md:opacity-0',
        compact ? 'flex-wrap gap-1 p-1' : 'gap-1.5',
        className,
      )}
    >
      {buttons}
      {extraActions && <div className="pointer-events-auto">{extraActions}</div>}
    </div>
  );
}
