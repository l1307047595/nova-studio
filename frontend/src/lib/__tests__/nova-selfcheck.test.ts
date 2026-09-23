import { describe, expect, it } from 'vitest';
import { describeSelfCheck, parseSelfCheckOutput } from '../nova-selfcheck';

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

  it('凭空多出来的画面文字要能记进 issues', () => {
    const result = parseSelfCheckOutput(
      '{"status":"warn","summary":"多出角标","issues":[{"kind":"画面文字新增","detail":"参考图没有 2PCS SET，结果图写上了"}]}',
    );
    expect(result.status).toBe('warn');
    expect(result.issues[0].kind).toBe('画面文字新增');
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
