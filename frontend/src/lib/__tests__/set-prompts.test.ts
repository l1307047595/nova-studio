import { describe, expect, it } from 'vitest';
import { buildSetPrompts, describeSetMode, stripSetBatchLanguage, SET_LOCK_PREFIX } from '@/lib/set-prompts';

describe('stripSetBatchLanguage', () => {
  it('把用户的真实原话收敛成「这一张」的描述，并删掉所有引发拼图的措辞', () => {
    const stripped = stripSetBatchLanguage('这个产品生成电商套图，5张，连续生成');
    expect(stripped).toContain('电商图');
    expect(stripped).not.toContain('套图');
    expect(stripped).not.toContain('连续生成');
    expect(stripped).not.toMatch(/5\s*张/);
  });

  it('「帮我生成电商套图」这类口语也收敛', () => {
    const stripped = stripSetBatchLanguage('帮我生成电商套图');
    expect(stripped).not.toContain('套图');
    expect(stripped).toContain('生成');
  });

  it('剥掉拼接/宫格/分屏措辞', () => {
    const stripped = stripSetBatchLanguage('做一组4张拼接成一张的九宫格主图，分屏展示');
    expect(stripped).not.toContain('拼接');
    expect(stripped).not.toContain('九宫格');
    expect(stripped).not.toContain('分屏');
    expect(stripped).not.toMatch(/4\s*张/);
  });

  it('不动用户自己写的比例文字（比例是参数，但写了也不该被吃掉）', () => {
    expect(stripSetBatchLanguage('电商主图，画面比例 3:4')).toContain('3:4');
  });

  it('剥词后不留下连续标点或空格', () => {
    const stripped = stripSetBatchLanguage('生成电商套图，，　连续生成，');
    expect(stripped).not.toMatch(/[，,]{2,}/);
    expect(stripped).not.toMatch(/^[，,\s]|[，,\s]$/);
  });
});

describe('buildSetPrompts', () => {
  it('N=5 时给出 5 条，每条锚定「第 i 张 / 共 5 张」并带单画面锁', () => {
    const prompts = buildSetPrompts('帮我生成电商套图', 5);
    expect(prompts).toHaveLength(5);
    prompts.forEach((p, idx) => {
      expect(p).toContain(`共 5 张里的第 ${idx + 1} 张`);
      expect(p).toContain(SET_LOCK_PREFIX);
      expect(p).toContain('禁止拼接');
      expect(p).not.toContain('套图');
    });
  });

  it('带参考图时补上「以参考图为唯一基准」，不带图时不出现', () => {
    const withRef = buildSetPrompts('生成电商套图', 3, { hasReferenceImages: true });
    expect(withRef[0]).toContain('以参考图中的商品为唯一基准');
    const withoutRef = buildSetPrompts('生成电商套图', 3);
    expect(withoutRef[0]).not.toContain('以参考图中的商品为唯一基准');
  });

  it('N=1 也给单画面锁（单张也不许拼图），但不写「第 i 张」', () => {
    const prompts = buildSetPrompts('生成电商套图', 1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('禁止拼接');
    expect(prompts[0]).not.toContain('里的第 1 张');
  });

  it('张数做边界收敛：非法/超范围都落到 1..8', () => {
    expect(buildSetPrompts('x', 0)).toHaveLength(1);
    expect(buildSetPrompts('x', -3)).toHaveLength(1);
    expect(buildSetPrompts('x', Number.NaN)).toHaveLength(1);
    expect(buildSetPrompts('x', 99)).toHaveLength(8);
  });

  it('每条都以用户描述开头语义完整（不是只剩锁）', () => {
    const prompts = buildSetPrompts('白色背景下这个产品', 2);
    prompts.forEach(p => expect(p).toContain('白色背景下这个产品'));
  });
});

describe('describeSetMode', () => {
  it('文案里写明张数且说明不拼接', () => {
    const text = describeSetMode(5);
    expect(text).toContain('5');
    expect(text).toContain('不拼接');
  });
});
