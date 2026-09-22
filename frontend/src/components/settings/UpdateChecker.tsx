'use client';

// 设置 → 关于：主动检查更新
//
// 两种运行形态：
// - 桌面版（打包后的 exe）：后端与 Electron 主进程同进程，接口直接转发给 electron-updater，
//   能自动下载并重启安装；渲染进程若存在 preload 桥（window.novaDesktop.updater）则优先用它。
// - 浏览器访问（直接开 127.0.0.1:3111）：没有 Electron，后端退化成「拿 GitHub Release 比版本」，
//   只提示有没有新版，更新要手动下载安装包。
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const RELEASE_PAGE = 'https://github.com/l1307047595/nova-studio-release/releases';

interface UpdateInfo {
  mode?: 'electron' | 'browser';
  supported?: boolean;
  status?: string;
  currentVersion?: string;
  latestVersion?: string;
  progress?: number;
  message?: string;
  releaseUrl?: string;
  channel?: string;
  checkedAt?: string;
}

interface DesktopUpdaterBridge {
  getState: () => Promise<UpdateInfo>;
  check: () => Promise<UpdateInfo>;
  install: () => Promise<{ ok?: boolean; error?: string }>;
}

/** preload 注入的桥；浏览器里不存在 */
function desktopUpdater(): DesktopUpdaterBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { novaDesktop?: { updater?: DesktopUpdaterBridge } }).novaDesktop;
  return bridge && bridge.updater ? bridge.updater : null;
}

const CHANNEL_LABEL: Record<string, string> = {
  hk: 'HK（全量记忆）',
  l: 'L（通用记忆）',
  latest: '默认',
};

export function UpdateChecker() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const readState = useCallback(async (): Promise<UpdateInfo | null> => {
    const bridge = desktopUpdater();
    if (bridge) {
      try {
        return await bridge.getState();
      } catch {
        // 桥坏了就退回后端接口
      }
    }
    try {
      const res = await fetch('/api/nova/update', { cache: 'no-store' });
      return res.ok ? ((await res.json()) as UpdateInfo) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void readState().then(next => {
      if (alive && next) setInfo(next);
    });
    return () => {
      alive = false;
    };
  }, [readState]);

  // 检查中 / 下载中：轮询状态，让进度条动起来
  const liveStatus = info?.status;
  useEffect(() => {
    if (liveStatus !== 'checking' && liveStatus !== 'available' && liveStatus !== 'downloading') return;
    const timer = setInterval(() => {
      void readState().then(next => {
        if (next) setInfo(next);
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [liveStatus, readState]);

  const onCheck = async () => {
    setBusy(true);
    try {
      let next: UpdateInfo | null = null;
      const bridge = desktopUpdater();
      if (bridge) {
        try {
          next = await bridge.check();
        } catch {
          next = null;
        }
      }
      if (!next) {
        const res = await fetch('/api/nova/update/check', { method: 'POST' });
        next = res.ok
          ? ((await res.json()) as UpdateInfo)
          : { status: 'error', message: `检查失败：HTTP ${res.status}` };
      }
      setInfo(prev => ({ ...(prev || {}), ...(next as UpdateInfo) }));
    } catch (error) {
      setInfo(prev => ({
        ...(prev || {}),
        status: 'error',
        message: `检查失败：${error instanceof Error ? error.message : String(error)}`,
      }));
    } finally {
      setBusy(false);
    }
  };

  const onInstall = async () => {
    setBusy(true);
    try {
      const bridge = desktopUpdater();
      if (bridge) {
        await bridge.install();
      } else {
        await fetch('/api/nova/update/install', { method: 'POST' });
      }
    } catch {
      // 安装失败时状态会在下一轮轮询里体现
    } finally {
      setBusy(false);
    }
  };

  const status = info?.status || 'idle';
  const isDesktop = info?.mode === 'electron';
  const version = info?.currentVersion || process.env.NEXT_PUBLIC_APP_VERSION || '';
  const channel = info?.channel ? (CHANNEL_LABEL[info.channel] || info.channel) : '';
  const releaseUrl = info?.releaseUrl || RELEASE_PAGE;

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="font-medium">软件更新</div>
          <div className="text-xs text-muted-foreground">
            当前版本 {version ? `v${version}` : '未知'}
            {channel ? ` · 通道 ${channel}` : ''}
            {' · '}
            {isDesktop ? '桌面版，可自动下载安装' : '浏览器访问，更新需手动下载'}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onCheck} disabled={busy} className="shrink-0">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="ml-1.5">检查更新</span>
        </Button>
      </div>

      {status !== 'idle' && info?.message && (
        <div className="flex items-center gap-1.5 text-xs">
          {status === 'error' ? (
            <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          ) : status === 'downloaded' || status === 'not-available' ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
          ) : (
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          )}
          <span className={status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{info.message}</span>
          {info.latestVersion && status === 'available' && (
            <Badge variant="secondary" className="ml-1">v{info.latestVersion}</Badge>
          )}
        </div>
      )}

      {status === 'downloading' && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${Math.max(0, Math.min(100, info?.progress || 0))}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {status === 'downloaded' && isDesktop && (
          <Button size="sm" onClick={onInstall} disabled={busy}>立即重启更新</Button>
        )}
        {status !== 'idle' && status !== 'checking' && (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            打开发布页 <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {status === 'available' && !isDesktop && (
        <p className="text-xs text-muted-foreground">
          浏览器访问模式不能自动安装：请到发布页下载新安装包覆盖安装（或装桌面版，之后就能一键更新）。
        </p>
      )}
      {status === 'error' && (
        <p className="text-xs text-muted-foreground">
          常见原因：网络到不了 GitHub（检查更新走 api.github.com）。可以先手动打开上面的发布页看看。
        </p>
      )}
    </div>
  );
}
