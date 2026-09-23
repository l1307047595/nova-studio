'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { generateUUID } from '@/lib/uuid';
import { createNovaTask, getNovaTask, resolveImageTaskProvider, type ImageReference } from '@/lib/ccode-task-client';
import { fetchImageAsBlob } from '@/lib/image-downloader';
import {
  getGptImageAdvancedParamsForModel,
  resolveAgentModel,
  resolveSubmitLayout,
  type AgentModelCatalogEntry,
  type AgentResolvedLayout,
} from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import {
  getCompleteImageModels,
  getDefaultImageModel,
  getImageModelById,
  loadRegistry,
} from '@/lib/nova-models';
import {
  streamAgentChat,
  describeImage,
  selfCheckImages,
  type StreamAgentHandle,
} from '@/lib/agent-chat-client';
import { isAutoSelfCheckEnabled, parseSelfCheckOutput } from '@/lib/nova-selfcheck';
import type { AgentSelfCheck } from '@/lib/agent-chat-config';
import { executeAgentCdpTool, purgeCdpProductImages } from '@/lib/agent-cdp-tools';
import {
  loadAgentMemory, latestUserQuery, appendMemoryEntry, listPendingDrafts,
  approvePendingDraft, rejectPendingDraft, approveAllPendingDrafts,
  queueMemoryDraft, isSessionAutoWriteEnabled, fetchMemoryEntries, getCurrentMemory,
  type MemoryNoteKind, type PendingDraft,
} from '@/lib/nova-memory';
import { sinkAgentMemory, buildSinkTranscript, draftMemoryNote, draftReviewProposals } from '@/lib/nova-memory-sink';
import {
  AGENT_DEFAULT_IMAGE_MODEL_FALLBACK,
  extractComplianceRules,
  extractProductLinks,
  normalizeProductKey,
  type AgentMessage,
  type AgentImageRecord,
  type AgentProposal,
} from '@/lib/agent-chat-config';
import {
  loadAgentSession,
  putMessage,
  putImageRecord,
  saveImageModel,
  clearAgentSession,
  getAgentSessionGeneration,
  invalidateAgentSession,
  isAgentSessionGenerationCurrent,
  storeAgentImageBytes,
  getAgentImageBase64,
  deleteMessages,
  deleteImageRecords,
  deleteAgentImageIfUnreferenced,
  deleteAgentImageBytes,
  sweepAgentOrphanBlobsOnce,
  savePendingProposal,
  loadPendingProposal,
  clearPendingProposal,
  savePendingGenerationTask,
  loadPendingGenerationTasks,
  removePendingGenerationTask,
  clearPendingGenerationTasks,
  type PendingGenerationData,
} from '@/lib/agent-context-store';
import { getDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { supportsAgentNativeWebSearch } from '@/lib/nova-text-protocol';

export type AgentPhase = 'idle' | 'loading' | 'describing' | 'streaming' | 'proposal' | 'generating';

/** 流式期间「正在生成的助手消息」的落库状态（思考过程也要能持久化） */
interface LiveAssistantMessage {
  id: string;
  sessionId: string;
  createdAt: number;
  text: string;
  reasoning: string;
  /** 上次落库时间，用于节流 */
  lastWrite: number;
}

function snapshotLiveMessage(live: LiveAssistantMessage): AgentMessage {
  return {
    id: live.id,
    role: 'assistant',
    text: live.text,
    reasoning: live.reasoning || undefined,
    createdAt: live.createdAt,
  };
}

/**
 * 加载会话时的自愈：上次回复没写完（客户端中途关闭/刷新）会留下 streaming:true 的行，
 * 标成「上次回复中断」并清掉落库残留的空气泡（没有正文、没有图片的助手消息）。
 */
function normalizeLoadedMessages(messages: AgentMessage[]): {
  messages: AgentMessage[];
  repaired: AgentMessage[];
  droppedIds: string[];
} {
  const repaired: AgentMessage[] = [];
  const droppedIds: string[] = [];
  const out: AgentMessage[] = [];
  for (const message of messages) {
    const emptyAssistant = message.role === 'assistant'
      && !message.text?.trim()
      && !(message.imageIds && message.imageIds.length > 0)
      && !message.taskId;
    if (emptyAssistant) {
      droppedIds.push(message.id);
      continue;
    }
    if (message.streaming) {
      const healed: AgentMessage = { ...message, streaming: false, text: `${message.text}\n\n（上次回复中断）` };
      repaired.push(healed);
      out.push(healed);
      continue;
    }
    out.push(message);
  }
  return { messages: out, repaired, droppedIds };
}

export type AgentCheckResult = 'idle' | 'completed' | 'processing' | 'queued' | 'failed' | 'error';

export interface AgentGenerationDraft {
  analysis: string;
  reasoning?: string;
  prompt: string;
  parallelCount: number;
  taskId?: string;
  startedAt: number;
}

export interface PendingUpload {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
  source?: AgentImageRecord['source'];
}

const PREVIEW_MAX_SIDE = 512;

function isStoppedError(error: unknown): boolean {
  return error instanceof Error && error.message === '已停止';
}

/** 构建当前可用的图像模型目录，供 Agent 选择模型 */
function buildModelCatalog(): AgentModelCatalogEntry[] {
  return getCompleteImageModels(loadRegistry()).map(m => ({
    id: m.id,
    name: m.name,
    maxOutputSize: m.maxOutputSize,
  }));
}

/**
 * Agent 生图模型必须落在用户注册表里，否则确认生图时会报「未找到图片模型配置」。
 * 硬编码兜底（gemini-3-pro-image-preview）不在注册表时，改用设置里的默认图像模型。
 */
function resolveValidAgentImageModel(preferred?: string | null): ModelId {
  const registry = loadRegistry();
  if (preferred && getImageModelById(registry, preferred)) return preferred as ModelId;
  const configured =
    getDefaultImageModel(registry, 'imageToImage') ||
    getDefaultImageModel(registry, 'textToImage') ||
    getCompleteImageModels(registry)[0];
  return (configured?.id || AGENT_DEFAULT_IMAGE_MODEL_FALLBACK) as ModelId;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}


/** 从 Blob 直接生成缩略图 dataUrl，避免全尺寸 base64 转换 */
async function makePreviewFromBlob(blob: Blob): Promise<{ dataUrl: string; width: number; height: number }> {
  try {
    const blobUrl = URL.createObjectURL(blob);
    const img = await loadImage(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w <= PREVIEW_MAX_SIDE && h <= PREVIEW_MAX_SIDE) {
      // 小图直接转 dataUrl（尺寸小，不影响性能）
      const smallDataUrl = await blobToDataUrl(blob);
      return { dataUrl: smallDataUrl, width: w, height: h };
    }
    const scale = PREVIEW_MAX_SIDE / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = await blobToDataUrl(blob);
      return { dataUrl: fallback, width: w, height: h };
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h };
  } catch {
    const fallback = await blobToDataUrl(blob);
    return { dataUrl: fallback, width: 0, height: 0 };
  }
}

function parseImgSeq(imgId: string): number {
  const match = imgId.match(/^img_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/**
 * 按最后一个上下文分隔点切片：分隔点之前的对话和图片对模型不可见。
 * 界面仍展示全部消息，这里只影响喂给模型的上下文。
 */
function sliceActiveContext(
  history: AgentMessage[],
  catalog: AgentImageRecord[],
): { history: AgentMessage[]; catalog: AgentImageRecord[] } {
  let dividerIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'context-divider') { dividerIndex = i; break; }
  }
  if (dividerIndex === -1) return { history, catalog };

  const dividerAt = history[dividerIndex].createdAt;
  return {
    history: history.slice(dividerIndex + 1),
    catalog: catalog.filter(img => img.createdAt > dividerAt),
  };
}

async function resultImageToBlob(ref: string): Promise<Blob> {
  if (ref.startsWith('URL:')) return fetchImageAsBlob(ref.slice(4));
  if (ref.startsWith('MULTI_URL:')) return fetchImageAsBlob(ref.slice(10).split('|||')[0]);
  if (ref.startsWith('data:')) {
    const base64 = ref.split(',')[1] || '';
    const mime = ref.slice(5).split(';')[0] || 'image/png';
    return base64ToBlob(base64, mime);
  }
  return base64ToBlob(ref, 'image/png');
}

