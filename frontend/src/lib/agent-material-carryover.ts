/**
 * 新建会话时，把上一个会话的**商品素材图**带过去。
 *
 * 为什么必须做（用户 2026-09-23 反馈「一开新对话就说我没有参考图」）：
 *   Agent 会话的图片存在各会话自己的库里（blob key = `agent-session-<会话id>-<imgId>`），
 *   新会话 = 目录为空 → 铁律「没有参考图就不出图」→ 之后每个提案都被拦下并显示「生成失败」。
 *   商品素材图是**用户的资产**，不该因为「换了个会话」就消失。
 *
 * 只带素材（上传的 / 素材库导入的），**不带生成图**：生成图是产物，不是商品基准。
 */

import {
  getAgentImageBase64,
  loadAgentSession,
  putImageRecord,
  storeAgentImageBytes,
} from '@/lib/agent-context-store';
import type { AgentImageRecord } from '@/lib/agent-chat-config';

/** 最多带多少张（目录太长会白烧上下文，取最近这几张） */
export const MAX_CARRIED_IMAGES = 8;

/** 选要带的素材图：排除生成图，取最近 limit 张（纯函数，便于单测） */
export function selectCarryOverImages(
  images: AgentImageRecord[],
  limit = MAX_CARRIED_IMAGES,
): AgentImageRecord[] {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (safeLimit === 0) return [];
  return (images || [])
    .filter(image => image.source !== 'generated')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-safeLimit);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'image/png' });
}

export interface CarryOverResult {
  copied: number;
  imgIds: string[];
}

/**
 * 把 fromSessionId 里的素材图复制进 toSessionId（记录 + 字节都要复制，
 * 因为字节的 key 里含会话 id）。单张失败不影响其它张，也绝不阻塞「新建会话」本身。
 */
export async function carryOverMaterialImages(
  fromSessionId: string,
  toSessionId: string,
  limit = MAX_CARRIED_IMAGES,
): Promise<CarryOverResult> {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return { copied: 0, imgIds: [] };

  const [source, target] = await Promise.all([
    loadAgentSession(fromSessionId),
    loadAgentSession(toSessionId),
  ]);
  const existing = new Set((target.images || []).map(image => image.imgId));
  const picked = selectCarryOverImages(source.images || [], limit);

  const imgIds: string[] = [];
  for (const record of picked) {
    if (existing.has(record.imgId)) continue;
    try {
      const bytes = await getAgentImageBase64(record.imgId, fromSessionId);
      if (!bytes) continue;
      await storeAgentImageBytes(record.imgId, base64ToBlob(bytes.data, bytes.mimeType || record.mimeType), toSessionId);
      await putImageRecord(record, toSessionId);
      imgIds.push(record.imgId);
    } catch {
      // 单张失败（字节缺失 / 远程图下载失败）跳过，不影响其余
    }
  }
  return { copied: imgIds.length, imgIds };
}
