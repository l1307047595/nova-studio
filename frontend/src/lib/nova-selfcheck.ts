'use client';

import type { AgentSelfCheck, AgentSelfCheckStatus } from '@/lib/agent-chat-config';

/** 自动自检开关：默认开；关掉后仍可用图片上的「自检」按钮手动补检。 */
const AUTO_SELF_CHECK_KEY = 'nova-selfcheck-auto';

export function isAutoSelfCheckEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(AUTO_SELF_CHECK_KEY);
    // 没设置过 = 默认开
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function setAutoSelfCheckEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTO_SELF_CHECK_KEY, enabled ? '1' : '0');
  } catch {
    /* 存不进去也不影响本次使用 */
  }
}

/**
 * 解析自检返回的 JSON。模型偶尔会包 ```json 或前后带解释，所以宽松取第一个 {...}。
 * 解析不出来不抛错：记成 unknown，让用户看到"没检成"而不是静默无结果。
 */
export function parseSelfCheckOutput(
  text: string,
  meta: { imageIds?: string[]; model?: string } = {},
): AgentSelfCheck {
  const checkedAt = Date.now();
  const raw = (text || '').trim();
  const base = { checkedAt, imageIds: meta.imageIds, model: meta.model, raw: raw.slice(0, 2000) };

  const stripped = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { status: 'unknown', summary: '自检没有返回可解析的结果', issues: [], ...base };
  }

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    const status: AgentSelfCheckStatus =
      parsed.status === 'pass' || parsed.status === 'warn' || parsed.status === 'unknown'
        ? parsed.status
        : 'unknown';
    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues as Array<Record<string, unknown>>)
        .filter(issue => issue && typeof issue === 'object')
        .map(issue => ({
          kind: String(issue.kind || '其他'),
          detail: String(issue.detail || ''),
        }))
        .filter(issue => issue.detail.length > 0 || issue.kind !== '其他')
      : [];
    const summary = String(
      parsed.summary || (status === 'pass' ? '与参考图一致' : status === 'warn' ? '发现问题' : '无法判断'),
    );
    return { status, summary, issues, ...base };
  } catch {
    return { status: 'unknown', summary: '自检结果解析失败', issues: [], ...base };
  }
}

export function describeSelfCheck(result?: AgentSelfCheck | null): {
  label: string;
  tone: 'pass' | 'warn' | 'unknown';
  detail: string;
} {
  if (!result) return { label: '未自检', tone: 'unknown', detail: '' };
  const issues = result.issues.map(issue => `${issue.kind}：${issue.detail}`).join('\n');
  if (result.status === 'pass') {
    return { label: '自检通过', tone: 'pass', detail: result.summary };
  }
  if (result.status === 'warn') {
    return { label: `自检发现 ${result.issues.length} 处问题`, tone: 'warn', detail: issues || result.summary };
  }
  if (result.status === 'error') {
    return { label: '自检失败', tone: 'unknown', detail: result.error || result.summary };
  }
  return { label: '自检无法判断', tone: 'unknown', detail: result.summary };
}
