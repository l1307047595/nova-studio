'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileArchive,
  FileText,
  Grid3X3,
  ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ImageHoverActions } from '@/components/workspace/results/ImageHoverActions';
import { getAgentImageBytes } from '@/lib/agent-context-store';
import type { AgentImageRecord, AgentSelfCheck } from '@/lib/agent-chat-config';
import { describeSelfCheck } from '@/lib/nova-selfcheck';
import type { ImageActionPayload } from '@/lib/image-actions';
import { cn, clampIndex } from '@/lib/utils';
import { createPortal } from 'react-dom';

interface AgentImageGalleryProps {
  images: AgentImageRecord[];
  sessionId: string;
  /** 重新生成图片描述，传入 imgId 返回新描述文本 */
  onRedescribe?: (imgId: string) => Promise<string>;
  /** 手动补检：生图时没开自动自检，事后点按钮补跑 */
  onSelfCheck?: (imgId: string) => Promise<AgentSelfCheck | null>;
}

function getUsableDescription(description: string): string {
  const trimmed = description.trim();
  if (
    !trimmed ||
    trimmed === 'AI 未生成描述' ||
    trimmed === '(无描述)' ||
    trimmed === '(图片描述生成失败)'
  ) {
    return '';
  }
  return trimmed;
}

function getAgentImageSourceLabel(source: AgentImageRecord['source']): string {
  if (source === 'generated') return 'Agent 生成图片';
  if (source === 'asset') return '素材库导入';
  return 'Agent 上传图片';
}

function getAgentImageSourceBadge(source: AgentImageRecord['source']): string {
  if (source === 'generated') return '生成';
  if (source === 'asset') return '素材';
  return '上传';
}

function sanitizeFilePart(value: string, maxLength = 40): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

/**
 * 起一个能区分的下载文件名（不带扩展名）：`序号_来源_商品或描述_imgId`。
 * 例：`01_生成_捏捏乐-圣诞款_img_12`、`02_参考_白底主图_img_3`。
 * 批量下载时不会互相覆盖，也不用靠 img_12 这种看不出是什么的编号。
 */
function buildAgentImageBaseName(record: AgentImageRecord, index: number): string {
  const sourceLabel = record.source === 'generated' ? '生成' : record.source === 'asset' ? '素材' : '参考';
  const tag = sanitizeFilePart(record.productName || '')
    || sanitizeFilePart(getUsableDescription(record.description) || '')
    || '图片';
  const seq = String(index + 1).padStart(2, '0');
  return `${seq}_${sourceLabel}_${tag}_${record.imgId}`;
}

