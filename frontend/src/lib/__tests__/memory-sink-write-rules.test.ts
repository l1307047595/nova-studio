import { describe, expect, it } from 'vitest';
import { dedupeDrafts, isUsableDraft, normalizeDraftTags } from '@/lib/nova-memory-sink';

// 回归：这些是真实从「空闲心跳」漏进待确认队列的脏数据（用户 2026-09-22 截图）。
// 写入判据改严后，机械可判的必须被挡在队列外；语义类（提示词正文）靠起草提示词里的判据 + 自检挡。
const REAL_JUNK = {
  /** 图里英文文案原文 —— 素材不是记忆，还带合规风险 */
  englishDump: '英文原文内容：ALL-IN-ONE GEL VENOM NAIL CAN | NOURISH, PROTECT, SHINE. 3-PCS SET / 95% BEE VENOM / ALL-DAY CARE / GLOSSY FINISH #趾甲护理液 #海报文案 #英文原句 #合规',
  /** 半截话：规则没写完就提出来了 */
  halfWritten: '指甲护理类目文案合规改写规则 - 标签：#趾甲护理液 #卖点图 #深祖母绿琥珀金 #合规 - 判断：用户原始文案含"增厚、变色、受损指甲"等涉病（待补充？）',
  /** 超长：把一段提示词整段塞进一条 */
  tooLong: `箔光点/柔焦金色光斑 + 琥珀色微光大理事台面；金色侧逆光勾勒，与浅紫瓶身强对比，前景商品 + 中景道具 + 远景场景，softbox main light + side rim light + bottom fill light，commercial product photography，ultra-detailed，vivid saturated colors，macro detail，glossy texture，soft depth of field，3D render quality #趾甲护理液 #五图统一 #深祖母绿琥珀金 #高奢风`,
  noTag: '用户说这个背景太白了要换掉', // 规则/案例必须带标签
  empty: '略',
};

const GOOD_FEEDBACK = '实际使用图不要把手裁掉 —— 用户退回过一次，手部五指必须完整入画 #趾甲护理液 #实际使用图 #构图';
const GOOD_LIBRARY = '主图用高对比深绿背景 + 商品居中，避免纯白底 —— 白底会被判成通用产品摄影域 #趾甲护理液 #主图 #深祖母绿';

describe('记忆写入判据（isUsableDraft）', () => {
  it('挡掉图内英文文案原文', () => {
    expect(isUsableDraft('library', REAL_JUNK.englishDump)).toBe(false);
  });

  it('挡掉半截话（待补充 / 未完成 / …结尾）', () => {
    expect(isUsableDraft('proposal', REAL_JUNK.halfWritten)).toBe(false);
    expect(isUsableDraft('feedback', '背景要换 —— 还没想好（待补充）')).toBe(false);
    expect(isUsableDraft('feedback', '这块要改…')).toBe(false);
  });

  it('挡掉超长条目（规则/案例 = 一句话）', () => {
    expect(isUsableDraft('library', REAL_JUNK.tooLong)).toBe(false);
  });

  it('挡掉没有标签的规则/案例', () => {
    expect(isUsableDraft('feedback', REAL_JUNK.noTag)).toBe(false);
    expect(isUsableDraft('library', REAL_JUNK.noTag)).toBe(false);
  });

  it('挡掉空话 / 太短的', () => {
    expect(isUsableDraft('feedback', REAL_JUNK.empty)).toBe(false);
    expect(isUsableDraft('feedback', '')).toBe(false);
  });

  it('放行合格的规则与案例（带标签、一句话、中文描述）', () => {
    expect(isUsableDraft('feedback', GOOD_FEEDBACK)).toBe(true);
    expect(isUsableDraft('library', GOOD_LIBRARY)).toBe(true);
  });

  it('英文只放行「基调句」写法（Consistent style 开头）', () => {
    const base = 'Consistent style: deep emerald and amber-gold palette, softbox lighting, luxury commercial photography —— 适用于趾甲护理液套图 #趾甲护理液 #五图统一 #深祖母绿琥珀金';
    expect(isUsableDraft('library', base)).toBe(true);
  });
});

describe('标签归一化（normalizeDraftTags）', () => {
  // 真模型（A/B 实测）实际输出的是「维度:值」，不是 #标签；不归一化会被判据误杀
  const MODEL_REAL_OUTPUT = '实际使用图不得裁手，五指必须完整入画。 商品类型:趾甲护理液 图型:实际使用图 合规:主体完整性';

  it('「维度:值」→ #标签', () => {
    const fixed = normalizeDraftTags(MODEL_REAL_OUTPUT);
    expect(fixed).toContain('#趾甲护理液');
    expect(fixed).toContain('#实际使用图');
    expect(fixed).toContain('#主体完整性');
    expect(fixed).not.toContain('商品类型:');
  });

  it('一个维度里多个值拆成多个标签', () => {
    expect(normalizeDraftTags('图型:主图/海报')).toBe('#主图 #海报');
    expect(normalizeDraftTags('合规:文案、陈列')).toBe('#文案 #陈列');
  });

  it('归一化前后都算合格（避免因格式误杀）', () => {
    expect(isUsableDraft('feedback', MODEL_REAL_OUTPUT)).toBe(true);
    expect(isUsableDraft('feedback', normalizeDraftTags(MODEL_REAL_OUTPUT))).toBe(true);
  });

  it('原本就是 #标签的不动', () => {
    expect(normalizeDraftTags(GOOD_FEEDBACK)).toBe(GOOD_FEEDBACK);
  });
});

describe('草稿去重（dedupeDrafts）', () => {
  it('批内重复只留一条（忽略标点与标签差异）', () => {
    const out = dedupeDrafts([
      '主图底部留白不足 —— 文字压到商品 #捏捏乐 #主图',
      '主图底部留白不足，文字压到商品。#捏捏乐 #主图',
    ]);
    expect(out).toHaveLength(1);
  });

  it('与已有条目（待确认队列 / 已注入记忆）重复的不再提', () => {
    const existing = ['实际使用图不要把手裁掉 —— 五指必须完整入画 #趾甲护理液 #实际使用图'];
    const out = dedupeDrafts(['实际使用图不要把手裁掉 —— 五指必须完整入画 #趾甲护理液 #实际使用图'], existing);
    expect(out).toHaveLength(0);
  });

  it('不同内容照常保留', () => {
    const out = dedupeDrafts([GOOD_FEEDBACK, GOOD_LIBRARY]);
    expect(out).toHaveLength(2);
  });
});
