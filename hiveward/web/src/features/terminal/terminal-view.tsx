import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { LoaderCircle } from 'lucide-react'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'
import { openTerminalSocket } from './terminal-socket'

// 和界面的 panel / foreground 同色（theme.css 的 oklch 换算成十六进制，xterm 只认这种）
const DARK: ITheme = {
  background: '#171717',
  foreground: '#ebebeb',
  cursor: '#ebebeb',
  selectionBackground: '#ffffff33',
}
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#181818',
  cursor: '#181818',
  selectionBackground: '#00000026',
  // 默认的亮黄、亮青在白底上看不清
  yellow: '#a16207',
  brightYellow: '#a16207',
  cyan: '#0e7490',
  brightCyan: '#0e7490',
}
const themeNow = () =>
  document.documentElement.classList.contains('dark') ? DARK : LIGHT

type Conn = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error'

const FONT = 13

/**
 * 真终端：xterm.js 接后台的 WebSocket（/api/hiveward/terminals/:handle/stream）。
 * 连上先收一帧 snapshot 还原当前屏幕和滚动历史，之后是输出流；键盘输入、尺寸变化发回去。
 * 断了自动重连（terminal-socket.ts），重连后服务端重新发 snapshot，所以先 reset 再写。
 * 显示着就铺满窗口：快照按引擎原来的行列回放，回放完按这个窗口的大小排版并报给后台，Agent 跟着重画。
 * 报大小时带 claim：终端可能同时开在几个地方，只登记大小的话它仍按上一个窗口排版，
 * 要等人在这里按了键才换过来——所以一显示、一变大小、一拿到焦点就认领，打开就是对的。
 */
