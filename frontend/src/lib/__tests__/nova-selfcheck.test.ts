import { describe, expect, it } from 'vitest';
import { describeSelfCheck, parseSelfCheckOutput } from '../nova-selfcheck';
import { AGENT_SELF_CHECK_PROMPT, extractComplianceRules } from '../agent-chat-config';

describe('parseSelfCheckOutput', () => {
  it('解析标准 JSON 结论', () => {
    const result = parseSelfCheckOutput(
      '{"status":"warn","summary":"件数不对","issues":[{"kind":"件数不符","detail":"参考图 3 件，结果图 2 件"}]}',
      { imageIds: ['img_1', 'img_2'], model: 'mock' },
    );
    expect(result.status).toBe('warn');
    expect(result.summary).toBe('件数不对');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({ kind: '件数不符', detail: '参考图 3 件，结果图 2 件' });
    expect(result.imageIds).toEqual(['img_1', 'img_2']);
  });

  it('容忍 ```json 包裹与前后解释文字', () => {
    const wrapped = '好的，结论如下：\n```json\n{"status":"pass","summary":"一致","issues":[]}\n```\n以上。';
    const result = parseSelfCheckOutput(wrapped);
    expect(result.status).toBe('pass');
    expect(result.issues).toHaveLength(0);
  });

  it('与参考图矛盾的数量标注、以及命中违禁词，都要能记进 issues', () => {
    const mismatch = parseSelfCheckOutput(
      '{"status":"warn","summary":"数量标注对不上","issues":[{"kind":"画面文字矛盾","detail":"参考图 3 件，结果图写 2PCS SET"}]}',
    );
    expect(mismatch.status).toBe('warn');
    expect(mismatch.issues[0].kind).toBe('画面文字矛盾');
    const banned = parseSelfCheckOutput(
      '{"status":"warn","summary":"文案违规","issues":[{"kind":"画面文字违规","detail":"出现 military 一词"}]}',
    );
    expect(banned.issues[0].kind).toBe('画面文字违规');
  });

  it('解析不出 JSON 时记 unknown 而不是抛错', () => {
    const result = parseSelfCheckOutput('我看不出问题');
    expect(result.status).toBe('unknown');
    expect(result.issues).toHaveLength(0);
  });

  it('status 非法时降级为 unknown', () => {
    const result = parseSelfCheckOutput('{"status":"maybe","summary":"不确定","issues":[]}');
    expect(result.status).toBe('unknown');
  });

  it('丢弃没有意义的空 issue', () => {
    const result = parseSelfCheckOutput('{"status":"warn","summary":"x","issues":[{"kind":"其他","detail":""},null]}');
    expect(result.issues).toHaveLength(0);
  });

  it('保留原始输出便于排查（截断到 2000 字）', () => {
    const long = 'x'.repeat(5000);
    const result = parseSelfCheckOutput(`{"status":"pass","summary":"ok","issues":[]}${long}`);
    expect(result.raw?.length).toBeLessThanOrEqual(2000);
  });
});

describe('describeSelfCheck', () => {
  it('未自检', () => {
    expect(describeSelfCheck(undefined).label).toBe('未自检');
  });

  it('通过 / 发现问题 / 失败分别给出不同文案', () => {
    expect(describeSelfCheck({ status: 'pass', summary: '一致', issues: [], checkedAt: 0 }).tone).toBe('pass');
    const warn = describeSelfCheck({
      status: 'warn',
      summary: '存在问题',
      issues: [{ kind: '件数不符', detail: '少了 1 件' }],
      checkedAt: 0,
    });
    expect(warn.label).toContain('1 处');
    expect(warn.detail).toContain('件数不符');
    expect(describeSelfCheck({ status: 'error', summary: '请求失败', issues: [], checkedAt: 0, error: '超时' }).detail).toBe('超时');
  });
});

// 回归（用户 2026-09-23 截图）：自检把「结果图出现参考图没有的英文文字」判成缺陷，
// 而套图本来就要新写卖点文案 —— 判据必须改成「合规 + 保真」两条。
describe('出图自检判据：新增文案不是问题', () => {
  it('提示词里不再把「画面文字新增」列为缺陷类型', () => {
    expect(AGENT_SELF_CHECK_PROMPT).not.toContain('画面文字新增');
    expect(AGENT_SELF_CHECK_PROMPT).not.toContain('画面文字错误');
  });

  it('明确写出「新增卖点文案不是问题」，并保留合规与保真两类判据', () => {
    expect(AGENT_SELF_CHECK_PROMPT).toContain('新增卖点文案不是问题');
    expect(AGENT_SELF_CHECK_PROMPT).toContain('画面文字违规');
    expect(AGENT_SELF_CHECK_PROMPT).toContain('品牌文字被改');
    expect(AGENT_SELF_CHECK_PROMPT).toContain('件数不符');
  });

  it('要求只按传入的本类目违禁词表判违规（不许自己扩大解释）', () => {
    expect(AGENT_SELF_CHECK_PROMPT).toContain('只按下面给出的违禁词表判断');
    expect(AGENT_SELF_CHECK_PROMPT).toContain('违禁词表');
  });

  it('数量以「本单要求」为准，不拿参考图件数去卡（单件白底图 → 多 PCS 套装是正常需求）', () => {
    expect(AGENT_SELF_CHECK_PROMPT).toContain('本单要求');
    expect(AGENT_SELF_CHECK_PROMPT).toContain('不要拿参考图的件数去卡');
    // 件数不符只和本单要求比，不和参考图比
    expect(AGENT_SELF_CHECK_PROMPT).toContain('只和本单要求比');
    // 保留外观保真与合规两条主线
    expect(AGENT_SELF_CHECK_PROMPT).toContain('商品外观');
  });
});

describe('extractComplianceRules', () => {
  const identity = [
    '# 身份：测试类目',
    '',
    '## 二、铁律',
    '- 商品不得改动',
    '',
    '## 三、合规（违禁词与禁区）',
    '- military / tactical 一律不出现',
    '### 3.1 生图安全词规避',
    '- weapon, gun',
    '',
    '## 四、色板',
    '- 奶油粉',
  ].join('\n');

  it('抽出合规/禁词章节，并含其子章节', () => {
    const out = extractComplianceRules(identity);
    expect(out).toContain('三、合规');
    expect(out).toContain('military / tactical');
    expect(out).toContain('3.1 生图安全词规避');
    expect(out).toContain('weapon, gun');
  });

  it('不把别的章节带进来（铁律 / 色板）', () => {
    const out = extractComplianceRules(identity);
    expect(out).not.toContain('商品不得改动');
    expect(out).not.toContain('奶油粉');
  });

  it('identity 为空时返回空串（自检侧会退回通用红线）', () => {
    expect(extractComplianceRules('')).toBe('');
    expect(extractComplianceRules(undefined as unknown as string)).toBe('');
  });

  it('通用类目的「合一安全词库」也能抽到', () => {
    const general = '## 七、合一安全词库（唯一权威；禁变体 / 拆分 / 组合 / 中英近义）\n- foo bar\n\n## 八、别的\n- x';
    const out = extractComplianceRules(general);
    expect(out).toContain('合一安全词库');
    expect(out).toContain('foo bar');
    expect(out).not.toContain('别的');
  });
});
