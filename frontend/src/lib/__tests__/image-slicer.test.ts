import { describe, expect, it } from 'vitest';
import { computeGridRects } from '@/lib/image-slicer';

// 切图按等分坐标切，所以「坐标算得对不对」直接决定套图能不能用。
describe('computeGridRects', () => {
  it('2×3 网格：1536×1024 切成 6 格 512×512（实测用的就是这组）', () => {
    const rects = computeGridRects(1536, 1024, { rows: 2, cols: 3, cells: 6 });
    expect(rects).toHaveLength(6);
    expect(rects.every(r => r.sw === 512 && r.sh === 512)).toBe(true);
    expect(rects[0]).toEqual({ sx: 0, sy: 0, sw: 512, sh: 512 });
    expect(rects[2]).toEqual({ sx: 1024, sy: 0, sw: 512, sh: 512 });
    expect(rects[3]).toEqual({ sx: 0, sy: 512, sw: 512, sh: 512 });
    expect(rects[5]).toEqual({ sx: 1024, sy: 512, sw: 512, sh: 512 });
  });

  it('只取前 cells 格（多余格子是模型留白，丢掉）', () => {
    const rects = computeGridRects(1536, 1024, { rows: 2, cols: 3, cells: 5 });
    expect(rects).toHaveLength(5);
    expect(rects[4]).toEqual({ sx: 512, sy: 512, sw: 512, sh: 512 });   // 第 5 格 = 第 2 行第 2 列
  });

  it('2×2 网格在 1024×1024 上得到四等分', () => {
    const rects = computeGridRects(1024, 1024, { rows: 2, cols: 2, cells: 4 });
    expect(rects).toEqual([
      { sx: 0, sy: 0, sw: 512, sh: 512 },
      { sx: 512, sy: 0, sw: 512, sh: 512 },
      { sx: 0, sy: 512, sw: 512, sh: 512 },
      { sx: 512, sy: 512, sw: 512, sh: 512 },
    ]);
  });

  it('不能整除时不留缝隙也不越界（余数分给前面的格子）', () => {
    const rects = computeGridRects(1000, 999, { rows: 3, cols: 3, cells: 9 });
    expect(rects[0].sx).toBe(0);
    expect(rects[2].sx + rects[2].sw).toBe(1000);            // 右边界正好贴边
    expect(rects[6].sy + rects[6].sh).toBe(999);             // 下边界正好贴边
    // 相邻格子首尾相接，不重叠、不留缝
    for (let i = 1; i < 3; i += 1) expect(rects[i].sx).toBe(rects[i - 1].sx + rects[i - 1].sw);
  });

  it('非法输入被收敛，不返回空数组', () => {
    expect(computeGridRects(0, 0, { rows: 0, cols: 0, cells: 0 })).toHaveLength(1);
    expect(computeGridRects(512, 512, { rows: 2, cols: 2, cells: 99 })).toHaveLength(4);
  });
});
