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

// 回归（用户 2026-10 截图）：模型明明说了「我用 img_6 做主图参考」，提案卡却「已选 0」，
// 缩略图一张都不显示，逼用户手动上传。两条把参考图过滤空的路径都要堵住。
describe('作用域过滤不得把参考图清空', () => {
  function uploadedImage(imgId: string): AgentImageRecord {
    return {
      imgId,
      source: 'uploaded',
      thumbnail: `data:image/png;base64,${imgId}`,
      description: '用户上传的商品图',
      mimeType: 'image/png',
      createdAt: 1,
    };
  }

  it('模型把商品名/自由文本填进 product_key（目录里无此键）→ 弃用该键，参考图保留', () => {
    const scoped = scopeAgentProposal(
      proposal({ productKey: '男性身体乳', referencedImageIds: ['img_6'] }),
      [uploadedImage('img_6')],
    );
    expect(scoped.productKey).toBeUndefined();
    expect(scoped.referencedImageIds).toEqual(['img_6']);
  });

  it('过滤结果为空时，退回「目录里真实存在的被引用图」而不是清空', () => {
    const images = [
      image('img_a', 'taobao:1'),
      image('img_b', 'taobao:2'),
    ];
    // 提案键指向商品 2，却引用了商品 1 的图 → 正常过滤会得到空；必须退回被引用的 img_a
    const scoped = scopeAgentProposal(
      proposal({ productKey: 'taobao:2', referencedImageIds: ['img_a'] }),
      images,
    );
    expect(scoped.referencedImageIds).toEqual(['img_a']);
  });
});

// 回归（用户 2026-09-23 截图）：老会话里明明有 8 张图，提案却报「没有参考图」→ 铁律拦下 →
// 用户看到「生成失败」。根因是作用域过滤把参考图全过滤空了（目录里的图都带 productKey，
// 提案没带商品标识 → 走到「只留没有 productKey 的图」这条分支）。
