// 给驾驶舱网页的桌面能力：只暴露浏览器这几样，网页拿不到 Node / Electron 本身。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('opcDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // App 菜单、系统通知要网页切页面（站内路径，比如 /settings）
  onNavigate: (fn) => {
    const listener = (_e, path) => fn(path)
    ipcRenderer.on('opc:navigate', listener)
    return () => ipcRenderer.removeListener('opc:navigate', listener)
  },
  browser: {
    list: () => ipcRenderer.invoke('browser:list'),
    open: (opts) => ipcRenderer.invoke('browser:open', opts),
    close: (id) => ipcRenderer.invoke('browser:close', id),
    activate: (id) => ipcRenderer.invoke('browser:activate', id),
    navigate: (id, url) => ipcRenderer.invoke('browser:navigate', id, url),
    history: (id, action) => ipcRenderer.invoke('browser:history', id, action),
    setBounds: (rect) => ipcRenderer.send('browser:bounds', rect),
    onChange: (fn) => {
      const listener = (_e, list) => fn(list)
      ipcRenderer.on('browser:changed', listener)
      return () => ipcRenderer.removeListener('browser:changed', listener)
    },
  },
})

// 让网页的样式知道自己在桌面 App 里（给左上角红绿灯让位、标题栏可拖动）
window.addEventListener('DOMContentLoaded', () => {
  // 驾驶舱铺满 HiveWard 主窗口（engine.mjs），左上角要给红绿灯让位
  document.documentElement.classList.add('is-desktop')
})
