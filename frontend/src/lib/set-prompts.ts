/**
 * 套图模式：一张等分拼图 → 本地按网格切成 N 张独立图。
 *
 * 为什么不是「拆成 N 条提示词各发一次」（曾经实现过，已废弃，2026-09-23）：
 *   后端表达张数是按 parallelCount 并发发 N 次**同一段 prompt**（请求体里没有 n 参数）。
 *   一句话被剥掉「套图/N张」后变成「生成电商图」这种空指令 × N，模型没有方向 →
 *   每张自由发挥，N 张各是一个随机画面，实测「一塌糊涂」。
 *   反过来，让模型**一次画满一张等分网格**时它会自己安排 N 个不同画面
 *   （实测 2 行 3 列：手持套装+6PCS / 细节特写+局部放大 / 收藏场景 / 礼盒包装 / 户外卖点，
 *   五格各不相同且商品一致），本地按等分坐标切开即可 ——
 *   零模型调用、零图型清单，还省 N-1 次生成。
 *
 * 两个硬要求（不满足就切不准）：
 *   ① 网格必须**等分**（切图按 cols/rows 均分坐标切）→ 提示词里写死行数/列数；
 *   ② 格与格之间**不得有分隔线/边框/留白**，任何元素不得跨越格子边界。
 */

import type { AspectRatio } from '@/lib/job-store';

export interface SetSheetLayout {
  /** 行数 */
  rows: number;
  /** 列数 */
  cols: number;
  /** 真正要用的格数（= 用户要的张数）；不足的格子让模型留白 */
  cells: number;
  /** 拼图画布比例（挑最接近 cols:rows 的受支持比例，保证单格接近正方形） */
  aspectRatio: AspectRatio;
}

/** 受支持的套图张数（网格能排得整齐的范围） */
export const SET_COUNT_VALUES = [2, 3, 4, 5, 6, 7, 8] as const;

/**
 * 张数 → 网格：选最接近正方形的排法，并挑一个受支持的画布比例，
 * 让单格尽量接近正方形（单格像素 = 画布 ÷ 列数）。
 */
export function resolveSetSheetLayout(count: number): SetSheetLayout {
  const cells = Math.max(2, Math.min(8, Math.floor(Number(count) || 2)));
  if (cells <= 2) return { rows: 1, cols: 2, cells, aspectRatio: '16:9' };
  if (cells <= 4) return { rows: 2, cols: 2, cells, aspectRatio: '1:1' };
  if (cells <= 6) return { rows: 2, cols: 3, cells, aspectRatio: '3:2' };
  return { rows: 3, cols: 3, cells, aspectRatio: '1:1' };
}

export interface BuildSetSheetOptions {
  /** 本次是否带参考图。带图时补一句「以参考图为唯一基准」，与铁律一致。 */
  hasReferenceImages?: boolean;
}

const REFERENCE_BASIS =
  '以参考图中的商品为唯一基准：严格保持商品的造型、比例、颜色、材质、包装、Logo 与文字完全不变，不重新设计商品、不新增原图没有的部件。';

/**
 * 生成「一张等分网格拼图」的提示词：**保留用户原话**（不再剥词 —— 现在要的正是「一套」，
 * 每格画面由模型自己安排），只在末尾追加网格规格。
 */
export function buildSetSheetPrompt(prompt: string, count: number, options: BuildSetSheetOptions = {}): string {
  const layout = resolveSetSheetLayout(count);
  const userText = String(prompt || '').replace(/\s+/g, ' ').trim();
  const total = layout.rows * layout.cols;
  const blanks = total - layout.cells;
  const blankClause = blanks > 0
    ? `（共 ${total} 格，其中第 ${layout.cells + 1}${blanks > 1 ? `~${total}` : ''} 格保持纯白空着，不要画任何东西）`
    : `（共 ${total} 格，每格都要画）`;
  const grid =
    `【套图排版要求】输出一张 ${layout.rows} 行 ${layout.cols} 列的**等分网格图**${blankClause}：` +
    '每一格是一张完整、独立的电商图，所有格子合起来构成一整套电商套图；' +
    '各格画面必须互不相同（由你自行安排，例如产品全貌 / 细节特写 / 使用场景 / 卖点展示 / 包装信息，不限于此）；' +
    '所有格子尺寸完全相等；格与格之间不得出现分隔线、边框、色块或留白；' +
    '任何元素、文字、光影都不得跨越格子边界；每格内部各自构图完整、独立成图。';
  return [options.hasReferenceImages ? REFERENCE_BASIS : '', userText, grid].filter(Boolean).join('\n\n');
}

/** 套图模式下的界面提示文案（工作台与画布共用，避免两处各写一句）。 */
export function describeSetMode(count: number): string {
  const layout = resolveSetSheetLayout(count);
  return `套图模式：出 1 张 ${layout.rows}×${layout.cols} 等分拼图后自动切成 ${layout.cells} 张（不拼接、不调文本模型）`;
}
