import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { hivewardProduct } from '../../shared/hiveward-policy'
import { hivewardContents, openInHiveWard } from './bridge-service'

const ZOOM_STEP = 0.5
const ZOOM_LIMIT = 3

function zoomHiveWard(direction: 'in' | 'out' | 'reset'): void {
  const contents = hivewardContents()
  if (!contents) {
    return
  }
  if (direction === 'reset') {
    contents.setZoomLevel(0)
    return
  }
  const next = contents.getZoomLevel() + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  contents.setZoomLevel(Math.max(-ZOOM_LIMIT, Math.min(ZOOM_LIMIT, next)))
}

// Native actions target the HiveWard page or the focused embedded browser.
export function registerHiveWardMenu(options: { onQuitAndStopAllSessions?: () => void }): void {
  const isMac = process.platform === 'darwin'
  const name = hivewardProduct.name
  const settingsItem: MenuItemConstructorOptions = {
    label: '设置…',
    accelerator: 'CmdOrCtrl+,',
    click: () => openInHiveWard('/settings')
  }
  // 关于、检查更新都在设置里对应的页
  const aboutItem: MenuItemConstructorOptions = {
    label: `关于 ${name}`,
    click: () => openInHiveWard('/settings/about')
  }
  const updatesItem: MenuItemConstructorOptions = {
    label: '检查更新…',
    click: () => openInHiveWard('/settings/updates')
  }
  const { onQuitAndStopAllSessions } = options
  const quitItems: MenuItemConstructorOptions[] = [
    ...(onQuitAndStopAllSessions
      ? [{ label: '完全退出（结束所有终端）…', click: () => onQuitAndStopAllSessions() }]
      : []),
    // 普通退出：终端和里面的 Agent 留在后台，下次打开接着用
    { role: 'quit', label: `退出 ${name}` }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: name,
            submenu: [
              aboutItem,
              updatesItem,
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: `隐藏 ${name}` },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              ...quitItems
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : [
          {
            label: '文件',
            submenu: [settingsItem, aboutItem, updatesItem, { type: 'separator' }, ...quitItems]
          } satisfies MenuItemConstructorOptions
        ]),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        {
          label: '重新载入',
          accelerator: 'CmdOrCtrl+R',
          click: () => hivewardContents()?.reload()
        },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoomHiveWard('reset') },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => zoomHiveWard('in') },
        // 不按 Shift 的 ⌘= 也算放大
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          visible: false,
          click: () => zoomHiveWard('in')
        },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomHiveWard('out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' },
        ...(app.isPackaged
          ? []
          : ([
              { type: 'separator' },
              {
                label: '开发者工具',
                accelerator: 'Alt+CmdOrCtrl+I',
                click: () => hivewardContents()?.toggleDevTools()
              }
            ] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
