import { describe, expect, it } from 'vitest';
import { buildSimpleProxyTextRequestBody } from '../nova-proxy-text';
import type { TextProviderProtocol } from '../nova-text-protocol';

/**
 * 出图自检要一次带 2~4 张图（参考图 + 结果图）。
 * 这里不锁死各协议的报文形状，只保证「每张图都真的进了请求体」——
 * 少一张图，自检就会拿不到参考图而误判。
 */
const IMAGES = [
  'data:image/png;base64,REF_ONE',
  'data:image/png;base64,REF_TWO',
  'data:image/png;base64,RESULT',
];

const PROTOCOLS: TextProviderProtocol[] = [
  // 'openai' 不是合法协议值（合法：openai-responses / openai-chat-completions / anthropic-messages / google-gemini）
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'google-gemini',
];

describe('buildSimpleProxyTextRequestBody（多图）', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}：三张图全部进入请求体`, () => {
      const parts = [
        { type: 'text' as const, text: '自检提示词' },
        ...IMAGES.map(url => ({ type: 'image' as const, imageDataUrl: url })),
      ];
      const body = buildSimpleProxyTextRequestBody(protocol, 'mock-model', parts, { reasoningEffort: 'low' });
      const serialized = JSON.stringify(body);
      for (const url of IMAGES) {
        const marker = url.split(',')[1];
        expect(serialized).toContain(marker);
      }
      expect(serialized).toContain('自检提示词');
      // Gemini 的模型名走 URL 路径（/models/<model>:generateContent），不在请求体里
      if (protocol !== 'google-gemini') {
        expect(serialized).toContain('mock-model');
      }
    });
  }

  it('图片顺序保持「参考图在前、结果图在后」', () => {
    const parts = [
      { type: 'text' as const, text: '自检提示词' },
      ...IMAGES.map(url => ({ type: 'image' as const, imageDataUrl: url })),
    ];
    const serialized = JSON.stringify(buildSimpleProxyTextRequestBody('openai-chat-completions', 'm', parts, {}));
    const first = serialized.indexOf('REF_ONE');
    const second = serialized.indexOf('REF_TWO');
    const last = serialized.indexOf('RESULT');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(second);
  });
});
