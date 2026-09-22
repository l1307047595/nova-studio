// Nova Image Studio 桌面壳（Electron 主进程）
// 内嵌 backend/server.js：该文件被 require 即自启动并读取 env，
// 因此所有环境变量必须在 require 之前设置完毕。
const { app, BrowserWindow, Menu, dialog, ipcMain, net: electronNet } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BACKEND_ENTRY = path.join(__dirname, '..', 'backend', 'server.js');
const BACKEND_READY_TIMEOUT_MS = 30 * 1000;
const BACKEND_READY_POLL_MS = 300;

let mainWindow = null;

// 数据必须落在「你双击的那个 exe 旁边」，不能落在 portable 每次解压的临时目录。
// electron-builder portable 会把 exe 解到 %TEMP%\... 再启动，app.getPath('exe')
// 指向临时副本；真正的 C:\nova 在 PORTABLE_EXECUTABLE_DIR。
function resolveUserDataDir() {
  if (process.env.NOVA_DATA_DIR) return process.env.NOVA_DATA_DIR;
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableRoot) return path.join(portableRoot, 'data');
  if (app.isPackaged && process.platform === 'win32') {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return null;
}

const resolvedUserDataDir = resolveUserDataDir();
if (resolvedUserDataDir) {
  app.setPath('userData', resolvedUserDataDir);
}

// 桌面壳自己的 DevTools 端口默认关闭。仅在显式设置
// NOVA_ELECTRON_CDP_ENABLED=true 时开启，并强制只监听本机回环地址。
// 与用户浏览器调试口（9222/9224）分开，避免抢端口。
const ELECTRON_CDP_ENABLED = String(process.env.NOVA_ELECTRON_CDP_ENABLED ?? 'false').toLowerCase() === 'true';
if (ELECTRON_CDP_ENABLED) {
  const ELECTRON_CDP_PORT = parseInt(process.env.NOVA_ELECTRON_CDP_PORT || '9333', 10);
  if (Number.isInteger(ELECTRON_CDP_PORT) && ELECTRON_CDP_PORT > 0) {
    app.commandLine.appendSwitch('remote-debugging-port', String(ELECTRON_CDP_PORT));
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
}

// 内嵌后端出网策略：直连优先，失败才回落系统代理。
// 背景：Clash/VPN 用户的环境里，两类站点并存——
//   · superxihe.com 直连被 Cloudflare 拦（返回 HTML 拦截页），必须走代理；
//   · 部分上游网关走代理会被 forbid，必须直连。
// 因此不能全局直连（原 Node fetch 行为），也不能全局代理。
// 判定规则：直连抛网络错误，或返回 4xx/5xx 且 Content-Type 是 HTML
// （典型的 Cloudflare/WAF 拦截页），改用 Electron Chromium 网络栈
// （自动吃系统代理）重试一次。回环地址始终 Node 直连（CDP、健康检查）。
function installProxiedFetch() {
  const nodeFetch = global.fetch;
  if (typeof nodeFetch !== 'function') return;
  global.fetch = async (input, init) => {
    let hostname = '';
    try {
      const raw = typeof input === 'string' ? input : input && input.url;
      hostname = new URL(raw).hostname;
    } catch { /* 解析失败按非回环处理 */ }
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
      return nodeFetch(input, init);
    }
    try {
      const direct = await nodeFetch(input, init);
      const contentType = direct.headers.get('content-type') || '';
      const looksLikeWafBlock = direct.status >= 400 && contentType.includes('text/html');
      if (!looksLikeWafBlock) return direct;
      console.warn(`[network] 直连 ${hostname} 返回 HTTP ${direct.status} HTML 拦截页，改用系统代理重试`);
    } catch (error) {
      console.warn(`[network] 直连 ${hostname} 失败（${error && error.message}），改用系统代理重试`);
    }
    return electronNet.fetch(input, init);
  };
}

// 后端端口必须固定：页面以 http://127.0.0.1:<port> 为 origin，
// localStorage / IndexedDB 都按 origin 隔离。随机端口 = 每次启动换个
// “新网站”，用户配置、素材、对话记录全部“丢失”（数据其实还在旧 origin 里）。
// 默认固定 31207；被占用时递增重试几次，仍不行才退回随机端口兜底。
const BACKEND_PORT_START = parseInt(process.env.NOVA_BACKEND_PORT || '31207', 10);
const BACKEND_PORT_MAX_ATTEMPTS = 10;

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(port));
    });
  });
}

async function resolveBackendPort() {
  for (let i = 0; i < BACKEND_PORT_MAX_ATTEMPTS; i += 1) {
    try {
      return await tryListen(BACKEND_PORT_START + i);
    } catch { /* 端口被占，试下一个 */ }
  }
  // 连续 10 个端口都被占：退回系统分配，功能可用但 origin 会变
  return tryListen(0);
}

