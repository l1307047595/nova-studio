import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentProposalCard } from '../AgentProposalCard';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import { saveRegistry } from '@/lib/nova-models';
import type { AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';

const MODEL_ID = 'gemini-3-pro-image-preview';

function image(imgId: string, productKey: string): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description: `${productKey} 图片`,
    mimeType: 'image/png',
    productKey,
    createdAt: Number(imgId.replace(/\D/g, '')) || 1,
  };
}

/** 对话里直接上传的图：没有 productKey，也不属于任何抓取到的商品 */
function uploadedImage(imgId: string, createdAt = 100): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description: '对话上传的参考图',
    mimeType: 'image/png',
    createdAt,
  };
}

/** 生成出来的图：source=generated，不该被自动拉进参考图 */
function generatedImage(imgId: string, createdAt = 100): AgentImageRecord {
  return { ...uploadedImage(imgId, createdAt), source: 'generated' };
}

function proposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    action: 'generate',
    prompt: '横版商品宣传图',
    referencedImageIds: ['img-a1'],
    reason: '测试提案',
    productKey: 'product-a',
    requestedAspectRatio: '9:16',
    ...overrides,
  };
}

function renderCard(overrides: Partial<ComponentProps<typeof AgentProposalCard>> = {}) {
  const onApprove = vi.fn();
  const props: ComponentProps<typeof AgentProposalCard> = {
    proposal: proposal(),
    images: [image('img-a1', 'product-a'), image('img-b1', 'product-b')],
    imageModel: MODEL_ID,
    onModelChange: vi.fn(),
    onApprove,
    onCancel: vi.fn(),
    ...overrides,
  };
  return { onApprove, ...render(<AgentProposalCard {...props} />) };
}

beforeEach(() => {
  saveRegistry({
    imageModels: [{
      id: MODEL_ID,
      protocol: 'google',
      name: 'Banana Pro',
      modelId: MODEL_ID,
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      builtinPreset: MODEL_ID,
      maxRefImages: 14,
      maxOutputSize: '4K',
      supportsAdvancedParams: false,
    }],
    textModels: [],
    defaults: {
      textToImage: MODEL_ID,
      imageToImage: MODEL_ID,
      reversePrompt: '',
      agent: '',
      promptOptimize: '',
      imageDescribe: '',
      sliceDecomposition: '',
      sliceReconstruct: '',
      sliceImageEdit: '',
    },
  });
  syncDynamicModelExports();
});

describe('AgentProposalCard', () => {
  it('生成提案自动勾选所属商品的全部图片，并隐藏其他商品图片', () => {
    renderCard({
      images: [
        image('img-a1', 'product-a'),
        image('img-a2', 'product-a'),
        image('img-b1', 'product-b'),
      ],
    });

    expect(screen.getByText('参考图生成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许并生成' })).toBeInTheDocument();
    expect(screen.queryByText('编辑图片')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许并改图' })).not.toBeInTheDocument();
    expect(screen.getByText('已选 2 / 上限 14')).toBeInTheDocument();
    expect(screen.getByAltText('img-a1')).toBeInTheDocument();
    expect(screen.getByAltText('img-a2')).toBeInTheDocument();
    expect(screen.queryByAltText('img-b1')).not.toBeInTheDocument();
  });

  it('确认时提示词保持模型原文，比例只走 params', () => {
    const { onApprove } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '允许并生成' }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    const [prompt, , , params] = onApprove.mock.calls[0];
    expect(prompt).not.toContain('画面比例');
    expect(params.aspectRatio).toBe('9:16');
  });

  it('允许并生成按钮带 data-agent-approve，方便滚动对齐', () => {
    renderCard();
    expect(screen.getByRole('button', { name: '允许并生成' })).toHaveAttribute('data-agent-approve');
  });

  it('失败后显示可重试文案，不再写等待确认', () => {
    renderCard({ failed: true });

    expect(screen.getByText('生成失败，可修改后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试生成' })).toBeInTheDocument();
    expect(screen.queryByText('等待你确认')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许并生成' })).not.toBeInTheDocument();
    });

    it('无商品归属的提案（对话里直接传的图）默认就要勾上 —— 否则会撞上「没有参考图不出图」的闸门', () => {
    renderCard({
      proposal: proposal({ productKey: undefined, referencedImageIds: [] }),
      images: [uploadedImage('img-u1', 1), uploadedImage('img-u2', 2)],
    });

    expect(screen.getByText('已选 2 / 上限 14')).toBeInTheDocument();
    });

    it('无商品归属的提案：模型点名的图排在前面，其余本会话上传图补足', () => {
    const { onApprove } = renderCard({
      proposal: proposal({ productKey: undefined, referencedImageIds: ['img-u2'] }),
      images: [uploadedImage('img-u1', 1), uploadedImage('img-u2', 2)],
    });

    fireEvent.click(screen.getByRole('button', { name: '允许并生成' }));
    expect(onApprove.mock.calls[0][1]).toEqual(['img-u2', 'img-u1']);
    });

    it('生成出来的图不会被自动拉进参考图；一张都没选时给出铁律提示', () => {
    renderCard({
      proposal: proposal({ productKey: undefined, referencedImageIds: [] }),
      images: [generatedImage('img-g1')],
    });

    expect(screen.getByText('已选 0 / 上限 14')).toBeInTheDocument();
    expect(screen.getByText(/还没有参考图/)).toBeInTheDocument();
    });

    it('确认步能就地补传参考图，上传后自动勾选并可直接用它生成', async () => {
    const onUploadReferences = vi.fn().mockResolvedValue(['img-new1']);
    const { container, onApprove } = renderCard({
      proposal: proposal({ productKey: undefined, referencedImageIds: [] }),
      images: [],
      onUploadReferences,
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['x'], 'ref.png', { type: 'image/png' })] } });

    await waitFor(() => expect(onUploadReferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('已选 1 / 上限 14')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '允许并生成' }));
    expect(onApprove.mock.calls[0][1]).toEqual(['img-new1']);
    });

    it('上传参考图后缩略图必须出现在卡片里 —— 即使它不在该商品的参考图作用域内', async () => {
    // 用户实测场景：卡片「已选」计数变成 1，但缩略图一张都不渲染，
    // 用户无法判断上传是否成功。根因：缩略图列表完全由商品作用域过滤决定，
    // 刚补传的图没有商品归属 → 被滤掉。
    const onUploadReferences = vi.fn().mockResolvedValue(['img-new1']);
    const { container } = renderCard({
      proposal: proposal({ productKey: 'product-a', referencedImageIds: ['img-a1'] }),
      images: [
        image('img-a1', 'product-a'),
        image('img-b1', 'product-b'),
        uploadedImage('img-new1', 999),
      ],
      onUploadReferences,
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'ref.png', { type: 'image/png' })] } });

    // ① 看得见的成功反馈
    await waitFor(() => expect(screen.getByText(/已上传 1 张：img-new1/)).toBeInTheDocument());
    // ② 缩略图真的渲染出来
    expect(container.querySelector('img[alt="img-new1"]')).toBeTruthy();
    // ③ 别的商品的图仍然不显示：跨商品混用参考图是审核事故来源，这条约束不能松
    expect(container.querySelector('img[alt="img-b1"]')).toBeNull();
    });
    });
