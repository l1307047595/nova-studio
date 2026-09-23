import { describe, expect, it } from 'vitest';
import { MAX_CARRIED_IMAGES, selectCarryOverImages } from '@/lib/agent-material-carryover';
import type { AgentImageRecord } from '@/lib/agent-chat-config';

function img(imgId: string, source: AgentImageRecord['source'], createdAt: number): AgentImageRecord {
  return {
    imgId,
    source,
    thumbnail: 'data:image/png;base64,x',
    description: '商品图',
    mimeType: 'image/png',
    createdAt,
  };
}

// 背景（用户 2026-09-23）：「一开新对话就说我没有参考图」——新会话目录为空，
// 铁律下每个提案都被拦下。新建会话时要把上一个会话的商品素材图带过去。
describe('selectCarryOverImages', () => {
  it('只带素材（上传 / 素材库），不带生成图', () => {
    const images = [
      img('img_1', 'uploaded', 1),
      img('img_2', 'generated', 2),
      img('img_3', 'asset', 3),
    ];
    expect(selectCarryOverImages(images).map(i => i.imgId)).toEqual(['img_1', 'img_3']);
  });

  it('取最近 limit 张（按时间正序返回，便于沿用 img_N 顺序）', () => {
    const images = Array.from({ length: 12 }, (_, i) => img(`img_${i + 1}`, 'uploaded', i + 1));
    const picked = selectCarryOverImages(images, 3);
    expect(picked.map(i => i.imgId)).toEqual(['img_10', 'img_11', 'img_12']);
  });

  it('默认上限是 8 张（目录太长会白烧上下文）', () => {
    const images = Array.from({ length: 20 }, (_, i) => img(`img_${i + 1}`, 'uploaded', i + 1));
    expect(selectCarryOverImages(images)).toHaveLength(MAX_CARRIED_IMAGES);
  });

  it('limit 为 0 / 负数 / 空目录都不炸', () => {
    const images = [img('img_1', 'uploaded', 1)];
    expect(selectCarryOverImages(images, 0)).toEqual([]);
    expect(selectCarryOverImages([], 5)).toEqual([]);
  });

  it('不打乱原数组（返回新数组）', () => {
    const images = [img('img_2', 'uploaded', 2), img('img_1', 'uploaded', 1)];
    const before = images.map(i => i.imgId);
    selectCarryOverImages(images, 2);
    expect(images.map(i => i.imgId)).toEqual(before);
  });
});
