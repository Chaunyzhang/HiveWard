import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { LoaderCircle } from 'lucide-react'
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

/**
 * 真终端：xterm.js 接后台的 WebSocket（/api/orca/terminals/:handle/stream）。
 * 连上先收一帧 snapshot 还原当前屏幕和滚动历史，之后是输出流；键盘输入、尺寸变化发回去。
 * 断了自动重连（terminal-socket.ts），重连后服务端重新发 snapshot，所以先 reset 再写。
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
  const [conn, setConn] = useState<Conn>('connecting')
  const [error, setError] = useState<string | null>(null)
  // 接管了没有：只看时按引擎里原来的大小显示，不去改终端的排版（别处可能正在看）；
  // 第一次在这里打字才接管，之后跟着这个窗口的大小排版
  const claimed = useRef(false)
  const [owned, setOwned] = useState(false)
  const machine = useMachineId()

  // 建 xterm、连 WebSocket；handle 或电脑变了整个重来
  useEffect(() => {
    const el = box.current
    if (!el) {
      return
    }
    const t = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeNow(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    t.loadAddon(
      new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener'))
    )
    t.open(el)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose())
      t.loadAddon(gl)
    } catch {
      // 没有 WebGL 时用 xterm 默认的 DOM 渲染
    }
    f.fit()
    term.current = t
    fit.current = f

    // 人的操作：按键、粘贴、输入法上屏、点鼠标（全屏程序开了鼠标上报时点击也是输入）
    let replaying = false
    let lastUserAction = 0
    const userAction = () => {
      lastUserAction = Date.now()
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

    const socket = openTerminalSocket({
      // 每次（重）连都带上当前大小
      url: () =>
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${scoped(
          `/api/orca/terminals/${encodeURIComponent(handle)}/stream?cols=${t.cols}&rows=${t.rows}`,
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
          if (claimed.current) {
            // 重连：之前接管过，照这个窗口的大小再报一次
            socket.send({ type: 'resize', cols: t.cols, rows: t.rows })
          } else if (frame.cols !== t.cols || frame.rows !== t.rows) {
            // 只看：按引擎的大小显示，全屏界面（Claude Code 等）才不会错行
            t.resize(frame.cols, frame.rows)
          }
          // 快照里可能有旧的终端查询（问光标位置等），xterm 会自动回话；回放期间的回话一律不发
          replaying = true
          t.write(frame.data, () => {
            replaying = false
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
        setOwned(true)
        // 先按窗口排版（触发 onResize 发 resize），后台收到输入时按这个大小接管
        f.fit()
      }
      socket.send({ type: 'input', data })
    })
    const resize = t.onResize(({ cols, rows }) =>
      socket.send({ type: 'resize', cols, rows })
    )

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
      themeWatch.disconnect()
      input.dispose()
      resize.dispose()
      t.dispose()
      term.current = null
      fit.current = null
    }
  }, [handle, machine])

  // 容器大小变了就重新排版（标签页切回来、窗口缩放、侧栏拖动）
  useEffect(() => {
    const el = box.current
    if (!el || !active) {
      return
    }
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (claimed.current && el.clientWidth > 0 && el.clientHeight > 0) {
          fit.current?.fit()
        }
      })
    })
    ro.observe(el)
    term.current?.focus()
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
      <div ref={box} className='absolute inset-0 overflow-auto ps-3 pt-2' />
      {conn === 'live' && !owned && (
        <div className='pointer-events-none absolute end-3 bottom-2 rounded-md border bg-panel/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs'>
          查看中 · 按原来的大小显示，在这里打字就接管
        </div>
      )}
      {conn !== 'live' && (
        <div className='pointer-events-none absolute end-3 top-2 flex items-center gap-1.5 rounded-md border bg-panel/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs'>
          {(conn === 'connecting' || conn === 'reconnecting') && (
            <LoaderCircle className='size-3 animate-spin' />
          )}
          {conn === 'connecting'
            ? '连接中…'
            : conn === 'reconnecting'
              ? '断开了，正在重连…'
              : conn === 'exited'
                ? '终端已结束'
                : `出错：${error ?? '未知错误'}`}
        </div>
      )}
    </div>
  )
}
