/**
 * 拼图切片：把套图模式生成的等分网格图按坐标切成 N 张独立图。
 *
 * 为什么等分切而不是「智能识别面板」：套图模式的提示词已经把网格写死为 rows×cols 等分、
 * 且要求格与格之间无分隔线、元素不跨界 —— 等分坐标就是准确边界（实测 2×3 图切成
 * 512×512 六格，五格画面各自完整、无跨格截断）。智能识别反而会引入不确定性。
 *
 * 坐标计算做成纯函数（computeGridRects），便于单测；真正的像素裁切走 canvas。
 */

export interface GridRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface SliceGrid {
  rows: number;
  cols: number;
  /** 要保留的格数（按行优先取前 cells 格；多余格子是模型留白的部分，丢掉） */
  cells: number;
}

/**
 * 等分网格的裁切矩形（行优先）。
 * 用 Math.round 分配边界，避免整除余数导致最后一行/列被截掉几像素。
 */
export function computeGridRects(width: number, height: number, grid: SliceGrid): GridRect[] {
  const rows = Math.max(1, Math.floor(grid.rows));
  const cols = Math.max(1, Math.floor(grid.cols));
  const cells = Math.max(1, Math.min(rows * cols, Math.floor(grid.cells)));
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const rects: GridRect[] = [];
  for (let index = 0; index < cells; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const sx = Math.round((col * w) / cols);
    const ex = Math.round(((col + 1) * w) / cols);
    const sy = Math.round((row * h) / rows);
    const ey = Math.round(((row + 1) * h) / rows);
    rects.push({ sx, sy, sw: Math.max(1, ex - sx), sh: Math.max(1, ey - sy) });
  }
  return rects;
}

/**
 * 把一张拼图 blob 切成 N 张 PNG blob。
 * 浏览器环境（canvas）；失败时抛错，由调用方决定是否回退成「保留整张拼图」。
 */
export async function sliceBlobToGrid(blob: Blob, grid: SliceGrid): Promise<Blob[]> {
  const bitmap = await createImageBitmap(blob);
  try {
    const rects = computeGridRects(bitmap.width, bitmap.height, grid);
    const out: Blob[] = [];
    for (const rect of rects) {
      const canvas = document.createElement('canvas');
      canvas.width = rect.sw;
      canvas.height = rect.sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布上下文，切图失败');
      ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
      const piece = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!piece) throw new Error('切图导出失败');
      out.push(piece);
    }
    return out;
  } finally {
    bitmap.close?.();
  }
}
