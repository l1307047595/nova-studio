/**
 * 视觉描述（describe）专用的缩图。
 *
 * 目的（按实测结论写的，别把它的作用想大）：
 *   1) 省带宽：2236×2236/356KB → 1024×1024/145KB（约 −60%）
 *   2) 省视觉 token（=省钱）
 *   3) 降低请求体过大（后端 413）的风险
 *
 * **它不降耗时**：实测同一张图 1024 与 2560 的耗时统计上无差别
 * （1024：21.7/25.4/26.2s；2560：20.1/22.4/24.6/28.2s）——耗时由**推理长度**
 * 主导（这个模型每次先吐 3000~3700 字 reasoning），跟图片细节量无关。
 * 真正解决「(图片描述生成失败)」的是把 describe 单次超时从 20s 提到 60s
 * （见 agent-chat-client.ts 的 AGENT_IMAGE_DESCRIBE_ATTEMPT_TIMEOUT_MS）。
 *
 * 注意：**只用于 describe**。真正发给生图模型/存库的参考图仍用原图，
 * 否则商品保真度会掉。
 */

/** describe 用的最长边（够模型认商品，又不会把推理拖长） */
export const DESCRIBE_MAX_SIDE = 1024;

/**
 * 算出缩图目标尺寸；已经够小则返回 null（表示「不用缩」）。
 * 纯函数，方便单测。
 */
export function describeDownscaleTarget(
  width: number,
  height: number,
  maxSide: number = DESCRIBE_MAX_SIDE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0 || longest <= maxSide) return null;
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 解码兜底：极端情况下（解码器卡住）不让描述无限等下去，直接回退原图 */
const DESCRIBE_DECODE_TIMEOUT_MS = 3000;

function loadImage(dataUrl: string, timeoutMs = DESCRIBE_DECODE_TIMEOUT_MS): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('图片解码超时'));
    }, timeoutMs);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('图片解码失败'));
    };
    img.src = dataUrl;
  });
}

/**
 * 把 data URL 缩到 describe 用的尺寸并转成 JPEG。
 *
 * **任何一步失败都返回原图** —— 缩图只是省时间，绝不能因为它让描述直接失败
 * （测试环境没有 canvas，这里也会走原图分支）。
 */
export async function downscaleDataUrlForDescribe(
  dataUrl: string,
  maxSide: number = DESCRIBE_MAX_SIDE,
): Promise<string> {
  try {
    if (!dataUrl || typeof document === 'undefined') return dataUrl;
    const img = await loadImage(dataUrl);
    const target = describeDownscaleTarget(img.naturalWidth || img.width, img.naturalHeight || img.height, maxSide);
    if (!target) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, target.width, target.height);
    const out = canvas.toDataURL('image/jpeg', 0.85);
    // toDataURL 失败时会返回 "data:,"（长度极短），这种情况回退原图
    return out && out.length > 64 ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}
