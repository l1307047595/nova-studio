import { describe, expect, it } from 'vitest';
import { AGENT_IMAGE_DESCRIBE_PROMPT } from '@/lib/agent-chat-config';

// 回归（用户 2026-10）：商品图上明明印着「PHEROMONE BODY BUTTER FOR MEN」，
// 识图却给不出品类、只写「需你确认」。根因：Agent 是纯文本的，只能看「图片描述」，
// 而旧描述提示词既没有「品类」字段、又只让写包装文字的位置/样式、不让抄原文。
describe('识图描述提示词（Agent 唯一能看到的图片信息）', () => {
  it('必须产出「品类」字段，并优先以包装文字为准', () => {
    expect(AGENT_IMAGE_DESCRIBE_PROMPT).toContain('品类=');
    expect(AGENT_IMAGE_DESCRIBE_PROMPT).toContain('以文字为准');
  });

  it('必须把图上可辨认的文字原文抄下来，否则模型认不出是什么商品', () => {
    expect(AGENT_IMAGE_DESCRIBE_PROMPT).toContain('文字原文');
    expect(AGENT_IMAGE_DESCRIBE_PROMPT).toContain('包装与印刷');
  });
});