/** 触发一次浏览器下载（逐个下载时复用） */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getBlobExtension(blob: Blob): string {
  return (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
}

export function AgentImageGallery({ images, sessionId, onRedescribe, onSelfCheck }: AgentImageGalleryProps) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewImages, setPreviewImages] = useState<string[] | null>(null);
  const [previewSourceImages, setPreviewSourceImages] = useState<AgentImageRecord[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [downloadMode, setDownloadMode] = useState<'files' | 'zip' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [descDialogImg, setDescDialogImg] = useState<{ imgId: string; description: string } | null>(null);
  const [isSelfChecking, setIsSelfChecking] = useState(false);
  const [descCopied, setDescCopied] = useState(false);
  const [isRedescribing, setIsRedescribing] = useState(false);
  const previewObjectUrlsRef = useRef<string[]>([]);
  const previewTokenRef = useRef(0);

  const revokePreviewUrls = useCallback(() => {
    for (const url of previewObjectUrlsRef.current) URL.revokeObjectURL(url);
    previewObjectUrlsRef.current = [];
  }, []);

  const openPreview = useCallback(async (imgs: AgentImageRecord[], startIndex = 0) => {
    revokePreviewUrls();
    const token = ++previewTokenRef.current;
    const thumbs = imgs.map(i => i.thumbnail);
    setPreviewSourceImages(imgs);
    setPreviewIndex(clampIndex(startIndex, thumbs.length));
    setPreviewImages(thumbs);

    const blobs = await Promise.all(imgs.map(i => getAgentImageBytes(i.imgId, sessionId)));
    if (token !== previewTokenRef.current) return;

    const objectUrls: string[] = [];
    const fullSrcs = thumbs.map((thumb, idx) => {
      const blob = blobs[idx];
      if (!blob) return thumb;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      return url;
    });
    previewObjectUrlsRef.current = objectUrls;
    setPreviewImages(fullSrcs);
  }, [revokePreviewUrls, sessionId]);

  const closePreview = useCallback(() => {
    previewTokenRef.current++;
    revokePreviewUrls();
    setPreviewImages(null);
    setPreviewSourceImages([]);
  }, [revokePreviewUrls]);

  useEffect(() => revokePreviewUrls, [revokePreviewUrls]);

  const makeActionPayload = useCallback((img: AgentImageRecord): ImageActionPayload => {
    const index = Math.max(0, images.findIndex(item => item.imgId === img.imgId));
    return {
      id: img.imgId,
      // 单张下载/存素材也用可区分的名字（原先直接是 img_1）
      name: buildAgentImageBaseName(img, index),
      agentImageId: img.imgId,
      sourceKind: 'agent',
      sourceLabel: getAgentImageSourceLabel(img.source),
      sourceRef: img.imgId,
      prompt: getUsableDescription(img.description) || img.description,
      note: getUsableDescription(img.description),
      sessionId,
    };
  }, [images, sessionId]);

  // 搜索过滤
  const filteredImages = useMemo(() => {
    if (!searchQuery.trim()) return images;
    const q = searchQuery.toLowerCase();
    return images.filter(img =>
      img.imgId.toLowerCase().includes(q) ||
      img.description.toLowerCase().includes(q)
    );
  }, [images, searchQuery]);

  // 选择 / 取消选择
  const toggleSelect = useCallback((imgId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(imgId)) next.delete(imgId);
      else next.add(imgId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === filteredImages.length) return new Set();
      return new Set(filteredImages.map(i => i.imgId));
    });
  }, [filteredImages]);

  // 下载选中的图片：默认「逐个下载」（一张张落盘，不用解压），也可选打包 ZIP
  const handleDownload = useCallback(async (mode: 'files' | 'zip') => {
    if (selectedIds.size === 0) return;
    setDownloadMode(mode);
    try {
      const selected = Array.from(selectedIds)
        .map(id => images.find(i => i.imgId === id))
        .filter((record): record is AgentImageRecord => Boolean(record));
      if (mode === 'zip') {
        const zip = new JSZip();
        let readme = 'Agent 对话图片导出\n\n';
        let index = 0;
        for (const record of selected) {
          const blob = await getAgentImageBytes(record.imgId, sessionId);
          if (!blob) { index += 1; continue; }
          const name = `${buildAgentImageBaseName(record, index)}.${getBlobExtension(blob)}`;
          zip.file(name, blob);
          readme += `${name}\n  描述: ${record.description}\n\n`;
          index += 1;
        }
        zip.file('README.txt', readme);
        const content = await zip.generateAsync({ type: 'blob' });
        triggerDownload(content, `agent-images-${Date.now()}.zip`);
        return;
      }
      // 逐个下载：每张一个可区分的文件名，逐张落盘（留一点间隔，避免被浏览器合并/拦截）
      let index = 0;
      for (const record of selected) {
        const blob = await getAgentImageBytes(record.imgId, sessionId);
        if (blob) {
          triggerDownload(blob, `${buildAgentImageBaseName(record, index)}.${getBlobExtension(blob)}`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        index += 1;
      }
    } finally {
      setDownloadMode(null);
    }
  }, [selectedIds, images, sessionId]);

  // 关闭对话框时清空选择
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSelectedIds(new Set());
      setSearchQuery('');
    }
  }, []);

  const selectedCount = selectedIds.size;

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="gap-1 text-muted-foreground"
        disabled={images.length === 0}
        onClick={() => setOpen(true)}
        title="查看当前对话的所有图片"
      >
        <ImageIcon className="h-3.5 w-3.5" />
        此对话包含的图片
        {images.length > 0 && (
          <span className="ml-0.5 rounded-full bg-muted-foreground/10 px-1 text-[10px] tabular-nums">
            {images.length}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-4xl sm:h-auto max-h-[90dvh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Grid3X3 className="h-4 w-4" />
              此对话包含的图片
              <span className="text-xs font-normal text-muted-foreground">
                ({images.length} 张)
              </span>
            </DialogTitle>
          </DialogHeader>

          {/* 工具栏 */}
          <div className="flex items-center gap-2 border-b pb-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索 img_id 或描述..."
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleSelectAll}
              className="shrink-0 gap-1.5"
            >
              <Check className="h-3.5 w-3.5" />
              {selectedCount === filteredImages.length && filteredImages.length > 0
                ? '取消全选'
                : '全选'}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleDownload('files')}
              disabled={selectedCount === 0 || downloadMode !== null}
              className="shrink-0 gap-1.5"
              title="逐张下载（不打包；文件名带序号/来源/商品，便于区分）"
            >
              {downloadMode === 'files' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {downloadMode === 'files'
                ? '下载中…'
                : selectedCount > 0
                  ? `下载 (${selectedCount})`
                  : '下载'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDownload('zip')}
              disabled={selectedCount === 0 || downloadMode !== null}
              className="shrink-0 gap-1.5"
              title="打包成一个 ZIP 下载（含描述 README）"
            >
              {downloadMode === 'zip' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileArchive className="h-3.5 w-3.5" />
              )}
              ZIP
            </Button>
          </div>

          {/* 图片网格 */}
          {filteredImages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ImageIcon className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-sm">
                {searchQuery ? '没有匹配的图片' : '暂无图片'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 overflow-y-auto py-3 sm:grid-cols-3 md:grid-cols-4">
              {filteredImages.map((img, index) => (
                <div
                  key={img.imgId}
                  className={cn(
                    'group relative flex flex-col overflow-hidden rounded-lg border transition-colors',
                    selectedIds.has(img.imgId)
                      ? 'border-primary ring-1 ring-primary/30'
                      : 'border-border hover:border-muted-foreground/30'
                  )}
                >
                  {/* 缩略图 */}
                  <div className="relative aspect-square w-full overflow-hidden bg-muted">
                    <button
                      type="button"
                      onClick={() => void openPreview(filteredImages, index)}
                      className="block h-full w-full"
                    >
                      <img
                        src={img.thumbnail}
                        alt={img.imgId}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                      {/* imgId 角标 */}
                      <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 text-[9px] text-white">
                        {img.imgId}
                      </span>
                      {/* 来源标签 */}
                      <span className={cn(
                        'absolute right-1.5 top-1.5 rounded px-1 text-[9px] font-medium',
                        img.source === 'generated'
                          ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]'
                          : 'bg-secondary text-muted-foreground'
                      )}>
                        {getAgentImageSourceBadge(img.source)}
                      </span>
                      {/* 自检结论角标：只标已检过的图，未检的保持干净 */}
                      {img.selfCheck?.status === 'warn' && (
                        <span
                          className="absolute bottom-1.5 left-1.5 rounded bg-destructive/85 px-1 text-[9px] font-medium text-white"
                          title={img.selfCheck.issues.map(issue => `${issue.kind}：${issue.detail}`).join('\n') || img.selfCheck.summary}
                        >
                          ⚠ {img.selfCheck.issues.length || 1}
                        </span>
                      )}
                      {img.selfCheck?.status === 'pass' && (
                        <span className="absolute bottom-1.5 left-1.5 rounded bg-emerald-500/80 px-1 text-[9px] font-medium text-white" title="自检通过：与参考图一致">
                          ✓
                        </span>
                      )}
                    </button>
                    <ImageHoverActions
                      payload={makeActionPayload(img)}
                      onPreview={() => void openPreview(filteredImages, index)}
                      showDownload
                      showCopy
                      showAddToAssets
                      showUseAsReference
                      className="grid grid-cols-3 place-content-center place-items-center gap-1.5 p-2 [&>button]:mx-auto [&>div]:mx-auto"
                      extraActions={(
                        <button
                          type="button"
                          onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            setDescDialogImg({ imgId: img.imgId, description: img.description || '(无描述)' });
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                          title="查看描述"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                      )}
                    />
                  </div>

                  {/* 描述 + 复选框 */}
                  <div className="flex items-start gap-1.5 px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(img.imgId)}
                      onChange={() => toggleSelect(img.imgId)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                      title="选择此图片"
                    />
                    <p className="line-clamp-2 min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                      {img.description || '(无描述)'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 全屏预览 */}
      {previewImages && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt="agent 图片"
          initialIndex={previewIndex}
          onClose={closePreview}
          actionPayloads={previewSourceImages.map(makeActionPayload)}
        />,
        document.body
      )}

      {/* 图片描述对话框 */}
      {descDialogImg && (
        <Dialog open={!!descDialogImg} onOpenChange={(open) => { if (!open) { setDescDialogImg(null); setDescCopied(false); } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>图片描述 — {descDialogImg.imgId}</DialogTitle>
            </DialogHeader>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {descDialogImg.description}
            </div>

            {/* 出图自检：结论 + 手动补检（自动自检关掉时用这个） */}
            {(() => {
              const record = images.find(item => item.imgId === descDialogImg.imgId);
              const selfCheck = record?.selfCheck;
              const info = describeSelfCheck(selfCheck);
              return (
                <div className="mt-3 rounded-lg border border-border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      'text-xs font-medium',
                      info.tone === 'warn' ? 'text-destructive' : info.tone === 'pass' ? 'text-emerald-600' : 'text-muted-foreground',
                    )}>
                      {info.label}
                    </span>
                    {onSelfCheck && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px]"
                        disabled={isSelfChecking}
                        onClick={async () => {
                          setIsSelfChecking(true);
                          try {
                            await onSelfCheck(descDialogImg.imgId);
                          } catch {
                            /* runSelfCheck 内部已把失败原因写进结果 */
                          } finally {
                            setIsSelfChecking(false);
                          }
                        }}
                      >
                        <ShieldCheck className={cn('h-3.5 w-3.5', isSelfChecking && 'animate-pulse')} />
                        {isSelfChecking ? '自检中…' : selfCheck ? '重新自检' : '自检'}
                      </Button>
                    )}
                  </div>
                  {info.detail ? (
                    <div className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{info.detail}</div>
                  ) : null}
                  {selfCheck?.status === 'warn' ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">{selfCheck.summary}</div>
                  ) : null}
                </div>
              );
            })()}

            <div className="mt-2 flex items-center justify-end gap-2 border-t pt-3">
              {(!descDialogImg.description ||
                descDialogImg.description === 'AI 未生成描述' ||
                descDialogImg.description === '(无描述)' ||
                descDialogImg.description === '(图片描述生成失败)') && onRedescribe && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={isRedescribing}
                  onClick={async () => {
                    setIsRedescribing(true);
                    try {
                      const newDesc = await onRedescribe(descDialogImg.imgId);
                      setDescDialogImg(prev => prev ? { ...prev, description: newDesc || '(无描述)' } : null);
                    } catch {
                      // redescribeImage 内部已处理异常
                    } finally {
                      setIsRedescribing(false);
                    }
                  }}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRedescribing ? 'animate-spin' : ''}`} />
                  {isRedescribing ? '生成中…' : '重新生成描述'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(descDialogImg.description).catch(() => {});
                  setDescCopied(true);
                  setTimeout(() => setDescCopied(false), 2000);
                }}
              >
                {descCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {descCopied ? '已复制' : '复制描述'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
