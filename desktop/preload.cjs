// 桌面壳 preload：只向渲染进程暴露版本信息与「检查更新」桥，不开放任何 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaDesktop', {
  versions: process.versions,
  // 更新桥：只有桌面壳（打包版）里有；浏览器直接访问 127.0.0.1 时 window.novaDesktop 不存在，
  // 前端会自动改走后端 /api/nova/update 的兜底逻辑（拿 GitHub Release 比版本）。
  updater: {
    getState: () => ipcRenderer.invoke('nova:update:state'),
    check: () => ipcRenderer.invoke('nova:update:check'),
    install: () => ipcRenderer.invoke('nova:update:install'),
  },
});