// 首次运行：把内置的记忆种子（类目 + 规则）拷进数据目录。
// 只在「还没用过记忆」时拷，已有记忆绝不覆盖——否则升级会吃掉用户积累。
// 种子放在 extraResources（resources/memory-seed），是真实目录，不在只读 asar 里。
function seedMemoryIfEmpty(dataDir) {
  const target = path.join(dataDir, 'memory');
  try {
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return;
    const seed = path.join(process.resourcesPath || '', 'memory-seed');
    if (!seed || !fs.existsSync(seed)) return;
    fs.cpSync(seed, target, { recursive: true });
    console.log('[memory-seed] 已导入内置类目种子');
  } catch (error) {
    console.warn('[memory-seed] 导入失败:', error && error.message ? error.message : error);
  }
}

// 桌面单机场景：数据落盘到 userData 根目录（与 Chromium 配置同级），仅监听本机回环。
function prepareBackendEnv(port) {
  const dataDir = app.getPath('userData');
  // better-sqlite3 不会自动创建数据库父目录，桌面端在此保证数据目录存在
  fs.mkdirSync(dataDir, { recursive: true });
  seedMemoryIfEmpty(dataDir);
  process.env.PORT = String(port);
  process.env.HOSTNAME = '127.0.0.1';
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
  process.env.NOVA_TASK_DB = path.join(dataDir, 'nova-tasks.sqlite');
  process.env.NOVA_IMAGE_DIR = path.join(dataDir, 'nova-images');
  process.env.NOVA_CDP_DIR = path.join(dataDir, 'cdp-products');
  // Agent 记忆也必须落到 userData：打包后 backend/data 在 asar 里是只读的，
  // 不接这一行的话记忆写入会直接失败（打包版表现为「记忆功能全废」）。
  // 顺带好处：userData 按用户隔离 → 每个同事的记忆天然独立，不互相污染。
  process.env.NOVA_MEMORY_DIR = path.join(dataDir, 'memory');
  // 桌面单机版默认开启 CDP：Agent 的 browser_* 工具依赖 /api/nova/cdp/*。
  // 未连接时默认允许自动拉起独立调试浏览器；用户可显式设 false 关闭。
  // 安全边界不变：只监听 127.0.0.1，且 authorizeCdpRequest 只放行回环来源。
  // web 部署版（backend/server.js）仍默认关闭，显式置 true 才启用。
  process.env.NOVA_CDP_ENABLED ??= 'true';
  process.env.NOVA_CDP_LAUNCH_ENABLED ??= 'true';
}