export function useAgentChat(sessionId = 'default') {
  const sessionIdRef = useRef(sessionId);

  // ===== 记忆读写时机控制 =====
  // 读：会话开始 / 新图上传（见 loadAgentMemory 调用点）；写：空闲心跳（见下方 useEffect）
  const MEMORY_IDLE_MS = 3 * 60 * 1000;   // 3 分钟无新对话才算空闲
  const memoryActivityRef = useRef(Date.now());
  const memoryUndepositedRef = useRef(0);
  const memorySinkBusyRef = useRef(false);
  // 待确认草稿（心跳只入队，你确认后才写进真记忆文件）
  const [pendingDrafts, setPendingDrafts] = useState<PendingDraft[]>([]);
  // 复盘状态（累计新增 N 条就提醒）
  const [memoryReview, setMemoryReview] = useState<{ due: boolean; count: number; threshold: number } | null>(null);
  const [memoryReviewBusy, setMemoryReviewBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasApiKey] = useState(() => hasAnyApiKey());
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [images, setImages] = useState<AgentImageRecord[]>([]);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  /** 当前提案之后等待展示的独立商品提案；用户确认/取消当前项后自动推进。 */
  const [, setProposalQueue] = useState<AgentProposal[]>([]);
  const proposalQueueRef = useRef<AgentProposal[]>([]);
  /** 最近一条用户消息里的商品链接（归一化键）；非空表示当前处于「批量商品轮」，任务完成后允许自动续跑 */
  const userLinksRef = useRef<string[]>([]);
  /** 批量轮内已自动续跑的次数；上限只是防失控兜底，是否继续由模型对照原始需求自己判断 */
  const autoContinueCountRef = useRef(0);
  const messagesRef = useRef<AgentMessage[]>([]);
  const imagesRef = useRef<AgentImageRecord[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  const phaseRef = useRef<AgentPhase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [imageModel, setImageModelState] = useState<ModelId>(() => resolveValidAgentImageModel());
  const [error, setError] = useState<string | null>(null);
  const [generatingTaskId, setGeneratingTaskId] = useState<string | null>(null);
  const [generatingStartedAt, setGeneratingStartedAt] = useState<number | null>(null);
  const [generationDraft, setGenerationDraft] = useState<AgentGenerationDraft | null>(null);
  const [activeGenerationCount, setActiveGenerationCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('nova-agent-web-search') === 'true' : false
  );
  const [cdpEnabled, setCdpEnabled] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('nova-agent-cdp') === 'true' : false
  );
  const [intentRecognition, setIntentRecognition] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('nova-agent-intent-recognition') !== 'false' : true
  );

  const streamHandleRef = useRef<StreamAgentHandle | null>(null);
  const mountedRef = useRef(true);
  const pollControllersRef = useRef(new Map<string, { controller: AbortController; wake: () => void }>()).current;
  const activeGenerationTasksRef = useRef(new Map<string, number>());
  const generationsToResumeRef = useRef<PendingGenerationData[]>([]);
  const generationEpochRef = useRef(0);
  const sessionGenerationRef = useRef(getAgentSessionGeneration(sessionId));
  const isSessionCurrent = useCallback((generation: number) => (
    mountedRef.current
    && sessionGenerationRef.current === generation
    && isAgentSessionGenerationCurrent(generation, sessionIdRef.current)
  ), []);
  const describeAbortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  /** 当模型返回提案时，暂存分析文本，等生图完成后与结果合并为一条消息 */
  const pendingAnalysisRef = useRef('');
  const pendingReasoningRef = useRef('');
  /** 标记当前提案是否来自"重新编辑"（而非新消息触发），用于取消时决定是否允许撤回 */
  const isReeditRef = useRef(false);
  /** 保存当前提案引用，生图完成后若 state proposal 已被清除时仍可获取 reason 等字段 */
  const proposalRef = useRef<AgentProposal | null>(null);
  /** 镜像 imageModel state，供 runChat 回调中同步读取 */
  const imageModelRef = useRef(imageModel);
  useEffect(() => { imageModelRef.current = imageModel; }, [imageModel]);

  const getAgentTextModelConfig = useCallback(() => {
    const configured = getDefaultConfiguredTextModel('agent');
    if (!configured?.apiKey || !configured.baseUrl || !configured.modelId) {
      throw new Error('请先在设置中完成 Agent 默认文本模型配置');
    }
    return configured;
  }, []);

  const agentSupportsWebSearch = useCallback(() => {
    const configured = getDefaultConfiguredTextModel('agent');
    if (!configured?.apiKey || !configured.baseUrl || !configured.modelId) {
      return false;
    }
    return supportsAgentNativeWebSearch(configured.protocol);
  }, []);

  // ===== 流式更新批处理（rAF 节流） =====
  const streamingTextBufRef = useRef('');
  const streamingReasoningBufRef = useRef('');
  const rafIdRef = useRef<number | null>(null);

  /** 刷新流式文本到 state（每帧调用一次） */
  const flushStreamingBuffers = useCallback(() => {
    rafIdRef.current = null;
    const text = streamingTextBufRef.current;
    const reasoning = streamingReasoningBufRef.current;
    streamingTextBufRef.current = '';
    streamingReasoningBufRef.current = '';
    if (!mountedRef.current) return;
    if (text) setStreamingText(prev => prev + text);
    if (reasoning) setStreamingReasoning(prev => prev + reasoning);
  }, []);

  /** 将 token 追加到缓冲区，并调度下一帧刷新 */
  const appendStreamingToken = useCallback((type: 'text' | 'reasoning', token: string) => {
    if (!mountedRef.current) return;
    if (type === 'text') streamingTextBufRef.current += token;
    else streamingReasoningBufRef.current += token;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushStreamingBuffers);
    }
  }, [flushStreamingBuffers]);

  /** 立即刷新并取消待处理的 rAF（在 onDone/onReset/清理时调用） */
  const flushAndCancelRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const text = streamingTextBufRef.current;
    const reasoning = streamingReasoningBufRef.current;
    streamingTextBufRef.current = '';
    streamingReasoningBufRef.current = '';
    if (!mountedRef.current) return;
    if (text) setStreamingText(prev => prev + text);
    if (reasoning) setStreamingReasoning(prev => prev + reasoning);
  }, []);

  // ===== 流式过程的落库（思考中也要有持久性） =====
  // 背景：以前助手消息只在 onDone 才落库，而且 onDone 开头有「会话已切走就 return」，
  // 于是思考过程中换会话/刷新会整段回复丢失。现在：开流就登记一条助手消息（streaming:true），
  // 流式期间按间隔覆盖写入，结束时用同一个 id 写最终文本——不产生重复气泡。

  /** 写进「发起本次回复的会话」。用该会话自己的当前 generation，故切走会话也不会被作废拦下 */
  const persistMessageToSession = useCallback(async (message: AgentMessage, sessionId: string) => {
    try {
      await putMessage(message, sessionId, getAgentSessionGeneration(sessionId));
    } catch {
      // 落库失败不打断对话；下一次间隔写入会再试
    }
  }, []);

  const STREAM_PERSIST_INTERVAL_MS = 1200;

  const beginLiveMessage = useCallback((sessionId: string): LiveAssistantMessage => {
    const live: LiveAssistantMessage = {
      id: generateUUID(),
      sessionId,
      createdAt: Date.now(),
      text: '',
      reasoning: '',
      lastWrite: Date.now(),
    };
    void persistMessageToSession({ ...snapshotLiveMessage(live), streaming: true }, sessionId);
    return live;
  }, [persistMessageToSession]);

  /** 流式期间的节流写入（默认 1.2 秒一次），避免每个 token 都写一次 IndexedDB */
  const tickLiveMessage = useCallback((live: LiveAssistantMessage) => {
    const now = Date.now();
    if (now - live.lastWrite < STREAM_PERSIST_INTERVAL_MS) return;
    live.lastWrite = now;
    void persistMessageToSession({ ...snapshotLiveMessage(live), streaming: true }, live.sessionId);
  }, [persistMessageToSession]);

  /** 收尾写入：同一 id 覆盖，streaming 去掉，表示这条回复已经结束 */
  const finishLiveMessage = useCallback((live: LiveAssistantMessage, text?: string, reasoning?: string) => {
    if (typeof text === 'string') live.text = text;
    if (typeof reasoning === 'string') live.reasoning = reasoning;
    live.lastWrite = Date.now();
    void persistMessageToSession(snapshotLiveMessage(live), live.sessionId);
  }, [persistMessageToSession]);

  /** 没有内容的占位行（提案分支 / 空回复）直接删掉，别在会话里留空气泡 */
  const dropLiveMessage = useCallback((live: LiveAssistantMessage) => {
    // 存储层任何异常都不能打断对话；也不能假设它一定返回 Promise
    try {
      void Promise.resolve(deleteMessages([live.id], live.sessionId)).catch(() => undefined);
    } catch {
      // 忽略：残留的行会在下次加载时被 normalizeLoadedMessages 清掉
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    // 启动时顺带清扫孤儿 blob（登记记录已删但字节残留），只动 Agent 命名空间
    void sweepAgentOrphanBlobsOnce();
    (async () => {
      const [session, pending, generations] = await Promise.all([
        loadAgentSession(sessionIdRef.current),
        loadPendingProposal(sessionIdRef.current),
        loadPendingGenerationTasks(sessionIdRef.current),
      ]);
      if (cancelled || !mountedRef.current) return;
      // 自愈：上次回复没写完的（streaming 行）标成「上次回复中断」；空气泡清掉并落库修正
      const healed = normalizeLoadedMessages(session.messages);
      if (healed.repaired.length > 0 || healed.droppedIds.length > 0) {
        const gen = getAgentSessionGeneration(sessionIdRef.current);
        for (const message of healed.repaired) void putMessage(message, sessionIdRef.current, gen);
        if (healed.droppedIds.length > 0) {
          void deleteMessages(healed.droppedIds, sessionIdRef.current).catch(() => undefined);
        }
      }
      messagesRef.current = healed.messages;
      imagesRef.current = session.images;
      setMessages(healed.messages);
      setImages(session.images);
      seqRef.current = session.images.reduce((max, img) => Math.max(max, parseImgSeq(img.imgId)), 0);
      const validImageModel = resolveValidAgentImageModel(session.imageModel);
      imageModelRef.current = validImageModel;
      setImageModelState(validImageModel);

      if (pending) {
        pendingAnalysisRef.current = pending.pendingAnalysis;
        pendingReasoningRef.current = pending.pendingReasoning;
        isReeditRef.current = pending.isReedit;
        setProposal(pending.proposal);
        proposalQueueRef.current = pending.queuedProposals || [];
        setProposalQueue(pending.queuedProposals || []);
        phaseRef.current = 'proposal';
        setPhase('proposal');
      }

      const generationEpoch = generationEpochRef.current;
      for (const generation of generations) {
        activeGenerationTasksRef.current.set(generation.taskId, generationEpoch);
      }
      setActiveGenerationCount(activeGenerationTasksRef.current.size);
      generationsToResumeRef.current = generations;

      const foreground = generations.find(generation => !generation.background);
      if (foreground) {
        pendingAnalysisRef.current = foreground.pendingAnalysis;
        pendingReasoningRef.current = foreground.pendingReasoning;
        proposalRef.current = foreground.proposal;
        setGeneratingTaskId(foreground.taskId);
        setGeneratingStartedAt(foreground.startedAt);
        setGenerationDraft({
          analysis: foreground.pendingAnalysis || foreground.proposal.reason || '根据你的描述，正在生成图片。',
          reasoning: foreground.pendingReasoning || undefined,
          prompt: foreground.proposal.prompt,
          parallelCount: foreground.parallelCount,
          taskId: foreground.taskId,
          startedAt: foreground.startedAt,
        });
        phaseRef.current = 'generating';
        setPhase('generating');
      }

      setReady(true);
      // 会话开始：读一次本类目记忆（按规格，会话中途不再读取）
      void loadAgentMemory({
        sessionId: sessionIdRef.current,
        query: latestUserQuery(session.messages.map(item => ({ role: item.role, text: item.text }))),
      });
      void listPendingDrafts().then(store => setPendingDrafts(store.items));   // 待确认角标
    })();
    return () => { cancelled = true; };
  }, []);

  // ===== 记忆沉淀心跳 =====
  // 触发条件：无进行中的生成任务 && 空闲到阈值 && 本会话有未沉淀变更
  // 空闲阈值可调（不写死）：localStorage['nova-memory-idle-ms']，默认 3 分钟
  useEffect(() => {
    const pushSinkLog = (entry: Record<string, unknown>) => {
      const holder = window as unknown as { __memorySinkLog?: Array<Record<string, unknown>> };
      holder.__memorySinkLog = holder.__memorySinkLog || [];
      holder.__memorySinkLog.push({ at: new Date().toISOString(), ...entry });
      if (holder.__memorySinkLog.length > 40) holder.__memorySinkLog.shift();
    };
    const timer = window.setInterval(() => {
      const idleMs = Number(localStorage.getItem('nova-memory-idle-ms')) || MEMORY_IDLE_MS;
      if (memorySinkBusyRef.current) return;
      if (memoryUndepositedRef.current === 0) {
        return;
      }
      if (activeGenerationCount > 0) {
        pushSinkLog({ skip: '有进行中的生成任务', activeGenerationCount });
        return;
      }
      const idleFor = Date.now() - memoryActivityRef.current;
      if (idleFor < idleMs) {
        pushSinkLog({ skip: '未到空闲阈值', idleFor, idleMs });
        return;
      }
      let configured: ReturnType<typeof getAgentTextModelConfig>;
      try {
        configured = getAgentTextModelConfig();
      } catch {
        pushSinkLog({ skip: '未配置文本模型' });
        return;   // 没配文本模型就不沉淀，不报错打扰
      }
      const transcript = buildSinkTranscript(messagesRef.current.map(item => ({ role: item.role, text: item.text })));
      if (!transcript.trim()) return;
      memorySinkBusyRef.current = true;
      pushSinkLog({ attempt: true, undeposited: memoryUndepositedRef.current, transcriptChars: transcript.length });
      void (async () => {
        // 先拿「你驳回过、别再提」的黑名单，再让模型起草
        const store = await listPendingDrafts();
        return sinkAgentMemory({
          apiKey: configured.apiKey,
          model: configured.modelId,
          protocol: configured.protocol,
          baseUrl: configured.baseUrl,
          sessionId: sessionIdRef.current,
          transcript,
          lastUserMessage: latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text }))),
          rejectedTexts: store.rejected,
          sessionAutoWrite: isSessionAutoWriteEnabled(),
        });
      })().then(result => {
        pushSinkLog({
          result: result.ok ? (result.skipped ? 'skipped' : 'ok') : 'failed',
          feedback: result.feedback,
          library: result.library,
          proposals: result.proposals,
          sessionWritten: result.sessionWritten,
          queued: result.queued,
          skipped: result.skipped,
          error: result.error,
        });
        if (result.ok) {
          // 跳过也算「这轮看过了」：否则同一个「只有寒暄」的记录每 30 秒被重扫一次，白刷日志
          memoryUndepositedRef.current = 0;
          if (!result.skipped) {
            void listPendingDrafts().then(next => setPendingDrafts(next.items));   // 刷新待确认角标
          }
        }
      }).catch(error => {
        pushSinkLog({ result: 'threw', error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        memorySinkBusyRef.current = false;
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeGenerationCount, getAgentTextModelConfig]);

  // ===== 待确认队列的操作（都在你手里：确认 / 驳回 / 全部确认） =====
  const refreshPendingDrafts = useCallback(async () => {
    const store = await listPendingDrafts();
    setPendingDrafts(store.items);
    if (store.review) setMemoryReview({ due: store.review.due, count: store.review.count, threshold: store.review.threshold });
    return store.items;
  }, []);

  /**
   * 复盘：把最近新增的纠错/案例交给 AI，起草「该升级进基础规则」的建议，进待确认队列。
   * 建议本身不会自动改规则——你确认 + 采纳后才追加进 identity。
   */
  const runMemoryReview = useCallback(async (): Promise<{ ok: boolean; count: number; error?: string }> => {
    setMemoryReviewBusy(true);
    try {
      let configured: ReturnType<typeof getAgentTextModelConfig>;
      try {
        configured = getAgentTextModelConfig();
      } catch {
        return { ok: false, count: 0, error: '请先在设置里配置 Agent 默认文本模型' };
      }
      const view = await fetchMemoryEntries();
      if (!view) return { ok: false, count: 0, error: '读取记忆失败' };
      const since = view.review.lastReviewAt || '';
      const recent = [...view.entries.feedback, ...view.entries.library]
        .filter(entry => {
          const match = entry.match(/^-\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
          return match ? match[1] > since : true;
        })
        .slice(-30);
      if (recent.length === 0) return { ok: false, count: 0, error: '最近没有新增的纠错/案例，暂时不用复盘' };
      const proposals = await draftReviewProposals({
        apiKey: configured.apiKey,
        model: configured.modelId,
        protocol: configured.protocol,
        baseUrl: configured.baseUrl,
        transcript: recent.join('\n\n'),
      });
      if (proposals.length === 0) return { ok: false, count: 0, error: 'AI 没找出值得固化的规则' };
      let queued = 0;
      for (const text of proposals) {
        const result = await queueMemoryDraft('proposal', text, { source: 'review', session: sessionIdRef.current });
        if (result.ok) queued += 1;
      }
      await refreshPendingDrafts();
      return { ok: true, count: queued };
    } finally {
      setMemoryReviewBusy(false);
    }
  }, [getAgentTextModelConfig, refreshPendingDrafts]);

  const approveDraft = useCallback(async (
    id: string,
    override: { kind?: MemoryNoteKind | 'session'; text?: string; session?: string } = {},
  ) => {
    const result = await approvePendingDraft(id, override);
    if (result.ok) {
      await refreshPendingDrafts();
      // 写进记忆了，立刻重读一次让后面几轮注入带上
      await loadAgentMemory({
        sessionId: sessionIdRef.current,
        query: latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text }))),
      });
    }
    return result;
  }, [refreshPendingDrafts]);

  const rejectDraft = useCallback(async (id: string) => {
    const result = await rejectPendingDraft(id);
    if (result.ok) await refreshPendingDrafts();
    return result;
  }, [refreshPendingDrafts]);

  const approveAllDrafts = useCallback(async () => {
    const result = await approveAllPendingDrafts();
    if (result.ok) {
      await refreshPendingDrafts();
      await loadAgentMemory({
        sessionId: sessionIdRef.current,
        query: latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text }))),
      });
    }
    return result;
  }, [refreshPendingDrafts]);

  /**
   * 「这张很好 → 存为案例」：拿这张图的描述当素材，让 AI 起草一条可复用案例，进待确认队列。
   * 你确认了才真的写进 library.md。
   */
  const draftCaseFromImage = useCallback(async (img: { imgId: string; description?: string }) => {
    let configured: ReturnType<typeof getAgentTextModelConfig>;
    try {
      configured = getAgentTextModelConfig();
    } catch {
      return { ok: false, error: '请先在设置里配置 Agent 默认文本模型' };
    }
    const description = String(img.description || '').trim();
    const transcript = [
      `【通过的图】${img.imgId}`,
      description ? `图片内容：${description}` : '',
      latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text })))
        ? `用户当时的诉求：${latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text })))}`
        : '',
    ].filter(Boolean).join('\n');
    const draft = await draftMemoryNote({
      apiKey: configured.apiKey,
      model: configured.modelId,
      protocol: configured.protocol,
      baseUrl: configured.baseUrl,
      transcript,
      preferredKind: 'library',
    });
    if (!draft) return { ok: false, error: 'AI 没能从这张图提炼出案例' };
    const queued = await queueMemoryDraft('library', draft.text, { source: 'image', session: sessionIdRef.current });
    if (queued.ok) await refreshPendingDrafts();
    return queued;
  }, [getAgentTextModelConfig, refreshPendingDrafts]);

  // 新图上传 / 抓图入库后，重新读一次记忆（规格：只要我有新图上传就读取记忆）
  const reloadMemoryForCurrentSession = useCallback(() => {
    memoryActivityRef.current = Date.now();
    memoryUndepositedRef.current += 1;
    void loadAgentMemory({
      sessionId: sessionIdRef.current,
      query: latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text }))),
    });
  }, []);

  /**
   * 手动记一条（「记一条」按钮用）：你主动写的记忆，追加进本类目记忆。
   * 写完立刻重读一次，让后面几轮的注入马上带上这条——自动写入仍然只在空闲心跳发生。
   */
  const rememberMemoryEntry = useCallback(async (
    kind: 'feedback' | 'library' | 'proposal' | 'recent',
    text: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const result = await appendMemoryEntry(kind, text);
    if (result.ok) {
      await loadAgentMemory({
        sessionId: sessionIdRef.current,
        query: latestUserQuery(messagesRef.current.map(item => ({ role: item.role, text: item.text }))),
      });
    }
    return result;
  }, []);

  /**
   * 「记一条」的 AI 起草：从当前对话里提炼一条记忆，填进框里给你审。
   * 你改完再点写入 —— 你不点，什么都不写。
   */
  const draftMemoryNoteForReview = useCallback(async (
    kind: MemoryNoteKind,
  ): Promise<{ kind: MemoryNoteKind; text: string } | null> => {
    let configured: ReturnType<typeof getAgentTextModelConfig>;
    try {
      configured = getAgentTextModelConfig();
    } catch {
      return null;
    }
    const transcript = buildSinkTranscript(
      messagesRef.current.map(item => ({ role: item.role, text: item.text })),
      20,
    );
    if (!transcript.trim()) return null;
    return draftMemoryNote({
      apiKey: configured.apiKey,
      model: configured.modelId,
      protocol: configured.protocol,
      baseUrl: configured.baseUrl,
      transcript,
      preferredKind: kind,
    });
  }, [getAgentTextModelConfig]);

  const appendMessage = useCallback(async (
    message: AgentMessage,
    sessionGeneration = sessionGenerationRef.current,
  ): Promise<boolean> => {
    if (!isSessionCurrent(sessionGeneration)) return false;
    // ref 同步追加：maybeAutoContinue 等同一 tick 内读 messagesRef 的路径，
    // 不能等到 render 后的 useEffect 才看见这条消息；useEffect 之后的整体回写与此一致，不会重复。
    messagesRef.current = [...messagesRef.current, message];
    setMessages(prev => [...prev, message]);
    await putMessage(message, sessionIdRef.current, sessionGeneration);
    // 记忆：有对话活动 → 刷新空闲计时，并标记本会话有未沉淀变更
    memoryActivityRef.current = Date.now();
    memoryUndepositedRef.current += 1;
    return isSessionCurrent(sessionGeneration);
  }, [isSessionCurrent]);

  const registerImage = useCallback(async (
    record: AgentImageRecord,
    sessionGeneration = sessionGenerationRef.current,
  ): Promise<boolean> => {
    if (!isSessionCurrent(sessionGeneration)) return false;
    await putImageRecord(record, sessionIdRef.current, sessionGeneration);
    if (!isSessionCurrent(sessionGeneration)) {
      await deleteAgentImageIfUnreferenced(record, sessionIdRef.current, sessionGeneration);
      return false;
    }
    imagesRef.current = [...imagesRef.current, record];
    setImages(prev => [...prev, record]);
    return true;
  }, [isSessionCurrent]);

  const nextImgId = useCallback(() => {
    seqRef.current += 1;
    return `img_${seqRef.current}`;
  }, []);

  const patchImageDescription = useCallback(async (
    imgId: string,
    description: string,
    sessionGeneration: number,
  ) => {
    if (!isSessionCurrent(sessionGeneration)) return;
    const current = imagesRef.current.find(img => img.imgId === imgId);
    if (!current) return;
    const updated = { ...current, description };
    await putImageRecord(updated, sessionIdRef.current, sessionGeneration);
    if (!isSessionCurrent(sessionGeneration)) return;
    imagesRef.current = imagesRef.current.map(img => (img.imgId === imgId ? updated : img));
    setImages(prev => prev.map(img => (img.imgId === imgId ? updated : img)));
  }, [isSessionCurrent]);

  // 给一张图片建立登记：存字节 + 生成预览。视觉描述可后台补，避免挡住出图。
  const ingestImage = useCallback(async (
    source: AgentImageRecord['source'],
    blob: Blob,
    previewDataUrl: string,
    mimeType: string,
    sourceTaskId?: string,
    dims?: { width: number; height: number },
    contentHash?: string,
    describeSignal?: AbortSignal,
    options?: { deferDescribe?: boolean },
    sessionGeneration = sessionGenerationRef.current,
  ): Promise<AgentImageRecord> => {
    if (!isSessionCurrent(sessionGeneration)) throw new Error('已停止');
    const imgId = nextImgId();
    // 上传图片（有 contentHash）已在 prepareUploadImage 时存于 nova-upload-cache，
    // 不再重复存到 nova-image-db，节省空间；生成图片无 contentHash 则照常存储。
    if (source === 'generated' || !contentHash) {
      await storeAgentImageBytes(imgId, blob, sessionIdRef.current, sessionGeneration);
      if (!isSessionCurrent(sessionGeneration)) throw new Error('已停止');
    }

    const runDescribe = async (): Promise<string> => {
      try {
        const configured = getAgentTextModelConfig();
        const description = await describeImage(
          configured.apiKey,
          configured.modelId,
          configured.protocol,
          previewDataUrl,
          describeSignal,
          configured.baseUrl,
        );
        if (!isSessionCurrent(sessionGeneration)) throw new Error('已停止');
        return description || '(无描述)';
      } catch (error) {
        if (!isSessionCurrent(sessionGeneration)) throw error;
        if (describeSignal?.aborted) return '(无描述)';
        return '(图片描述生成失败)';
      }
    };

    const record: AgentImageRecord = {
      imgId,
      source,
      thumbnail: previewDataUrl,
      description: options?.deferDescribe ? '(识别中)' : '',
      mimeType,
      contentHash,
      sourceTaskId,
      width: dims?.width && dims.width > 0 ? dims.width : undefined,
      height: dims?.height && dims.height > 0 ? dims.height : undefined,
      createdAt: Date.now(),
    };

    if (options?.deferDescribe) {
      if (!await registerImage(record, sessionGeneration)) throw new Error('已停止');
      void runDescribe().then(description => {
        void patchImageDescription(imgId, description, sessionGeneration);
      }).catch(() => undefined);
      reloadMemoryForCurrentSession();
      return record;
    }

    record.description = await runDescribe();
    if (!await registerImage(record, sessionGeneration)) throw new Error('已停止');
    reloadMemoryForCurrentSession();
    return record;
  }, [getAgentTextModelConfig, isSessionCurrent, nextImgId, patchImageDescription, registerImage, reloadMemoryForCurrentSession]);

  /**
   * CDP 工具执行器：执行浏览器工具；抓图工具返回的 localUrls 逐张登记进图片目录，
   * 并把新 imgId 列表拼回给模型，使其可以在 propose_image_action 里引用。
   *
   * 优化策略：
   * 1. 只存 URL + 缩略图，不立即下载完整图（省时间和空间）
   * 2. 将抓图结果作为 assistant 消息持久化，让模型记住已抓取的图片，避免重复抓取
   * 3. 生成图时才按需下载 URL 并编码 base64
   */
  const cdpExecutor = useCallback(async (
    name: string,
    args: Record<string, unknown>,
    onProgress?: (text: string) => void,
    sessionGeneration = sessionGenerationRef.current,
  ): Promise<string> => {
    if (!isSessionCurrent(sessionGeneration)) return '';
    const result = await executeAgentCdpTool(name, args, onProgress);
    if (!isSessionCurrent(sessionGeneration)) return result.text;
    if (!result.localUrls || result.localUrls.length === 0) return result.text;

    const sourceKey = typeof result.sourceKey === 'string' ? result.sourceKey.trim() : '';
    const sourceTitle = typeof result.sourceTitle === 'string' ? result.sourceTitle.trim() : '';
    const sourceUrl = typeof result.sourceUrl === 'string' ? result.sourceUrl.trim() : '';
    const ingestedRecords: AgentImageRecord[] = [];
    const ingestedIds: string[] = [];
    const cleanup = () => Promise.all(
      ingestedRecords.map(record => deleteAgentImageIfUnreferenced(record, sessionIdRef.current, sessionGeneration)),
    );
    for (const localUrl of result.localUrls) {
      // 同一 URL 已登记过：直接复用原 imgId，不重复下载缩略图、不重复占目录
      const existing = imagesRef.current.find(image => image.remoteUrl === localUrl);
      if (existing) {
        ingestedIds.push(existing.imgId);
        continue;
      }
      try {
        const blob = await fetchImageAsBlob(localUrl);
        if (!isSessionCurrent(sessionGeneration)) {
          await cleanup();
          return result.text;
        }
        const preview = await makePreviewFromBlob(blob);
        if (!isSessionCurrent(sessionGeneration)) {
          await cleanup();
          return result.text;
        }

        const record: AgentImageRecord = {
          imgId: nextImgId(),
          source: 'uploaded',
          thumbnail: preview.dataUrl,
          description: sourceTitle ? `商品《${sourceTitle}》的图` : '',
          mimeType: blob.type || 'image/jpeg',
          width: preview.width,
          height: preview.height,
          remoteUrl: localUrl,
          productKey: normalizeProductKey(sourceKey || sourceUrl),
          productName: sourceTitle || undefined,
          createdAt: Date.now(),
        };
        if (!await registerImage(record, sessionGeneration)) {
          await cleanup();
          return result.text;
        }
        ingestedRecords.push(record);
        ingestedIds.push(record.imgId);
      } catch {
        if (!isSessionCurrent(sessionGeneration)) {
          await cleanup();
          return result.text;
        }
      }
    }
    let text = result.text;
    if (ingestedIds.length > 0) {
      text += `\n\n以上图片已登记进图片目录：${ingestedIds.join('、')}。你可以在 propose_image_action 的 referenced_image_ids 中引用它们。`;

      const persisted = await appendMessage({
        id: generateUUID(),
        role: 'assistant',
        text: `✓ 已从浏览器抓取${sourceTitle ? `商品《${sourceTitle}》` : ''} ${ingestedIds.length} 张图并登记：${ingestedIds.join('、')}${sourceUrl ? `（来源：${sourceUrl}）` : ''}`,
        imageIds: [...ingestedIds],
        createdAt: Date.now(),
      }, sessionGeneration);
      if (!persisted) await cleanup();
    }
    return text;
  }, [appendMessage, isSessionCurrent, nextImgId, registerImage]);

  /** 重新生成已有图片的描述 */
  const redescribeImage = useCallback(async (imgId: string): Promise<string> => {
    const sessionGeneration = sessionGenerationRef.current;
    const record = images.find(img => img.imgId === imgId);
    if (!record) throw new Error(`图片 ${imgId} 不存在`);
    const configured = getAgentTextModelConfig();
    const newDescription = await describeImage(
      configured.apiKey,
      configured.modelId,
      configured.protocol,
      record.thumbnail,
      undefined,
      configured.baseUrl,
    );
    const description = newDescription || '(无描述)';
    if (!isSessionCurrent(sessionGeneration)) return description;
    await patchImageDescription(imgId, description, sessionGeneration);
    return description;
  }, [getAgentTextModelConfig, images, isSessionCurrent, patchImageDescription]);

  const patchImageSelfCheck = useCallback(async (
    imgId: string,
    selfCheck: AgentSelfCheck,
    sessionGeneration: number,
  ) => {
    if (!isSessionCurrent(sessionGeneration)) return;
    const current = imagesRef.current.find(img => img.imgId === imgId);
    if (!current) return;
    const updated = { ...current, selfCheck };
    await putImageRecord(updated, sessionIdRef.current, sessionGeneration);
    if (!isSessionCurrent(sessionGeneration)) return;
    imagesRef.current = imagesRef.current.map(img => (img.imgId === imgId ? updated : img));
    setImages(prev => prev.map(img => (img.imgId === imgId ? updated : img)));
  }, [isSessionCurrent]);

  /**
   * 出图自检执行体：参考图（最多 3 张）+ 结果图一起交给视觉模型比对。
   * 用全尺寸字节而不是缩略图 —— 缩略图看不清包装文字，判不出「画面文字错误」。
   */
  const runSelfCheckForRecord = useCallback(async (
    record: AgentImageRecord,
    referenceIds: string[],
    sessionGeneration: number,
  ): Promise<AgentSelfCheck | null> => {
    if (!isSessionCurrent(sessionGeneration)) return null;
    let configured: ReturnType<typeof getAgentTextModelConfig>;
    try {
      configured = getAgentTextModelConfig();
    } catch {
      return null;
    }

    const refs = referenceIds.slice(0, 3);
    const dataUrls: string[] = [];
    for (const id of refs) {
      const image = await getAgentImageBase64(id, sessionIdRef.current, sessionGeneration);
      if (!isSessionCurrent(sessionGeneration)) return null;
      if (image) dataUrls.push(`data:${image.mimeType};base64,${image.data}`);
    }
    // 没有参考图就不检：铁律下出图必须有参考图，真没有就说明这不是商品图
    if (dataUrls.length === 0) return null;

    const result = await getAgentImageBase64(record.imgId, sessionIdRef.current, sessionGeneration);
    if (!isSessionCurrent(sessionGeneration)) return null;
    if (!result) return null;
    dataUrls.push(`data:${result.mimeType};base64,${result.data}`);

    const imageIds = [...refs, record.imgId];
    // 自检要判「画面文字是否违规」，必须喂**本类目的**违禁词库（各类目词库不同，不跨类目套用）
    const complianceRules = extractComplianceRules(getCurrentMemory()?.identity || '');
    let parsed: AgentSelfCheck;
    try {
      const text = await selfCheckImages(
        configured.apiKey,
        configured.modelId,
        configured.protocol,
        dataUrls,
        undefined,
        configured.baseUrl,
        complianceRules,
      );
      if (!isSessionCurrent(sessionGeneration)) return null;
      parsed = parseSelfCheckOutput(text, { imageIds, model: configured.modelId });
    } catch (error) {
      parsed = {
        status: 'error',
        summary: '自检请求失败',
        issues: [],
        checkedAt: Date.now(),
        imageIds,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await patchImageSelfCheck(record.imgId, parsed, sessionGeneration);
    return parsed;
  }, [getAgentTextModelConfig, isSessionCurrent, patchImageSelfCheck]);

  /** 手动补检：生图时没开自动自检，事后在图片上点「自检」补跑 */
  const runSelfCheck = useCallback(async (imgId: string): Promise<AgentSelfCheck | null> => {
    const sessionGeneration = sessionGenerationRef.current;
    const record = imagesRef.current.find(img => img.imgId === imgId);
    if (!record) throw new Error(`图片 ${imgId} 不存在`);

    // 从引用过这张图的那条生成消息里取回当时用的参考图
    const owner = [...messagesRef.current].reverse().find(message =>
      message.imageIds?.includes(imgId) && (message.proposalData?.referencedImageIds?.length ?? 0) > 0,
    );
    const referenceIds = owner?.proposalData?.referencedImageIds ?? [];

    if (referenceIds.length === 0) {
      const skipped: AgentSelfCheck = {
        status: 'unknown',
        summary: '这张图没有关联到参考图，无法自检',
        issues: [],
        checkedAt: Date.now(),
        imageIds: [imgId],
      };
      await patchImageSelfCheck(imgId, skipped, sessionGeneration);
      return skipped;
    }

    return runSelfCheckForRecord(record, referenceIds, sessionGeneration);
  }, [patchImageSelfCheck, runSelfCheckForRecord]);

  const persistStreamFailure = useCallback((
    message: string,
    sessionGeneration = sessionGenerationRef.current,
  ) => {
    if (!isSessionCurrent(sessionGeneration)) return;
    setError(message);
    void appendMessage({
      id: generateUUID(),
      role: 'system-note',
      text: `请求失败：${message}`,
      createdAt: Date.now(),
    }, sessionGeneration);
    setPhase('idle');
  }, [appendMessage, isSessionCurrent]);

  const runChat = useCallback((history: AgentMessage[], catalog: AgentImageRecord[]) => {
    const sessionGeneration = sessionGenerationRef.current;
    if (!isSessionCurrent(sessionGeneration)) return;
    let configured: ReturnType<typeof getAgentTextModelConfig>;
    try {
      configured = getAgentTextModelConfig();
    } catch (err) {
      persistStreamFailure(err instanceof Error ? err.message : '请求失败', sessionGeneration);
      return;
    }
    const modelCatalog = buildModelCatalog();
    setPhase('streaming');
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');

    // 思考过程也要有持久性：先把这条助手消息登记进「发起它的会话」，
    // 流式期间按间隔更新它，收尾时用同一个 id 覆盖成最终文本。
    const live = beginLiveMessage(sessionIdRef.current);

    let reasoningBuf = '';

    const handle = streamAgentChat(
      {
        apiKey: configured.apiKey,
        model: configured.modelId,
        protocol: configured.protocol,
        history,
        webSearch: webSearchEnabled && supportsAgentNativeWebSearch(configured.protocol),
        cdp: cdpEnabled,
        cdpExecutor: cdpEnabled
          ? (name, args, onProgress) => cdpExecutor(name, args, onProgress, sessionGeneration)
          : undefined,
        catalog: catalog.map(img => ({ imgId: img.imgId, description: img.description })),
        modelCatalog,
      },
      {
        onDelta: token => {
          // 先记进落库状态（与是否停留在本会话无关），界面更新才需要判会话
          live.text += token;
          tickLiveMessage(live);
          if (isSessionCurrent(sessionGeneration)) appendStreamingToken('text', token);
        },
        onReasoning: token => {
          live.reasoning += token;
          tickLiveMessage(live);
          if (!isSessionCurrent(sessionGeneration)) return;
          reasoningBuf += token;
          appendStreamingToken('reasoning', token);
        },
        onToolActivity: text => {
          live.reasoning += text;
          tickLiveMessage(live);
          if (!isSessionCurrent(sessionGeneration)) return;
          reasoningBuf += text;
          appendStreamingToken('reasoning', text);
        },
        onResetAttempt: () => {
          live.text = '';
          live.reasoning = '';
          tickLiveMessage(live);
          if (!isSessionCurrent(sessionGeneration)) return;
          reasoningBuf = '';
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
        },
        onDone: (fullText, parsedProposal, parsedProposals) => {
          const staleNow = !isSessionCurrent(sessionGeneration);
          const finalText = (fullText || live.text || '').trim();
          const finalReasoning = (reasoningBuf || live.reasoning || '').trim();
          if (staleNow) {
            // 会话已切走：界面/提案都不处理，但这轮回复属于发起它的会话，必须落库
            if (finalText || finalReasoning) finishLiveMessage(live, finalText, finalReasoning);
            else dropLiveMessage(live);
            return;
          }
          streamHandleRef.current = null;
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
          const text = fullText.trim();
          const reasoning = reasoningBuf.trim();
          if (parsedProposal) {
            const resolvedModel = resolveValidAgentImageModel(resolveAgentModel(
              imageModelRef.current,
              parsedProposal.requestedModelId,
              parsedProposal.requestedOutputSize,
              modelCatalog,
            ));
            if (resolvedModel !== imageModelRef.current) {
              imageModelRef.current = resolvedModel;
              setImageModelState(resolvedModel);
              void saveImageModel(resolvedModel, sessionIdRef.current, sessionGeneration);
            }
            pendingAnalysisRef.current = text;
            pendingReasoningRef.current = reasoning;
            isReeditRef.current = false;
            setProposal(parsedProposal);
            const rest = (parsedProposals || []).filter(item => item !== parsedProposal);
            proposalQueueRef.current = rest;
            setProposalQueue(rest);
            setPhase('proposal');
            void savePendingProposal({
              proposal: parsedProposal,
              pendingAnalysis: text,
              pendingReasoning: reasoning,
              isReedit: false,
              queuedProposals: rest,
            }, sessionIdRef.current, sessionGeneration);
            // 这条不是对话气泡（内容进了提案卡），把流式期间的占位行删掉
            dropLiveMessage(live);
          } else {
            void appendMessage({
              id: live.id,
              role: 'assistant',
              text: text.length > 0
                ? text
                : (reasoning.length > 0
                  ? '浏览器操作已结束，但模型没有给出文字回复。请再发一条继续。'
                  : '模型没有返回内容。请重试一次。'),
              reasoning: reasoning.length > 0 ? reasoning : undefined,
              createdAt: live.createdAt,
            }, sessionGeneration);
            setPhase('idle');
          }
        },
        onError: err => {
          const staleNow = !isSessionCurrent(sessionGeneration);
          // 已经流出来的内容先落库（切走会话也不丢），空回复则不留占位行
          if (live.text.trim() || live.reasoning.trim()) finishLiveMessage(live, live.text.trim(), live.reasoning.trim());
          else dropLiveMessage(live);
          if (staleNow) return;
          streamHandleRef.current = null;
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
          persistStreamFailure(err.message || '请求失败', sessionGeneration);
        },
      },
      configured.baseUrl,
    );
    streamHandleRef.current = handle;
  }, [appendMessage, appendStreamingToken, beginLiveMessage, cdpEnabled, cdpExecutor, dropLiveMessage, finishLiveMessage, flushAndCancelRaf, getAgentTextModelConfig, isSessionCurrent, persistStreamFailure, tickLiveMessage, webSearchEnabled]);

  const sendMessage = useCallback(async (text: string, uploads: PendingUpload[], imageReferences?: string[]) => {
    const sessionGeneration = sessionGenerationRef.current;
    if (!isSessionCurrent(sessionGeneration) || !ready || phase !== 'idle') return;
    const trimmed = text.trim();
    if (trimmed.length === 0 && uploads.length === 0) return;
    setError(null);
    // 新的商品链接开启新一轮批量轮：重置自动续跑计数；不含链接的消息（如"继续"）不重置
    const links = extractProductLinks(trimmed);
    if (links.length > 0) {
      userLinksRef.current = links;
      autoContinueCountRef.current = 0;
    }
    // 用户发送新消息时，丢弃任何待定提案的分析文本
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = false;
    if (mountedRef.current) {
      void clearPendingProposal(sessionIdRef.current);
    }

    const uploadedRecords: AgentImageRecord[] = [];
    const cleanupUploads = () => Promise.all(
      uploadedRecords.map(record => deleteAgentImageIfUnreferenced(record, sessionIdRef.current, sessionGeneration)),
    );
    const linkedIds: string[] = [];
    if (uploads.length > 0) {
      const descController = new AbortController();
      describeAbortRef.current = descController;

      setPhase('describing');
      const seenHashes = new Set<string>();
      try {
        for (const upload of uploads) {
          if (!isSessionCurrent(sessionGeneration)) {
            await cleanupUploads();
            return;
          }
          const hash = upload.id;
          // 同批内重复 + 历史已登记重复，统一按内容哈希复用，不重复登记
          if (hash && seenHashes.has(hash)) continue;
          const existing = hash
            ? [...images, ...uploadedRecords].find(img => img.contentHash === hash)
            : undefined;
          if (existing) {
            if (hash) seenHashes.add(hash);
            if (!linkedIds.includes(existing.imgId)) linkedIds.push(existing.imgId);
            continue;
          }
          try {
            const blob = await resultImageToBlob(upload.dataUrl);
            if (!isSessionCurrent(sessionGeneration)) {
              await cleanupUploads();
              return;
            }
            const preview = await makePreviewFromBlob(blob);
            if (!isSessionCurrent(sessionGeneration)) {
              await cleanupUploads();
              return;
            }
            const record = await ingestImage(
              upload.source || 'uploaded',
              blob,
              preview.dataUrl,
              upload.mimeType,
              undefined,
              { width: preview.width, height: preview.height },
              hash || undefined,
              descController.signal,
              undefined,
              sessionGeneration,
            );
            uploadedRecords.push(record);
            if (hash) seenHashes.add(hash);
            linkedIds.push(record.imgId);
          } catch (err) {
            if (!isSessionCurrent(sessionGeneration)) {
              await cleanupUploads();
              return;
            }
            setError(err instanceof Error ? err.message : '图片处理失败');
          }
        }
      } finally {
        if (describeAbortRef.current === descController) {
          describeAbortRef.current = null;
        }
      }
    }

    if (!isSessionCurrent(sessionGeneration)) {
      await cleanupUploads();
      return;
    }
    const uploadedIds = linkedIds;
    const refSuffix = imageReferences && imageReferences.length > 0
      ? `\n[引用图片: ${imageReferences.join(', ')}]`
      : '';
    const noteSuffix = uploadedIds.length > 0 ? `\n[已上传图片: ${uploadedIds.join(', ')}]` : '';
    // 多链接批量轮：显式提醒模型一次出齐所有商品提案（排队确认），避免只出一个再等续跑
    const batchSuffix = links.length > 1
      ? `\n[系统：本条含 ${links.length} 个商品链接。抓完所有商品后，在同一轮为每个商品各调用一次 propose_image_action（填各自的 product_key/product_name，参考图只用该商品的），一次出齐，不要只出一个。]`
      : '';
    const userMessage: AgentMessage = {
      id: generateUUID(),
      role: 'user',
      text: `${trimmed}${refSuffix}${noteSuffix}${batchSuffix}`.trim(),
      imageIds: uploadedIds.length > 0 ? uploadedIds : undefined,
      createdAt: Date.now(),
    };
    if (!await appendMessage(userMessage, sessionGeneration)) {
      await cleanupUploads();
      return;
    }

    const fullHistory = [...messages, userMessage];
    const fullCatalog = [...images, ...uploadedRecords];
    const { history, catalog } = sliceActiveContext(fullHistory, fullCatalog);
    runChat(history, catalog);
  }, [appendMessage, images, ingestImage, isSessionCurrent, messages, phase, ready, runChat]);

  /** 批量轮里自动续跑的次数上限——纯粹防失控兜底，不是业务规则 */
  const AUTO_CONTINUE_LIMIT = 10;

  /**
   * 一项生成完成后自动续跑一轮。这里不做「已覆盖/剩余商品」之类的硬规则：
   * 模型看得见完整历史（原始要求、已抓的图、已出的方案、已完成的图），
   * 还有没有没做完的交给它自己判断——做完它自然会用文字回复，续跑随之停止。
   * 仅在用户消息带商品链接的批量轮里触发；普通单图请求不续跑。
   */
  const maybeAutoContinue = useCallback((): boolean => {
    if (userLinksRef.current.length === 0) return false;
    if (autoContinueCountRef.current >= AUTO_CONTINUE_LIMIT) return false;
    autoContinueCountRef.current += 1;
    const userMessage: AgentMessage = {
      id: generateUUID(),
      role: 'user',
      text: '上一张图已完成。对照我最开始的要求（有哪些链接、每个商品要几张、一共要几张）：如果还有没做完的，继续调用 propose_image_action 出下一个方案；如果已经全部做完，直接用文字告诉我完成了，不要再调用工具。',
      createdAt: Date.now(),
    };
    appendMessage(userMessage);
    // appendMessage 已同步 messagesRef，这里直接用，不再手动拼 userMessage（否则会重复）
    const { history, catalog } = sliceActiveContext(messagesRef.current, imagesRef.current);
    runChat(history, catalog);
    return true;
  }, [appendMessage, runChat]);

  const cancelProposal = useCallback(() => {
    setProposal(null);
    setPhase('idle');
    // 取消时如果有待定分析，保存为一条助手消息供用户回顾
    const analysis = pendingAnalysisRef.current;
    const analysisReasoning = pendingReasoningRef.current;
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    // 二次编辑取消时不标记为可撤回，防止误操作删除已有图片
    const wasReedit = isReeditRef.current;
    isReeditRef.current = false;
    if (mountedRef.current) {
      void clearPendingProposal(sessionIdRef.current);
    }
    if (analysis) {
      appendMessage({
        id: generateUUID(),
        role: 'assistant',
        text: analysis,
        reasoning: analysisReasoning || undefined,
        createdAt: Date.now(),
      });
    }
    appendMessage({
      id: generateUUID(),
      role: 'system-note',
      text: wasReedit ? '已取消本次重新编辑。' : '已取消本次生图提案。',
      withdrawable: !wasReedit,
      createdAt: Date.now(),
    });
    // 队列中还有下一个商品提案时直接推进，用户不需要再说"继续"。
    // 注意：读写都在 setState updater 之外，避免 StrictMode 双调用导致消息/持久化重复。
    const [next, ...rest] = proposalQueueRef.current;
    if (next) {
      proposalQueueRef.current = rest;
      setProposalQueue(rest);
      setProposal(next);
      setPhase('proposal');
      if (mountedRef.current) {
        void savePendingProposal(
          { proposal: next, pendingAnalysis: '', pendingReasoning: '', isReedit: false, queuedProposals: rest },
          sessionIdRef.current,
        );
      }
      appendMessage({
        id: generateUUID(),
        role: 'system-note',
        text: `已切换到下一个商品的提案（剩余 ${rest.length} 个待确认）。`,
        createdAt: Date.now(),
      });
      return;
    }
    // 队列已空就到 idle 为止。取消是用户主动叫停，不再自动续跑——下一步交给用户自己说。
  }, [appendMessage]);

  const cleanupOrphanImages = useCallback((keptMessages: AgentMessage[], removedImageIds: string[]) => {
    const orphanIds = [...new Set(removedImageIds)].filter(imgId =>
      !keptMessages.some(message => message.imageIds?.includes(imgId)),
    );
    if (orphanIds.length === 0) return;
    imagesRef.current = imagesRef.current.filter(image => !orphanIds.includes(image.imgId));
    setImages(prev => prev.filter(image => !orphanIds.includes(image.imgId)));
    void deleteImageRecords(orphanIds, sessionIdRef.current);
    for (const imgId of orphanIds) void deleteAgentImageBytes(imgId, sessionIdRef.current);
  }, []);

  // 撤回最后一轮对话：持久化副作用必须在 React state updater 外，避免 StrictMode 重放。
  const withdrawTurn = useCallback((noteId: string) => {
    if (!mountedRef.current || phaseRef.current === 'generating' || activeGenerationTasksRef.current.size > 0) return;
    const current = messagesRef.current;
    const noteIndex = current.findIndex(message => message.id === noteId);
    if (noteIndex === -1) return;
    let start = noteIndex;
    for (let i = noteIndex - 1; i >= 0; i--) {
      if (current[i].role === 'user') { start = i; break; }
    }
    const kept = current.slice(0, start);
    const removed = current.slice(start);
    messagesRef.current = kept;
    setMessages(kept);
    void deleteMessages(removed.map(message => message.id), sessionIdRef.current);
    cleanupOrphanImages(kept, removed.flatMap(message => message.imageIds || []));
  }, [cleanupOrphanImages]);

  const cancelAllPolls = useCallback(() => {
    for (const { controller, wake } of pollControllersRef.values()) {
      controller.abort();
      wake();
    }
    pollControllersRef.clear();
  }, [pollControllersRef]);

  const pollTask = useCallback(async (taskId: string) => {
    const previous = pollControllersRef.get(taskId);
    previous?.controller.abort();
    previous?.wake();

    const controller = new AbortController();
    let wake = () => {};
    const pollState = { controller, wake };
    pollControllersRef.set(taskId, pollState);

    try {
      for (;;) {
        if (controller.signal.aborted || !mountedRef.current) throw new Error('已停止');
        const task = await getNovaTask(taskId);
        if (controller.signal.aborted || !mountedRef.current) throw new Error('已停止');
        if (task.status === 'completed') return task;
        if (task.status === 'failed' || task.status === 'expired') {
          throw new Error(task.error || task.warning || '生图任务失败');
        }
        await new Promise<void>(resolve => {
          const onAbort = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, 4000);
          wake = onAbort;
          pollState.wake = onAbort;
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      if (pollControllersRef.get(taskId)?.controller === controller) {
        pollControllersRef.delete(taskId);
      }
    }
  }, [pollControllersRef]);

  const pendingGenerationWriteRef = useRef(Promise.resolve());
  const queuePendingGenerationWrite = useCallback((write: () => Promise<void>) => {
    const next = pendingGenerationWriteRef.current.then(write, write);
    pendingGenerationWriteRef.current = next.catch(() => {});
    return next;
  }, []);

  const isGenerationTaskActive = useCallback((taskId: string, epoch: number) => (
    mountedRef.current
    && generationEpochRef.current === epoch
    && activeGenerationTasksRef.current.get(taskId) === epoch
  ), []);

  const persistPendingGeneration = useCallback((data: PendingGenerationData, epoch: number) => {
    activeGenerationTasksRef.current.set(data.taskId, epoch);
    if (mountedRef.current) setActiveGenerationCount(activeGenerationTasksRef.current.size);
    return queuePendingGenerationWrite(() => savePendingGenerationTask(data, sessionIdRef.current));
  }, [queuePendingGenerationWrite]);

  const removePendingGenerationForTask = useCallback(async (taskId: string, epoch: number) => {
    if (activeGenerationTasksRef.current.get(taskId) !== epoch) return false;
    await queuePendingGenerationWrite(() => removePendingGenerationTask(taskId, sessionIdRef.current));
    if (activeGenerationTasksRef.current.get(taskId) !== epoch) return false;
    activeGenerationTasksRef.current.delete(taskId);
    if (mountedRef.current) setActiveGenerationCount(activeGenerationTasksRef.current.size);
    return true;
  }, [queuePendingGenerationWrite]);

  const cancelPendingGenerations = useCallback(() => {
    const taskIds = [...activeGenerationTasksRef.current.keys()];
    activeGenerationTasksRef.current.clear();
    if (mountedRef.current) setActiveGenerationCount(0);
    return Promise.all(taskIds.map(taskId =>
      queuePendingGenerationWrite(() => removePendingGenerationTask(taskId, sessionIdRef.current)),
    ));
  }, [queuePendingGenerationWrite]);

  const clearAllPendingGenerations = useCallback(() => {
    activeGenerationTasksRef.current.clear();
    if (mountedRef.current) setActiveGenerationCount(0);
    return queuePendingGenerationWrite(() => clearPendingGenerationTasks(sessionIdRef.current));
  }, [queuePendingGenerationWrite]);

  const proposalDataFromGeneration = useCallback((data: PendingGenerationData): NonNullable<AgentMessage['proposalData']> => ({
    action: data.selectedImageIds.length > 0 ? 'edit' : 'generate',
    prompt: data.proposal.prompt,
    referencedImageIds: data.selectedImageIds,
    model: data.model as ModelId,
    outputSize: data.outputSize,
    customSize: data.customSize,
    aspectRatio: data.aspectRatio,
    temperature: data.temperature,
    gptImageQuality: data.gptImageQuality,
    gptImageStyle: data.gptImageStyle,
    gptImageBackground: data.gptImageBackground,
    parallelCount: data.parallelCount,
    productKey: data.proposal.productKey,
    productName: data.proposal.productName,
  }), []);

  const processGeneratedTask = useCallback(async (
    allImages: string[],
    data: PendingGenerationData,
    epoch: number,
  ): Promise<void> => {
    if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');
    const sessionGeneration = sessionGenerationRef.current;
    const background = data.background === true;
    const descController = new AbortController();
    describeAbortRef.current = descController;

    if (!background) setPhase('loading');
    const blobs = await Promise.allSettled(allImages.map(ref => resultImageToBlob(ref)));
    if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');

    const records: AgentImageRecord[] = [];
    const errors: string[] = [];
    try {
      for (let i = 0; i < allImages.length; i++) {
        if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');
        try {
          const settled = blobs[i];
          const blob = settled && settled.status === 'fulfilled' ? settled.value : null;
          if (!blob) { errors.push('图片下载失败'); continue; }
          const preview = await makePreviewFromBlob(blob);
          if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');
          const record = await ingestImage(
            'generated',
            blob,
            preview.dataUrl,
            blob.type || 'image/png',
            data.taskId,
            { width: preview.width, height: preview.height },
            undefined,
            descController.signal,
            { deferDescribe: true },
            sessionGeneration,
          );
          records.push(record);
          if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');
        } catch (err) {
          if (isStoppedError(err)) throw err;
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (records.length === 0) throw new Error(errors[0] || '图片处理失败');
      if (!isGenerationTaskActive(data.taskId, epoch)) throw new Error('已停止');

      const imgIds = records.map(record => record.imgId);
      const analysis = background
        ? (data.pendingAnalysis || data.proposal.reason || '')
        : (pendingAnalysisRef.current || data.pendingAnalysis || data.proposal.reason || '');
      const reasoning = background ? '' : (pendingReasoningRef.current || data.pendingReasoning);
      if (!background) {
        pendingAnalysisRef.current = '';
        pendingReasoningRef.current = '';
      }
      let generatedText = `分析：${analysis || '根据你的描述，已为你生成图片。'}\n`;
      generatedText += `优化提示词：${data.proposal.prompt}\n`;
      generatedText += `结果：已生成图片 ${imgIds.join('、')}。需要继续调整就告诉我。`;
      if (errors.length > 0) generatedText += `\n（部分图片处理失败：${errors.join('；')}）`;

      const persisted = await appendMessage({
        id: generateUUID(),
        role: 'assistant',
        text: generatedText,
        reasoning: reasoning || undefined,
        imageIds: imgIds,
        taskId: data.taskId,
        proposalData: proposalDataFromGeneration(data),
        createdAt: Date.now(),
      }, sessionGeneration);
      if (!persisted) throw new Error('已停止');

      // 出图后自动自检：不 await，图先给用户看，结果异步补写到图片上
      if (isAutoSelfCheckEnabled()) {
        for (const record of records) {
          void runSelfCheckForRecord(record, data.selectedImageIds, sessionGeneration).catch(() => undefined);
        }
      }
    } catch (error) {
      if (isStoppedError(error) || !isSessionCurrent(sessionGeneration)) {
        await Promise.all(records.map(record => deleteAgentImageIfUnreferenced(record, sessionIdRef.current, sessionGeneration)));
      }
      throw error;
    } finally {
      if (describeAbortRef.current === descController) describeAbortRef.current = null;
    }

    const removed = await removePendingGenerationForTask(data.taskId, epoch);
    if (!removed || !mountedRef.current || generationEpochRef.current !== epoch) return;
    if (background) {
      if (phaseRef.current === 'idle') maybeAutoContinue();
      return;
    }

    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    const [next, ...rest] = proposalQueueRef.current;
    if (!next) {
      if (!maybeAutoContinue()) {
        phaseRef.current = 'idle';
        setPhase('idle');
      }
      return;
    }
    proposalQueueRef.current = rest;
    setProposalQueue(rest);
    setProposal(next);
    phaseRef.current = 'proposal';
    setPhase('proposal');
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = false;
    void savePendingProposal(
      { proposal: next, pendingAnalysis: '', pendingReasoning: '', isReedit: false, queuedProposals: rest },
      sessionIdRef.current,
    );
    appendMessage({
      id: generateUUID(),
      role: 'system-note',
      text: `当前商品已生成，继续处理下一个商品的提案（剩余 ${rest.length} 个待确认）。`,
      createdAt: Date.now(),
    });
  }, [appendMessage, ingestImage, isGenerationTaskActive, isSessionCurrent, maybeAutoContinue, proposalDataFromGeneration, removePendingGenerationForTask, runSelfCheckForRecord]);

  const resumeGeneration = useCallback(async (data: PendingGenerationData, epoch: number) => {
    try {
      const task = await pollTask(data.taskId);
      if (!isGenerationTaskActive(data.taskId, epoch)) return;
      const allImages = task.result?.images;
      if (!allImages || allImages.length === 0) throw new Error('后端未返回图片');
      await processGeneratedTask(allImages, data, epoch);
    } catch (err) {
      if (!isGenerationTaskActive(data.taskId, epoch) || isStoppedError(err)) return;
      const message = err instanceof Error ? err.message : '生图失败';
      await appendMessage({
        id: generateUUID(),
        role: 'assistant',
        text: `《${data.proposal.productName || (data.background ? '后台任务' : '当前任务')}》图片生成失败：${message}。可重新编辑后重试。`,
        taskId: data.taskId,
        proposalData: proposalDataFromGeneration(data),
        createdAt: Date.now(),
      });
      const removed = await removePendingGenerationForTask(data.taskId, epoch);
      if (!removed || !mountedRef.current || generationEpochRef.current !== epoch || data.background) return;

      const failedProposal: AgentProposal = {
        ...data.proposal,
        action: data.proposal.action ?? (data.selectedImageIds.length > 0 ? 'edit' : 'generate'),
        referencedImageIds: data.selectedImageIds,
        suggestedAspectRatio: data.proposal.suggestedAspectRatio ?? data.aspectRatio,
        requestedOutputSize: data.proposal.requestedOutputSize ?? data.outputSize,
        temperature: data.temperature,
        gptImageQuality: data.gptImageQuality,
        gptImageStyle: data.gptImageStyle,
        gptImageBackground: data.gptImageBackground,
        parallelCount: data.parallelCount,
      };
      setError(message);
      setProposal(failedProposal);
      setGeneratingTaskId(null);
      setGeneratingStartedAt(null);
      setGenerationDraft(null);
      setIsSyncing(false);
      phaseRef.current = 'proposal';
      setPhase('proposal');
    }
  }, [appendMessage, isGenerationTaskActive, pollTask, processGeneratedTask, proposalDataFromGeneration, removePendingGenerationForTask]);

  useEffect(() => {
    if (!ready || generationsToResumeRef.current.length === 0) return;
    const generations = generationsToResumeRef.current;
    generationsToResumeRef.current = [];
    const epoch = generationEpochRef.current;
    for (const generation of generations) void resumeGeneration(generation, epoch);
  }, [ready, resumeGeneration]);

  const checkNow = useCallback(async (): Promise<AgentCheckResult> => {
    if (phase !== 'generating') return 'idle';
    const taskId = generatingTaskId;
    if (!taskId) return 'idle';

    setIsSyncing(true);
    // 立即唤醒当前前台任务的轮询，让完成/失败的状态切换尽快走正常流程
    pollControllersRef.get(taskId)?.wake();

    try {
      const task = await getNovaTask(taskId);
      if (task.status === 'completed') return 'completed';
      if (task.status === 'failed' || task.status === 'expired') return 'failed';
      if (task.status === 'processing') return 'processing';
      return 'queued';
    } catch {
      return 'error';
    } finally {
      setIsSyncing(false);
    }
  }, [generatingTaskId, phase, pollControllersRef]);

  const approveProposal = useCallback(async (
    finalPrompt: string,
    selectedImageIds: string[],
    model: string,
    params: AgentResolvedLayout,
    /** 英文生图版提示词（与 finalPrompt 对应）。用户改过中文版时调用方会传 undefined，此时直接发中文 */
    finalPromptEn?: string,
  ) => {
    if (phaseRef.current !== 'proposal') return;
    const generationEpoch = generationEpochRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const prompt = finalPrompt.trim();
    const promptEn = (finalPromptEn || '').trim() || undefined;
    // 真正发给生图模型的那一份：有英文用英文，没有就用中文
    const generationPrompt = promptEn || prompt;
    if (prompt.length === 0) {
      setError('提示词不能为空');
      return;
    }
    setError(null);
    const startedAt = Date.now();
    const approvedProposal: AgentProposal = {
      action: proposal?.action ?? (selectedImageIds.length > 0 ? 'edit' : 'generate'),
      prompt,
      promptEn,
      referencedImageIds: selectedImageIds,
      reason: proposal?.reason ?? '',
      productKey: proposal?.productKey,
      productName: proposal?.productName,
      requestedAspectRatio: proposal?.requestedAspectRatio,
      suggestedAspectRatio: proposal?.suggestedAspectRatio ?? params.aspectRatio,
      requestedOutputSize: proposal?.requestedOutputSize ?? params.outputSize,
      temperature: params.temperature,
      gptImageQuality: params.gptImageQuality,
      gptImageStyle: params.gptImageStyle,
      gptImageBackground: params.gptImageBackground,
      parallelCount: params.parallelCount,
      requestedModelId: proposal?.requestedModelId,
    };
    proposalRef.current = approvedProposal;
    setProposal(null);
    void clearPendingProposal(sessionIdRef.current);
    phaseRef.current = 'generating';
    setPhase('generating');
    setGeneratingStartedAt(startedAt);
    setGenerationDraft({
      analysis: pendingAnalysisRef.current || approvedProposal.reason || '根据你的描述，正在生成图片。',
      reasoning: pendingReasoningRef.current || undefined,
      prompt,
      parallelCount: params.parallelCount,
      startedAt,
    });

    let createdTaskId: string | null = null;
    try {
      const references: ImageReference[] = [];
      for (const imgId of selectedImageIds) {
        if (!isSessionCurrent(sessionGeneration) || generationEpochRef.current !== generationEpoch) return;
        const bytes = await getAgentImageBase64(imgId, sessionIdRef.current, sessionGeneration);
        if (!isSessionCurrent(sessionGeneration) || generationEpochRef.current !== generationEpoch) return;
        if (!bytes) {
          throw new Error(`参考图下载失败：${imgId} 不可用，请重新抓取后重试。`);
        }
        references.push({ data: bytes.data, mimeType: bytes.mimeType });
      }
      const provider = resolveImageTaskProvider(model);
      if (!isSessionCurrent(sessionGeneration) || generationEpochRef.current !== generationEpoch) return;
      const layout = resolveSubmitLayout(model, params.outputSize, params.aspectRatio, prompt);
      const taskId = await createNovaTask({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        mode: references.length > 0 ? 'image-to-image' : 'text-to-image',
        prompt: generationPrompt,
        outputSize: layout.outputSize,
        customSize: layout.outputSize === 'auto' ? undefined : params.customSize,
        aspectRatio: layout.aspectRatio,
        temperature: params.temperature,
        model: provider.modelId,
        gptImageQuality: params.gptImageQuality,
        gptImageStyle: params.gptImageStyle,
        gptImageBackground: params.gptImageBackground,
        parallelCount: params.parallelCount,
        images: references,
      });
      createdTaskId = taskId;
      if (generationEpochRef.current !== generationEpoch) return;

      const [nextProposal, ...restQueue] = proposalQueueRef.current;
      const data: PendingGenerationData = {
        taskId,
        proposal: approvedProposal,
        pendingAnalysis: pendingAnalysisRef.current,
        pendingReasoning: pendingReasoningRef.current,
        selectedImageIds,
        model,
        outputSize: layout.outputSize,
        customSize: layout.outputSize === 'auto' ? undefined : params.customSize,
        aspectRatio: layout.aspectRatio,
        temperature: params.temperature,
        gptImageQuality: params.gptImageQuality,
        gptImageStyle: params.gptImageStyle,
        gptImageBackground: params.gptImageBackground,
        parallelCount: params.parallelCount,
        startedAt,
        background: Boolean(nextProposal),
      };
      await persistPendingGeneration(data, generationEpoch);
      if (!isGenerationTaskActive(taskId, generationEpoch)) return;
      setGeneratingTaskId(taskId);
      setGenerationDraft(prev => prev ? { ...prev, taskId } : prev);

      if (nextProposal) {
        proposalQueueRef.current = restQueue;
        setProposalQueue(restQueue);
        setProposal(nextProposal);
        phaseRef.current = 'proposal';
        setPhase('proposal');
        setGeneratingTaskId(null);
        setGeneratingStartedAt(null);
        setGenerationDraft(null);
        pendingAnalysisRef.current = '';
        pendingReasoningRef.current = '';
        void savePendingProposal(
          { proposal: nextProposal, pendingAnalysis: '', pendingReasoning: '', isReedit: false, queuedProposals: restQueue },
          sessionIdRef.current,
        );
        appendMessage({
          id: generateUUID(),
          role: 'system-note',
          text: restQueue.length > 0
            ? `《${approvedProposal.productName || '当前商品'}》已提交，后台生成中。请继续确认下一张提案（还剩 ${restQueue.length} 张待确认）。`
            : `《${approvedProposal.productName || '当前商品'}》已提交，后台生成中。下面这张提案还需要你点「允许并生成」。`,
          createdAt: Date.now(),
        });
        void resumeGeneration(data, generationEpoch);
        return;
      }

      await resumeGeneration(data, generationEpoch);
    } catch (err) {
      if (createdTaskId) await removePendingGenerationForTask(createdTaskId, generationEpoch);
      if (!mountedRef.current || generationEpochRef.current !== generationEpoch || isStoppedError(err)) return;
      const message = err instanceof Error ? err.message : '生图失败';
      setError(message);
      setProposal(approvedProposal);
      setGeneratingTaskId(null);
      setGeneratingStartedAt(null);
      setGenerationDraft(null);
      setIsSyncing(false);
      phaseRef.current = 'proposal';
      setPhase('proposal');
      void savePendingProposal({
        proposal: approvedProposal,
        pendingAnalysis: pendingAnalysisRef.current,
        pendingReasoning: pendingReasoningRef.current,
        isReedit: true,
      }, sessionIdRef.current);
    }
  }, [appendMessage, isGenerationTaskActive, isSessionCurrent, persistPendingGeneration, proposal, removePendingGenerationForTask, resumeGeneration]);

  const stopStreaming = useCallback(() => {
    generationEpochRef.current += 1;
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    cancelAllPolls();
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    phaseRef.current = 'idle';
    setPhase('idle');
    describeAbortRef.current?.abort();
    userLinksRef.current = [];
    autoContinueCountRef.current = 0;
    proposalQueueRef.current = [];
    setProposalQueue([]);
    void clearPendingProposal(sessionIdRef.current);
    void cancelPendingGenerations();
  }, [cancelAllPolls, cancelPendingGenerations, flushAndCancelRaf]);

  const skipDescribing = useCallback(() => {
    describeAbortRef.current?.abort();
    describeAbortRef.current = null;
  }, []);

  const setImageModel = useCallback((model: ModelId) => {
    if (!mountedRef.current) return;
    setImageModelState(model);
    void saveImageModel(model, sessionIdRef.current);
  }, []);

  const toggleWebSearch = useCallback(() => {
    if (!agentSupportsWebSearch()) return;
    setWebSearchEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('nova-agent-web-search', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [agentSupportsWebSearch]);

  const toggleCdp = useCallback(() => {
    setCdpEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('nova-agent-cdp', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleIntentRecognition = useCallback(() => {
    setIntentRecognition(prev => {
      const next = !prev;
      try { localStorage.setItem('nova-agent-intent-recognition', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 清理上下文：插入一个分隔点，分隔点之前的对话与图片对模型不再可见，但界面保留可见。
  const clearContext = useCallback(() => {
    if (!mountedRef.current || phase !== 'idle') return;
    setMessages(prev => {
      const lastReal = [...prev].reverse().find(m => m.role !== 'context-divider');
      if (!lastReal) return prev;
      if (prev[prev.length - 1]?.role === 'context-divider') return prev;
      const divider: AgentMessage = {
        id: generateUUID(),
        role: 'context-divider',
        text: '以下为新对话，助手已不记得上文',
        createdAt: Date.now(),
      };
      if (mountedRef.current) {
        void putMessage(divider, sessionIdRef.current);
      }
      return [...prev, divider];
    });
    setProposal(null);
    setError(null);
    // 上下文已分隔，模型不再记得之前的链接与批量轮；批量轮状态必须同步忘掉，
    // 否则 maybeAutoContinue 会拿模型看不见的链接继续续跑。
    userLinksRef.current = [];
    autoContinueCountRef.current = 0;
    proposalQueueRef.current = [];
    setProposalQueue([]);
  }, [phase]);

  const clearSession = useCallback(async () => {
    generationEpochRef.current += 1;
    sessionGenerationRef.current = invalidateAgentSession(sessionIdRef.current);
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    cancelAllPolls();
    describeAbortRef.current?.abort();
    const cdpFiles = imagesRef.current
      .map(image => image.remoteUrl)
      .filter((url): url is string => typeof url === 'string' && url.includes('/api/nova/cdp/products/'));
    await clearAllPendingGenerations();
    await clearAgentSession(sessionIdRef.current, sessionGenerationRef.current);
    if (cdpFiles.length > 0) {
      await purgeCdpProductImages(cdpFiles);
    }
    if (!mountedRef.current) return;
    setMessages([]);
    setImages([]);
    setProposal(null);
    // 全量重开：消息/图片/批量轮的 ref 与 state 一起归零，不能等 useEffect 滞后同步
    messagesRef.current = [];
    imagesRef.current = [];
    proposalRef.current = null;
    userLinksRef.current = [];
    autoContinueCountRef.current = 0;
    proposalQueueRef.current = [];
    setProposalQueue([]);
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    setError(null);
    seqRef.current = 0;
    phaseRef.current = 'idle';
    setPhase('idle');
  }, [cancelAllPolls, clearAllPendingGenerations, flushAndCancelRaf]);

  /** 根据消息中的 proposalData 重新打开提案编辑 */
  const reeditProposal = useCallback((messageId: string) => {
    // 仅在空闲时允许重建提案：生成中/提案确认中重入会顶掉当前提案与生成状态
    if (phaseRef.current !== 'idle') return;
    const message = messages.find(m => m.id === messageId);
    if (!message?.proposalData) return;
    const pd = message.proposalData;
    const advancedParams = getGptImageAdvancedParamsForModel(pd.model, {
      quality: pd.gptImageQuality,
      style: pd.gptImageStyle,
      background: pd.gptImageBackground,
    });
    // 构建 AgentProposal 重新进入 proposal 阶段
    const newProposal: AgentProposal = {
      action: pd.action,
      prompt: pd.prompt,
      referencedImageIds: pd.referencedImageIds,
      reason: '重新编辑之前的生图请求。',
      requestedAspectRatio: undefined,
      suggestedAspectRatio: pd.aspectRatio,
      requestedOutputSize: pd.outputSize,
      temperature: pd.temperature,
      gptImageQuality: advancedParams.quality,
      gptImageStyle: advancedParams.style,
      gptImageBackground: advancedParams.background,
      parallelCount: pd.parallelCount,
      // 重新编辑必须保留商品作用域，否则 scopeAgentProposal 无法过滤，
      // 参考图会混入其他商品的图（串图）
      productKey: pd.productKey,
      productName: pd.productName,
      requestedModelId: pd.model,
    };
    // 重新编辑时恢复原始生图模型
    const reeditCatalog = buildModelCatalog();
    const resolvedModel = resolveValidAgentImageModel(resolveAgentModel(
      imageModelRef.current,
      newProposal.requestedModelId,
      newProposal.requestedOutputSize,
      reeditCatalog,
    ));
    if (resolvedModel !== imageModelRef.current) {
      imageModelRef.current = resolvedModel;
      setImageModelState(resolvedModel);
      if (mountedRef.current) {
                void saveImageModel(resolvedModel, sessionIdRef.current);
              }
    }
    // 清除上次待定分析，因为用户要重新编辑
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = true;
    setProposal(newProposal);
    phaseRef.current = 'proposal';
    setPhase('proposal');
    if (mountedRef.current) {
      void savePendingProposal({
        proposal: newProposal,
        pendingAnalysis: '',
        pendingReasoning: '',
        isReedit: true,
      }, sessionIdRef.current);
    }
  }, [messages]);

  /** 删除单条消息（用户或助手），同时清理关联的图片资源 */
  const deleteMessage = useCallback((messageId: string) => {
    if (!mountedRef.current || phaseRef.current === 'generating' || activeGenerationTasksRef.current.size > 0) return;
    const message = messagesRef.current.find(item => item.id === messageId);
    if (!message) return;
    const kept = messagesRef.current.filter(item => item.id !== messageId);
    messagesRef.current = kept;
    setMessages(kept);
    void deleteMessages([messageId], sessionIdRef.current);
    cleanupOrphanImages(kept, message.imageIds || []);
  }, [cleanupOrphanImages]);

  /** 撤回：删除从指定消息开始（含）之后的所有消息，同时清理关联图片 */
  const rollbackMessages = useCallback((fromMessageId: string) => {
    if (!mountedRef.current || phaseRef.current === 'generating' || activeGenerationTasksRef.current.size > 0) return;
    const current = messagesRef.current;
    const fromIndex = current.findIndex(message => message.id === fromMessageId);
    if (fromIndex === -1) return;
    const kept = current.slice(0, fromIndex);
    const removed = current.slice(fromIndex);
    messagesRef.current = kept;
    setMessages(kept);
    void deleteMessages(removed.map(message => message.id), sessionIdRef.current);
    cleanupOrphanImages(kept, removed.flatMap(message => message.imageIds || []));
    setProposal(null);
    void clearPendingProposal(sessionIdRef.current);
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    phaseRef.current = 'idle';
    setPhase('idle');
  }, [cleanupOrphanImages, flushAndCancelRaf]);

  /**
   * 最后一条用户消息的 id；不存在或其后还有别的用户消息时为 null。
   *
   * 重试**只允许**作用于它，这是刻意的限制：重试中间某轮意味着要丢弃它之后
   * 的全部对话，否则模型会看到「同一个问题两个不同答案」的历史而错乱。
   * 与其偷偷替用户删掉后面几轮，不如只在最后一轮给出重试入口 ——
   * 想改中间某轮，用现成的「撤回以下所有」把尾巴清掉再重试。
   */
  const retryableMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'user') return message.id;
      // 分隔线之后没有用户消息 → 没有可重试的一轮
      if (message.role === 'context-divider') return null;
    }
    return null;
  }, [messages]);

  /**
   * 重试最后一条用户消息：删掉它之后的助手回复，用同一条用户消息重新发起请求。
   *
   * 用户消息本身**保留**（不重新登记图片、不重算描述），只回滚模型侧产物。
   * 因此关联图片一律不清理 —— 它们仍被那条保留下来的用户消息引用。
   */
  const retryMessage = useCallback((messageId: string) => {
    if (phaseRef.current !== 'idle' || activeGenerationTasksRef.current.size > 0) return;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;
    const target = messages[index];
    if (target.role !== 'user' || messageId !== retryableMessageId) return;

    // 丢弃这条用户消息之后的所有内容（助手回复、系统提示、提案分析）
    const toRemove = messages.slice(index + 1);
    const kept = messages.slice(0, index + 1);
    if (toRemove.length > 0) {
      messagesRef.current = kept;
      setMessages(kept);
      void deleteMessages(toRemove.map(m => m.id), sessionIdRef.current);
      // 只清理「被删除消息引用、且保留部分不再引用」的图片。
      // 用户消息还在，它引用的上传图不会被误删。
      cleanupOrphanImages(kept, toRemove.flatMap(m => m.imageIds || []));
    }

    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = false;
    setProposal(null);
    if (mountedRef.current) {
      void clearPendingProposal(sessionIdRef.current);
    }
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    setError(null);

    const { history, catalog } = sliceActiveContext(kept, images);
    runChat(history, catalog);
  }, [messages, retryableMessageId, images, cleanupOrphanImages, flushAndCancelRaf, runChat]);

  // 组件卸载时清理：取消 rAF + 停止轮询/流式/描述，避免卸载后仍每 4s 轮询、
  // 在卸载后继续下载/写库/setState（内存泄漏 + 卸载后写状态）。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAllPolls();
      streamHandleRef.current?.abort();
      describeAbortRef.current?.abort();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [cancelAllPolls]);

  return {
    ready,
    hasApiKey,
    phase,
    messages,
    images,
    proposal,
    streamingText,
    streamingReasoning,
    imageModel,
    error,
    generatingTaskId,
    generatingStartedAt,
    generationDraft,
    messageActionsDisabled: activeGenerationCount > 0 || phase === 'generating',
    isSyncing,
    webSearchEnabled,
    agentSupportsWebSearch: agentSupportsWebSearch(),
    cdpEnabled,
    intentRecognition,
    sendMessage,
    approveProposal,
    cancelProposal,
    reeditProposal,
    withdrawTurn,
    deleteMessage,
    rollbackMessages,
    retryMessage,
    retryableMessageId,
    checkNow,
    stopStreaming,
    skipDescribing,
    setImageModel,
    toggleWebSearch,
    toggleCdp,
    toggleIntentRecognition,
    clearSession,
    clearContext,
    redescribeImage,
    runSelfCheck,
    rememberMemoryEntry,
    draftMemoryNoteForReview,
    pendingDrafts,
    refreshPendingDrafts,
    approveDraft,
    rejectDraft,
    approveAllDrafts,
    draftCaseFromImage,
    memoryReview,
    memoryReviewBusy,
    runMemoryReview,
    dismissError: () => setError(null),
  };
}
