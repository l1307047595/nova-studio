import { describe, expect, it } from 'vitest';
import { DESCRIBE_MAX_SIDE, describeDownscaleTarget, downscaleDataUrlForDescribe } from '@/lib/image-downscale';

describe('describeDownscaleTarget', () => {
  it('按上传规格压缩后的商品图（2236×2236）缩到 1024', () => {
    expect(describeDownscaleTarget(2236, 2236)).toEqual({ width: 1024, height: 1024 });
  });

  it('横图按最长边等比缩，不拉伸', () => {
    expect(describeDownscaleTarget(4096, 2048)).toEqual({ width: 1024, height: 512 });
  });

  it('本来就不超过 1024 的图不缩（返回 null）', () => {
    expect(describeDownscaleTarget(1024, 768)).toBeNull();
    expect(describeDownscaleTarget(800, 800)).toBeNull();
  });

  it('尺寸异常（0 / NaN）不缩，避免算出 0 尺寸的画布', () => {
    expect(describeDownscaleTarget(0, 0)).toBeNull();
    expect(describeDownscaleTarget(Number.NaN, 100)).toBeNull();
  });

  it('上限可覆盖（换模型/换策略时不写死）', () => {
    expect(describeDownscaleTarget(2048, 2048, 512)).toEqual({ width: 512, height: 512 });
    expect(DESCRIBE_MAX_SIDE).toBe(1024);
  });
});

describe('downscaleDataUrlForDescribe', () => {
  it('缩图失败时回退原图：缩图只省时间，绝不能让描述因为缩图而失败', async () => {
    const original = 'data:image/png;base64,AAAA';
    // jsdom 里没有可用的 canvas/Image 解码 → 必须原样返回
    await expect(downscaleDataUrlForDescribe(original)).resolves.toBe(original);
  });

  it('空值原样返回，不抛异常', async () => {
    await expect(downscaleDataUrlForDescribe('')).resolves.toBe('');
  });
});
