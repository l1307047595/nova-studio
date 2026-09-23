import { describe, expect, it } from 'vitest';
import { normalizeProductKey, scopeAgentProposal } from '@/lib/agent-chat-config';
import type { AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';

function image(imgId: string, productKey: string): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description: '商品图',
    mimeType: 'image/png',
    productKey,
    createdAt: 1,
  };
}

function proposal(overrides: Partial<AgentProposal>): AgentProposal {
  return {
    action: 'generate',
    prompt: '商品宣传图',
    referencedImageIds: [],
    reason: '',
    ...overrides,
  };
}

describe('normalizeProductKey', () => {
  it('淘宝商品链接归一到 item id，忽略 mi_id/spm 等追踪参数', () => {
    expect(normalizeProductKey('https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x&xxc=shop'))
      .toBe('taobao:893737826198');
    expect(normalizeProductKey('https://item.taobao.com/item.htm?id=893737826198'))
      .toBe('taobao:893737826198');
  });

  it('非商品页链接归一到 origin+pathname，忽略查询串', () => {
    expect(normalizeProductKey('https://example.com/a/b?x=1&y=2')).toBe('https://example.com/a/b');
  });

  it('空值返回 undefined', () => {
    expect(normalizeProductKey('')).toBeUndefined();
    expect(normalizeProductKey(undefined)).toBeUndefined();
  });

  it('已归一的 taobao: 短键幂等，不会二次变形', () => {
    expect(normalizeProductKey('taobao:893737826198')).toBe('taobao:893737826198');
  });
});

describe('scopeAgentProposal 商品键归一化', () => {
  it('提案写短链接、图片记录带完整追踪参数时仍能匹配到同一商品', () => {
    const images = [
      image('img_11', 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x'),
      image('img_12', 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x'),
      image('img_1', 'https://item.taobao.com/item.htm?id=910655306721&mi_id=zzz'),
    ];
    const p = proposal({
      productKey: 'https://item.taobao.com/item.htm?id=893737826198',
      referencedImageIds: ['img_11', 'img_1'],
    });

    const scoped = scopeAgentProposal(p, images);

    expect(scoped.productKey).toBe('taobao:893737826198');
    expect(scoped.referencedImageIds).toEqual(['img_11']);
  });

  it('图片记录存的是 taobao: 短键、提案带完整链接时仍能匹配', () => {
    const images = [
      image('img_11', 'taobao:893737826198'),
      image('img_12', 'taobao:893737826198'),
      image('img_1', 'taobao:910655306721'),
    ];
    const p = proposal({
      productKey: 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc',
      referencedImageIds: ['img_11', 'img_1'],
    });

    const scoped = scopeAgentProposal(p, images);

    expect(scoped.productKey).toBe('taobao:893737826198');
    expect(scoped.referencedImageIds).toEqual(['img_11']);
  });
});

// 回归（用户 2026-09-23 截图）：老会话里明明有 8 张图，提案却报「没有参考图」→ 铁律拦下 →
// 用户看到「生成失败」。根因是作用域过滤把参考图全过滤空了（目录里的图都带 productKey，
// 提案没带商品标识 → 走到「只留没有 productKey 的图」这条分支）。
describe('scopeAgentProposal 兜底：过滤绝不能把提案变成「没有参考图」', () => {
  it('目录里有多个带 productKey 的商品、提案没有商品标识 → 仍保留模型引用的图', () => {
    const images = [image('img_1', 'taobao:111'), image('img_2', 'taobao:222')];
    const p = proposal({ referencedImageIds: ['img_1'] });

    expect(scopeAgentProposal(p, images).referencedImageIds).toEqual(['img_1']);
  });

  it('单商品目录同理（图片带 key、提案不带）也不该被清空', () => {
    const images = [image('img_1', 'taobao:111')];
    const p = proposal({ referencedImageIds: ['img_1'] });

    expect(scopeAgentProposal(p, images).referencedImageIds).toEqual(['img_1']);
  });

  it('兜底不是无脑放行：引用了目录里不存在的 id 仍然清空', () => {
    const images = [image('img_1', 'taobao:111'), image('img_2', 'taobao:222')];
    const p = proposal({ referencedImageIds: ['img_99'] });

    expect(scopeAgentProposal(p, images).referencedImageIds).toEqual([]);
  });

  it('作用域能正常判定时行为不变（只留该商品的图）', () => {
    const images = [image('img_1', 'taobao:111'), image('img_2', 'taobao:222')];
    const p = proposal({ productKey: 'taobao:111', referencedImageIds: ['img_1', 'img_2'] });

    expect(scopeAgentProposal(p, images).referencedImageIds).toEqual(['img_1']);
  });
});
