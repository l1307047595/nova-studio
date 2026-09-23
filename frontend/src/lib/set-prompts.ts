/**
 * 套图模式：把「一句话要一套图」拆成 N 条「各画一张」的提示词。
 *
 * 为什么必须改写（实测结论，2026-09-23）：
 *   绘图模型看到提示词里的「套图 / 5张 / 连续生成」会把多个画面**排进同一张画布**
 *   （拼图/宫格海报）。而后端表达张数的方式是 N 次并发请求 ——
 *   backend/server.js 的 runTaskBody() 用 Promise.allSettled 按 parallelCount 发 N 次，
 *   每次都是**同一段 prompt**，且请求体里没有 n 参数（图生图甚至写死 n=1）。
 *   所以张数只能由「请求次数」表达，prompt 里只能描述「这一张」。
 *
 * 这里三件事全在本地做（不调文本模型、不读记忆、无固定图型清单）：
 *   1. 剥掉引发拼图的措辞（拼接/拼图/宫格/分屏/联图/连续生成…）
 *   2. 「套图」→「一张完整的电商图」，「生成 N 张」→「生成一张」
 *   3. 逐张追加「单画面锁」：这是共 N 张里的第 i 张，只画这一张、禁止拼接
 */

/** 引发「拼成一张」的措辞。命中即删（连同它周围的连接词由空白归一化收拾）。 */
const COLLAGE_WORDS =
  /拼接(?:成一[张幅])?|拼成一[张幅]|拼图|拼贴|拼合|拼版|多格|宫格构图|三宫格|九宫格|宫格|三联图|分屏展示|分屏|联图|并排(?:展示|排列|摆放)?|长图|photogrid|triptych|\bcollage\b/gi;

/** 同样会让模型「把过程画进一张图」的批量措辞。 */
const BATCH_PHRASES = /连续生成|连续出图|依次生成|一张接一张|批量生成|批量出图/g;

/** 数字词：阿拉伯数字 2-9x 与中文数字。 */
const COUNT_WORDS = '(?:[2-9]|[1-9]\\d+|两|三|四|五|六|七|八|九|十)';

/** 单画面锁的抬头，便于你在任务记录里一眼认出这是套图模式改写过的提示词。 */
export const SET_LOCK_PREFIX = '【本张要求】';

/**
 * 剥掉「要一套/多张」的措辞，把提示词收敛成「这一张」的画面描述。
 * 与 Agent 路径的 stripAgentPromptBatchLanguage 同源，但工作台这条路径
 * 还多出「套图」「连续生成」这类口语措辞要处理。
 */
export function stripSetBatchLanguage(prompt: string): string {
  let text = String(prompt || '');

  text = text.replace(COLLAGE_WORDS, ' ');
  text = text.replace(BATCH_PHRASES, ' ');

  // 「套图」是拼图的最强触发词：先在常见搭配里换成单图说法，再兜底处理。
  text = text.replace(/电商套图|产品套图|商品套图|一整套图|整套图/g, '电商图');
  text = text.replace(/套图/g, '一张完整的电商图');

  text = text.replace(new RegExp(`(生成|做|出|制作|拍摄|画|要)\\s*${COUNT_WORDS}\\s*张`, 'g'), '$1一张');
  text = text.replace(new RegExp(`${COUNT_WORDS}\\s*张(?:彼此)?独立(?:完整)?的?`, 'g'), '一张独立完整的');
  text = text.replace(new RegExp(`一组\\s*${COUNT_WORDS}\\s*张`, 'g'), '一张');
  text = text.replace(new RegExp(`${COUNT_WORDS}\\s*张`, 'g'), '一张');

  // 空白与标点归一化：剥词后常留下连续标点/多余空格。
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/[，,、]{2,}/g, '，');
  text = text.replace(/\s+([，,。；;])/g, '$1');
  text = text.replace(/^[，,、。\s]+/, '').replace(/[，,、\s]+$/, '');
  return text.trim();
}

export interface BuildSetPromptsOptions {
  /** 本次是否带参考图。带图时补一句「以参考图为唯一基准」，与铁律一致。 */
  hasReferenceImages?: boolean;
}

/**
 * 生成 N 条提示词：每条 = 商品基准（可选）+ 用户描述 + 单画面锁（第 i 张 / 共 N 张）。
 * N 条交给提交逻辑各发一个任务，张数即 N，画面各不拼接。
 */
export function buildSetPrompts(prompt: string, count: number, options: BuildSetPromptsOptions = {}): string[] {
  const total = Math.max(1, Math.min(8, Math.floor(Number(count) || 1)));
  const base = stripSetBatchLanguage(prompt);
  const referenceBasis = options.hasReferenceImages
    ? '以参考图中的商品为唯一基准：严格保持商品的造型、比例、颜色、材质、包装、Logo 与文字完全不变，不重新设计商品、不新增原图没有的部件。'
    : '';

  return Array.from({ length: total }, (_, index) => {
    const position = total > 1
      ? `这是同一套电商图共 ${total} 张里的第 ${index + 1} 张：只画这一张的画面，画面里只呈现一个完整场景；`
      : '画面里只呈现一个完整场景；';
    const lock =
      `${SET_LOCK_PREFIX}${position}` +
      '禁止拼接、禁止多格、禁止分屏、禁止联图、禁止并排展示多张画面；画面中不得出现任何分隔线、边框或面板边界。';
    return [referenceBasis, base, lock].filter(Boolean).join('\n\n');
  });
}

/** 套图模式下的界面提示文案（工作台与画布共用，避免两处各写一句）。 */
export function describeSetMode(count: number): string {
  return `套图模式：将按「生成数量」出 ${count} 张独立成图，逐张只画一个完整画面（不拼接）`;
}