// 轮询后端就绪（30 秒超时）
async function waitForBackend(port) {
  const url = `http://127.0.0.1:${port}/api/nova/config`;
  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`后端返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, BACKEND_READY_POLL_MS));
  }
  throw lastError || new Error('等待后端就绪超时');
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Nova Image Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 页面在备份进行中会注册 beforeunload；浏览器里它会弹确认框，但 Electron 会
  // 静默吞掉关闭动作导致窗口关不掉。这里转成显式确认框，用户始终可以选择强制关闭。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '确认关闭',
      message: '页面正在处理数据，确定要关闭吗？',
      detail: '未完成的导入/导出操作将会中断。',
      buttons: ['仍要关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) {
      // 忽略页面的 beforeunload，放行关闭
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

// ===== 自动更新（electron-updater）=====
// 每个版本自带自己的更新通道：打包时 -c.publish.channel=hk / l 会写进 resources/app-update.yml，
// autoUpdater 自动读它 → HK 版看 latest-hk.yml，L 版看 latest-l.yml，同仓库互不干扰。
// 开发态不检查；NOVA_DISABLE_UPDATE=true 可关掉（排错用）。
// ── 软件更新：状态机 + IPC + 给内嵌后端用的钩子 ──────────────────────────────
// backend/server.js 是被 require 进本进程的，所以它能直接读 global.__novaUpdater；
// 设置页的「检查更新」按钮 → /api/nova/update/* → 这里 → electron-updater。
const updateState = {
  status: 'idle',   // idle | checking | available | downloading | downloaded | not-available | error | unsupported
  latestVersion: '',
  progress: 0,
  message: '',
  channel: 'latest',
  checkedAt: '',
};

function updateSnapshot() {
  return {
    mode: 'electron',
    supported: updateState.status !== 'unsupported',
    currentVersion: app.getVersion(),
    ...updateState,
  };
}

/** 更新通道：优先读打包时写进 resources/app-update.yml 的 channel（hk / l） */
function readUpdateChannel(autoUpdater) {
  try {
    const text = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const matched = text.match(/^\s*channel:\s*(\S+)/m);
    if (matched && matched[1]) return matched[1];
  } catch {
    // 没有该文件（开发态 / --dir 构建）就走下面的兜底
  }
  return String((autoUpdater && autoUpdater.channel) || 'latest');
}

function setupAutoUpdate() {
  // 先无条件注册 IPC 与钩子：即使更新不可用，设置页也能拿到明确状态而不是报错
  const setState = patch => Object.assign(updateState, patch);
  let autoUpdater = null;

  const check = async () => {
    if (!autoUpdater) return updateSnapshot();
    if (updateState.status === 'downloading') return updateSnapshot();
    setState({ status: 'checking', message: '正在检查更新…', progress: 0 });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = (error && error.message) || String(error);
      setState({ status: 'error', message: `检查失败：${message}`, checkedAt: new Date().toISOString() });
      console.warn('[update] 检查失败:', message);
    }
    return updateSnapshot();
  };

  ipcMain.handle('nova:update:state', () => updateSnapshot());
  ipcMain.handle('nova:update:check', () => check());
  ipcMain.handle('nova:update:install', () => {
    if (!autoUpdater || updateState.status !== 'downloaded') {
      return { ok: false, error: '还没有下载好的新版本' };
    }
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  global.__novaUpdater = {
    getState: () => updateSnapshot(),
    check,
    install: () => {
      if (!autoUpdater || updateState.status !== 'downloaded') {
        return { ok: false, error: '还没有下载好的新版本' };
      }
      setImmediate(() => autoUpdater.quitAndInstall());
      return { ok: true };
    },
  };

  if (!app.isPackaged) {
    setState({ status: 'unsupported', message: '开发模式（未打包）不检查更新' });
    return;
  }
  if (String(process.env.NOVA_DISABLE_UPDATE || '').toLowerCase() === 'true') {
    setState({ status: 'unsupported', message: '已用 NOVA_DISABLE_UPDATE=true 关闭更新' });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    setState({ status: 'unsupported', message: 'electron-updater 不可用' });
    console.warn('[update] electron-updater 不可用，跳过自动更新');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // 通道标签要直接读 app-update.yml：electron-updater 的 channel 是「检查时才解析」的，
  // 提前读只会拿到默认值 latest，设置页就会把 L 版显示成「默认」。
  setState({ channel: readUpdateChannel(autoUpdater) });

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', message: '正在检查更新…', progress: 0 }));
  autoUpdater.on('update-available', info => setState({
    status: 'available',
    latestVersion: (info && info.version) || '',
    message: `发现新版本 ${(info && info.version) || ''}，正在后台下载…`,
    progress: 0,
    checkedAt: new Date().toISOString(),
  }));
  autoUpdater.on('update-not-available', info => setState({
    status: 'not-available',
    latestVersion: (info && info.version) || app.getVersion(),
    message: '已是最新版本',
    progress: 0,
    checkedAt: new Date().toISOString(),
  }));
  autoUpdater.on('download-progress', p => setState({
    status: 'downloading',
    progress: Math.round((p && p.percent) || 0),
    message: `正在下载 ${Math.round((p && p.percent) || 0)}%`
      + `（${(((p && p.transferred) || 0) / 1048576).toFixed(1)} / ${(((p && p.total) || 0) / 1048576).toFixed(1)} MB）`,
  }));
  autoUpdater.on('error', error => {
    const message = (error && error.message) || String(error);
    setState({ status: 'error', message: `检查/下载失败：${message}`, progress: 0, checkedAt: new Date().toISOString() });
    console.warn('[update] 检查/下载失败:', message);
  });
  autoUpdater.on('update-downloaded', async info => {
    const version = (info && info.version) || '新版本';
    setState({
      status: 'downloaded',
      latestVersion: version,
      progress: 100,
      message: `${version} 已下载完成，重启即可用上新版本`,
    });
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即重启更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `${version} 已下载完成`,
        detail: '重启即可用上新版本。选「稍后」会在你退出应用时自动安装。',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    } catch (error) {
      console.warn('[update] 安装提示失败:', (error && error.message) || error);
    }
  });

  // 启动后延迟 15 秒静默查一次，别跟启动抢资源
  setTimeout(() => { check().catch(() => {}); }, 15000).unref();
}

app.whenReady().then(async () => {
  let port;
  try {
    port = await resolveBackendPort();
    prepareBackendEnv(port);
    installProxiedFetch();
    // require 即自启动（注册路由、WS、定时清理与 shutdown handler）
    require(BACKEND_ENTRY);
    await waitForBackend(port);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Nova Image Studio 启动失败：', message);
    // showMessageBox 为异步不阻塞事件循环；另设兜底定时强制退出，
    // 避免无窗口管理器等极端环境下进程卡死
    setTimeout(() => app.exit(1), 15000).unref();
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Nova Image Studio 启动失败',
        message: '内嵌后端未能在 30 秒内就绪',
        detail: message,
        buttons: ['退出'],
      });
    } finally {
      app.exit(1);
    }
    return;
  }

  // Windows/Linux 隐藏默认的英文应用菜单栏；macOS 保留（编辑快捷键依赖应用菜单）
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  createWindow(port);
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
