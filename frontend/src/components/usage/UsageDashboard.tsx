'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, BarChart3, Coins, Image as ImageIcon, Loader2, RefreshCw, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Bucket = {
  images: number;
  costCny: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  events: number;
  imageEvents: number;
  textEvents: number;
};

type DayBucket = Bucket & { day: string };
type ModelBucket = Bucket & { kind: string; model: string };
type AgentBucket = Bucket & { agentId: string };
type KindBucket = Bucket & { kind: string };

type Summary = {
  generatedAt: string;
  days: number;
  isPeakNow: boolean;
  priceTable: {
    imageUnitCny: number;
    textCnyPerMillion: { offpeak: { cacheHit: number; cacheMiss: number; output: number }; peak: { cacheHit: number; cacheMiss: number; output: number } };
    peakWindows: string[];
  };
  totals: Bucket;
  byDay: DayBucket[];
  byModel: ModelBucket[];
  byAgent: AgentBucket[];
  byKind: KindBucket[];
};

const RANGE_OPTIONS = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
];

function formatCny(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0.00';
  if (value < 0.01) return `¥${value.toFixed(4)}`;
  if (value < 1) return `¥${value.toFixed(3)}`;
  return `¥${value.toFixed(2)}`;
}

function formatInt(value: number): string {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

const PANEL_CLASS = 'rounded-2xl border border-border bg-card p-4 shadow-sm';

function StatCard({ icon: Icon, label, value, hint }: { icon: typeof Coins; label: string; value: string; hint?: string }) {
  return (
    <div className={cn(PANEL_CLASS, 'flex items-start gap-3')}>
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-0.5 truncate text-lg font-semibold tabular-nums">{value}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}

export function UsageDashboard({ wideMode = false, active = true }: { wideMode?: boolean; active?: boolean }) {
  const [days, setDays] = useState('7');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/nova/usage/summary?days=${encodeURIComponent(days)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
      setSummary(data as Summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [days]);

  // 切到本 Tab 才拉数据，避免常驻后台请求（各 Tab 都是 keepMounted）
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const cacheHitRate = useMemo(() => {
    if (!summary || summary.totals.promptTokens <= 0) return 0;
    return summary.totals.cachedTokens / summary.totals.promptTokens;
  }, [summary]);

  const maxDayCost = useMemo(() => {
    if (!summary) return 0;
    return summary.byDay.reduce((max, day) => Math.max(max, day.costCny), 0);
  }, [summary]);

  const imageBucket = summary?.byKind.find(kind => kind.kind === 'image');
  const textBucket = summary?.byKind.find(kind => kind.kind === 'text');

  return (
    <div className={cn('space-y-4', wideMode && 'xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="size-5 text-primary" />
          <h2 className="text-base font-semibold">用量与成本</h2>
          {summary?.isPeakNow ? (
            <Badge variant="destructive" className="gap-1">
              <Zap className="size-3" />高峰时段计价中
            </Badge>
          ) : (
            <Badge variant="secondary">空闲时段计价</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border p-0.5">
            {RANGE_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDays(option.value)}
                className={cn(
                  'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
                  days === option.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <div className={cn(PANEL_CLASS, 'flex items-center gap-2 text-sm text-destructive')}>
          <AlertCircle className="size-4 shrink-0" />
          <span>读取用量失败：{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Coins}
          label={`总花费（近 ${days} 天）`}
          value={formatCny(summary?.totals.costCny ?? 0)}
          hint={`共 ${formatInt(summary?.totals.events ?? 0)} 次调用`}
        />
        <StatCard
          icon={ImageIcon}
          label="生图"
          value={`${formatInt(summary?.totals.images ?? 0)} 张`}
          hint={`${formatCny(imageBucket?.costCny ?? 0)} · ${formatCny(summary?.priceTable.imageUnitCny ?? 0.015)}/张`}
        />
        <StatCard
          icon={BarChart3}
          label="对话 / 视觉"
          value={formatInt((summary?.totals.promptTokens ?? 0) + (summary?.totals.completionTokens ?? 0))}
          hint={`${formatCny(textBucket?.costCny ?? 0)} · 命中率 ${(cacheHitRate * 100).toFixed(0)}%`}
        />
        <StatCard
          icon={Zap}
          label="缓存命中 token"
          value={formatInt(summary?.totals.cachedTokens ?? 0)}
          hint={`未命中 ${formatInt(Math.max(0, (summary?.totals.promptTokens ?? 0) - (summary?.totals.cachedTokens ?? 0)))} · 输出 ${formatInt(summary?.totals.completionTokens ?? 0)}`}
        />
      </div>

      <div className={PANEL_CLASS}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">每天花费</h3>
          <span className="text-xs text-muted-foreground">柱高按花费，鼠标悬停看明细</span>
        </div>
        {summary && summary.byDay.length > 0 ? (
          <div className="flex h-40 items-end gap-1">
            {summary.byDay.map(day => {
              const ratio = maxDayCost > 0 ? day.costCny / maxDayCost : 0;
              const height = day.costCny > 0 ? Math.max(4, Math.round(ratio * 100)) : 0;
              return (
                <div key={day.day} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <div
                    title={`${day.day}\n花费 ${formatCny(day.costCny)}\n生图 ${day.images} 张\n对话 ${day.textEvents} 次`}
                    className={cn(
                      'w-full rounded-t-md transition-colors',
                      day.costCny > 0 ? 'bg-primary/70 group-hover:bg-primary' : 'bg-muted',
                    )}
                    style={{ height: `${height}%`, minHeight: day.costCny > 0 ? 4 : 2 }}
                  />
                  <span className="hidden text-[10px] text-muted-foreground sm:block">
                    {day.day.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {loading ? '读取中…' : '这段时间还没有调用记录'}
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={PANEL_CLASS}>
          <h3 className="mb-3 text-sm font-medium">按模型</h3>
          {summary && summary.byModel.length > 0 ? (
            <div className="space-y-1.5">
              {summary.byModel.map(row => (
                <div key={`${row.kind}:${row.model}`} className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant={row.kind === 'image' ? 'default' : 'secondary'} className="shrink-0">
                      {row.kind === 'image' ? '生图' : '文本'}
                    </Badge>
                    <span className="truncate font-mono">{row.model}</span>
                  </div>
                  <div className="shrink-0 tabular-nums text-muted-foreground">
                    {row.kind === 'image'
                      ? `${formatInt(row.images)} 张`
                      : `${formatInt(row.promptTokens + row.completionTokens)} tok`}
                    <span className="ml-2 font-medium text-foreground">{formatCny(row.costCny)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-4 text-center text-xs text-muted-foreground">暂无记录</div>
          )}
        </div>

        <div className={PANEL_CLASS}>
          <h3 className="mb-3 text-sm font-medium">按工作类目</h3>
          {summary && summary.byAgent.length > 0 ? (
            <div className="space-y-1.5">
              {summary.byAgent.map(row => (
                <div key={row.agentId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono">{row.agentId}</span>
                  <div className="shrink-0 tabular-nums text-muted-foreground">
                    {row.images > 0 ? `${formatInt(row.images)} 张 · ` : ''}
                    {formatInt(row.promptTokens + row.completionTokens)} tok
                    <span className="ml-2 font-medium text-foreground">{formatCny(row.costCny)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-4 text-center text-xs text-muted-foreground">暂无记录</div>
          )}
        </div>
      </div>

      {summary ? (
        <div className="rounded-2xl border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
          <div>生图：{formatCny(summary.priceTable.imageUnitCny)} / 张（按成功出图张数计，失败的不计）</div>
          <div>
            文本（元/百万 token）：空闲 命中 {summary.priceTable.textCnyPerMillion.offpeak.cacheHit} / 未命中 {summary.priceTable.textCnyPerMillion.offpeak.cacheMiss} / 输出 {summary.priceTable.textCnyPerMillion.offpeak.output}
            ；高峰 命中 {summary.priceTable.textCnyPerMillion.peak.cacheHit} / 未命中 {summary.priceTable.textCnyPerMillion.peak.cacheMiss} / 输出 {summary.priceTable.textCnyPerMillion.peak.output}
          </div>
          <div>高峰时段：{summary.priceTable.peakWindows.join('、')}（北京时间）</div>
          <div>统计更新于 {new Date(summary.generatedAt).toLocaleString('zh-CN')}；单价可用环境变量 NOVA_IMAGE_UNIT_PRICE_CNY / NOVA_TEXT_PRICE_* 覆盖</div>
        </div>
      ) : null}
    </div>
  );
}