export function TerminalView({
  handle,
  active = true,
  className,
}: {
  handle: string
  /** 标签页切走时为 false：不抢焦点、不报尺寸 */
  active?: boolean
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  // 认领终端大小（建 xterm 的 effect 里给值），标签页切回来时用
  const claim = useRef<(() => void) | null>(null)
  const [conn, setConn] = useState<Conn>('connecting')
  const [error, setError] = useState<string | null>(null)
  // 人在这里操作过没有：之前 xterm 自己回的终端查询应答不写进 PTY（交给引擎）
  const claimed = useRef(false)
  // 标签页显示着没有（下面的 effect 跟着 active 更新）
  const shown = useRef(active)
  const machine = useMachineId()

  // 建 xterm、连 WebSocket；handle 或电脑变了整个重来
  useEffect(() => {
    const el = box.current
    if (!el) {
      return
    }
    const t = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: FONT,
      // 行高必须是 1：大于 1 时 DOM 渲染下方框线（│ ╭ ╮）每行之间有缝
      lineHeight: 1,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeNow(),
      // Agent 输出的超链接（Claude Code 的 OSC 8 链接）点了直接开，不弹 xterm 自带的确认框
      linkHandler: { activate: (_e, uri) => openLink(uri) },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    t.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    t.open(el)
    try {
      const gl = new WebglAddon()
      // WebGL 丢了退回 DOM 渲染，格子宽度会变，重新量行列
      gl.onContextLoss(() => {
        gl.dispose()
        if (visible()) {
          f.fit()
        }
      })
      t.loadAddon(gl)
    } catch {
      // 没有 WebGL 时用 xterm 默认的 DOM 渲染
    }
    f.fit()
    term.current = t
    fit.current = f

    // 人的操作：按键、粘贴、输入法上屏、点鼠标、滚轮（全屏程序开了鼠标上报时点击、滚轮也是输入；
    // 滚轮不算的话，鼠标放上去滚不动，要先点一下）
    let replaying = false
    let lastUserAction = 0
    const userAction = () => {
      lastUserAction = Date.now()
      claimOnPointer()
    }
    t.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        userAction()
      }
      return true
    })
    el.addEventListener('paste', userAction, true)
    el.addEventListener('compositionend', userAction, true)
    el.addEventListener('mousedown', userAction, true)
    el.addEventListener('wheel', userAction, { capture: true, passive: true })

    // 这个窗口正显示着才认领终端的大小（切走的标签页、后台的窗口不抢）
    const visible = () =>
      shown.current &&
      !document.hidden &&
      el.clientWidth > 0 &&
      el.clientHeight > 0
    const claimViewport = () => {
      if (!replaying && visible()) {
        socket.send({ type: 'resize', cols: t.cols, rows: t.rows, claim: true })
      }
    }
    // 别的窗口认领过大小时，这里只看不按键也得拿回来，不然 Agent 按那边的宽度画（中文半宽就折行、框画两层）。
    // 鼠标移进来、点、滚轮都认领，一秒内最多一次
    let lastClaim = 0
    const claimOnPointer = () => {
      if (Date.now() - lastClaim > 1000) {
        lastClaim = Date.now()
        claimViewport()
      }
    }
    claim.current = claimViewport
    const onVisible = () => {
      if (!document.hidden) {
        claimViewport()
      }
    }
    el.addEventListener('pointerenter', claimOnPointer)
    window.addEventListener('focus', claimViewport)
    document.addEventListener('visibilitychange', onVisible)

    const socket = openTerminalSocket({
      // 每次（重）连都带上当前大小
      url: () =>
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${scoped(
          `/api/hiveward/terminals/${encodeURIComponent(handle)}/stream?cols=${t.cols}&rows=${t.rows}`,
          machine
        )}`,
      onState: (state) => {
        if (state !== 'ended') {
          setConn(state)
        }
      },
      onFrame: (frame) => {
        if (frame.type === 'snapshot') {
          t.reset()
          // 按引擎的行列回放，全屏界面（Claude Code、Kimi 等）才不会错行
          replaying = true
          if (frame.cols !== t.cols || frame.rows !== t.rows) {
            t.resize(frame.cols, frame.rows)
          }
          // 快照里可能有旧的终端查询（问光标位置等），xterm 会自动回话；回放期间的回话一律不发
          t.write(frame.data, () => {
            replaying = false
            // 回放完铺满窗口：尺寸变了 onResize 报给后台，Agent 按新大小重画
            // 标签页切走时窗口没有大小，等切回来 ResizeObserver 再排
            if (el.clientWidth && el.clientHeight) {
              f.fit()
            }
            claimViewport()
          })
          setError(null)
        } else if (frame.type === 'data') {
          t.write(frame.data)
        } else if (frame.type === 'exit') {
          setConn('exited')
        } else {
          setError(frame.message)
          setConn('error')
        }
      },
    })
    const input = t.onData((data) => {
      if (replaying) {
        return
      }
      if (!claimed.current) {
        // 没接管时只认人的操作；xterm 自己回的终端查询应答交给引擎和别的窗口，不能写进 PTY
        if (Date.now() - lastUserAction > 300) {
          return
        }
        claimed.current = true
      }
      socket.send({ type: 'input', data })
    })
    // 回放时按引擎大小 resize 的那一下不用报回去
    const resize = t.onResize(({ cols, rows }) => {
      if (!replaying) {
        socket.send({ type: 'resize', cols, rows, claim: visible() })
      }
    })
    // 点进来、切回这个标签页：别的窗口可能改过大小，拿回来
    t.textarea?.addEventListener('focus', claimViewport)

    // 跟着界面切换深浅色
    const themeWatch = new MutationObserver(() => {
      t.options.theme = themeNow()
    })
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      socket.close()
      el.removeEventListener('paste', userAction, true)
      el.removeEventListener('compositionend', userAction, true)
      el.removeEventListener('mousedown', userAction, true)
      el.removeEventListener('wheel', userAction, true)
      el.removeEventListener('pointerenter', claimOnPointer)
      window.removeEventListener('focus', claimViewport)
      document.removeEventListener('visibilitychange', onVisible)
      themeWatch.disconnect()
      t.textarea?.removeEventListener('focus', claimViewport)
      input.dispose()
      resize.dispose()
      t.dispose()
      term.current = null
      fit.current = null
      claim.current = null
    }
  }, [handle, machine])

  // 容器大小变了就重新排版（标签页切回来、窗口缩放、侧栏拖动）
  useEffect(() => {
    shown.current = active
    const el = box.current
    if (!el || !active) {
      return
    }
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (el.clientWidth === 0 || el.clientHeight === 0) {
          return
        }
        fit.current?.fit()
      })
    })
    ro.observe(el)
    term.current?.focus()
    // 切回来大小没变时 onResize 不触发，已经有焦点时 focus 事件也不来，直接认领
    claim.current?.()
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [active])

  return (
    <div
      className={cn(
        'relative min-h-0 bg-[#ffffff] dark:bg-[#171717]',
        className
      )}
    >
      {/* 留白放外层：FitAddon 按 box 自己的高宽算行列，带内边距会多算一行 */}
      <div className='absolute inset-0 ps-3 pt-2'>
        <div ref={box} className='size-full overflow-hidden' />
      </div>
      {conn !== 'live' && (
        <div className='pointer-events-none absolute end-3 top-2 flex items-center gap-1.5 rounded-md border bg-panel/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs'>
          {(conn === 'connecting' || conn === 'reconnecting') && (
            <LoaderCircle className='size-3 animate-spin' />
          )}
          {conn === 'connecting'
            ? tr('连接中…')
            : conn === 'reconnecting'
              ? tr('断开了，正在重连…')
              : conn === 'exited'
                ? tr('终端已结束')
                : tr('出错：{0}', [error ?? tr('未知错误')])}
        </div>
      )}
    </div>
  )
}

/** 终端里点的网页链接：在 HiveWard App 里交给系统默认浏览器（主进程接 window.open），普通浏览器里开新标签 */
function openLink(uri: string) {
  if (/^https?:\/\//i.test(uri)) {
    window.open(uri, '_blank', 'noopener')
  }
}
