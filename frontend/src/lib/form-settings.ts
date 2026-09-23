/**
 * 文本生图 / 图生图 共享的表单设置类型
 * 两个表单（TextToImageForm、ImageToImageForm）的设置字段完全一致，
 * 统一定义于此避免重复。
 */

import type { ModelId } from '@/lib/gemini-config';
import type { OutputSize, AspectRatio } from '@/lib/job-store';
import type { GptImageBackground, GptImageQuality, GptImageStyle, ParallelCount } from '@/lib/model-capabilities';

export interface ImageFormSettings {
  model: ModelId;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  parallelCount: ParallelCount;
  /**
   * 套图模式开关（工作台）：开启时「生成数量」= 出几张独立图，提交前把一条提示词
   * 拆成 N 条「各画一张」，避免绘图模型把多个画面拼进同一张画布。
   */
  setMode?: boolean;
}
