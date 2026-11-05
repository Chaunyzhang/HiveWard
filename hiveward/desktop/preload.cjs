// 给驾驶舱网页的桌面能力：只暴露浏览器、切页面、打开文件这几样，网页拿不到 Node / Electron 本身。
const { contextBridge, ipcRenderer } = require('electron')

const desktopApi = {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // App 菜单、系统通知要网页切页面（站内路径，比如 /settings）
  onNavigate: (fn) => {
    const listener = (_e, path) => fn(path)
    ipcRenderer.on('hiveward:navigate', listener)
    return () => ipcRenderer.removeListener('hiveward:navigate', listener)
  },
  // Agent 用 hiwd file open 要在右栏文件查看器里打开的文件
  onOpenFile: (fn) => {
    const listener = (_e, file) => fn(file)
    ipcRenderer.on('hiveward:open-file', listener)
    return () => ipcRenderer.removeListener('hiveward:open-file', listener)
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
    }
  }
}

// 让网页的样式知道自己在桌面 App 里（给左上角红绿灯让位、标题栏可拖动）
window.addEventListener('DOMContentLoaded', () => {
  // 驾驶舱铺满 HiveWard 主窗口（engine.mjs），左上角要给红绿灯让位
  document.documentElement.classList.add('is-desktop')
})

contextBridge.exposeInMainWorld('hivewardDesktop', desktopApi)
