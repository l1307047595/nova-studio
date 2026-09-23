import { describe, expect, it } from 'vitest';
import {
  buildSetSheetPrompt,
  describeSetMode,
  resolveSetSheetLayout,
  SET_COUNT_VALUES,
} from '@/lib/set-prompts';

// 背景（2026-09-23 实测）：早先是「把一句话拆成 N 条各画一张的提示词」，结果后端并发发 N 次
// 同一段空指令（「生成电商图」），模型没有方向 → N 张各是随机画面，用户判为「一塌糊涂」。
// 改成「一张等分拼图 + 本地切图」后，模型会自己安排 N 个不同画面（实测 2×3 五格各不相同）。
describe('resolveSetSheetLayout', () => {
  it('按张数挑最接近正方形的网格与画布比例', () => {
    expect(resolveSetSheetLayout(2)).toMatchObject({ rows: 1, cols: 2, cells: 2, aspectRatio: '16:9' });
    expect(resolveSetSheetLayout(4)).toMatchObject({ rows: 2, cols: 2, cells: 4, aspectRatio: '1:1' });
    expect(resolveSetSheetLayout(5)).toMatchObject({ rows: 2, cols: 3, cells: 5, aspectRatio: '3:2' });
    expect(resolveSetSheetLayout(6)).toMatchObject({ rows: 2, cols: 3, cells: 6, aspectRatio: '3:2' });
    expect(resolveSetSheetLayout(8)).toMatchObject({ rows: 3, cols: 3, cells: 8, aspectRatio: '1:1' });
  });

  it('张数做边界收敛（2..8），非法值不炸', () => {
    expect(resolveSetSheetLayout(1).cells).toBe(2);
    expect(resolveSetSheetLayout(0).cells).toBe(2);
    expect(resolveSetSheetLayout(Number.NaN).cells).toBe(2);
    expect(resolveSetSheetLayout(99).cells).toBe(8);
  });

  it('候选张数与网格能力一致（2..8）', () => {
    expect([...SET_COUNT_VALUES]).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('buildSetSheetPrompt', () => {
  it('保留用户原话（不再剥「套图」），并追加等分网格规格', () => {
    const prompt = buildSetSheetPrompt('帮我生成电商套图', 5);
    expect(prompt).toContain('帮我生成电商套图');
    expect(prompt).toContain('2 行 3 列');
    expect(prompt).toContain('等分网格图');
  });

  it('格子多于张数时，要求多余的格子留白（5 张 → 第 6 格空着）', () => {
    const prompt = buildSetSheetPrompt('生成电商套图', 5);
    expect(prompt).toContain('共 6 格');
    expect(prompt).toContain('第 6 格保持纯白空着');
  });

  it('正好填满网格时不提留白', () => {
    const prompt = buildSetSheetPrompt('生成电商套图', 4);
    expect(prompt).toContain('共 4 格，每格都要画');
    expect(prompt).not.toContain('空着');
  });

  it('三个切图硬要求必须写进提示词（不写就切不准）', () => {
    const prompt = buildSetSheetPrompt('生成电商套图', 6);
    expect(prompt).toContain('尺寸完全相等');
    expect(prompt).toContain('不得出现分隔线、边框、色块或留白');
    expect(prompt).toContain('不得跨越格子边界');
  });

  it('带参考图时补铁律基准句；不带图时不出现', () => {
    expect(buildSetSheetPrompt('生成电商套图', 4, { hasReferenceImages: true })).toContain('以参考图中的商品为唯一基准');
    expect(buildSetSheetPrompt('生成电商套图', 4)).not.toContain('以参考图中的商品为唯一基准');
  });

  it('要求各格画面互不相同（由模型自行安排，不给图型清单）', () => {
    const prompt = buildSetSheetPrompt('生成电商套图', 6);
    expect(prompt).toContain('互不相同');
    expect(prompt).toContain('由你自行安排');
  });
});

describe('describeSetMode', () => {
  it('文案写明网格与切图结果，并说明不拼接', () => {
    const text = describeSetMode(5);
    expect(text).toContain('2×3');
    expect(text).toContain('切成 5 张');
    expect(text).toContain('不拼接');
  });
});
