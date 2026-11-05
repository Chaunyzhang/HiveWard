import { apiError } from './business.mjs'
import { call } from './hiveward-client.mjs'

// 「保持电脑唤醒（仅本次会话）」：会话按下开关就向引擎的 AgentAwakeService 要「常亮」，
// 会话的终端关掉（或者都松开了）就还回原来的模式。只改内存里的模式，不写设置，App 重开就没了。
// service 由桌面 App 注入（{ getStatus, setMode }）；命令行跑的桥没有它，接口就不挂，网页不显示这一项。

export function createSessionAwake({ service, listHandles, interval = 30_000 }) {
  const holders = new Set()
  let restore = null

  const hold = (handle) => {
    if (holders.size === 0) {
      restore = service.getStatus().mode
    }
    holders.add(handle)
    service.setMode('on')
  }
  const release = (handle) => {
    if (!holders.delete(handle) || holders.size > 0) {
      return
    }
    service.setMode(restore ?? 'off')
    restore = null
  }
  // 终端没了就松开它
  const prune = async () => {
    if (holders.size === 0) {
      return
    }
    let alive
    try {
      alive = new Set(await listHandles())
    } catch {
      return
    }
    for (const h of holders) {
      if (!alive.has(h)) {
        release(h)
      }
    }
  }
  const timer = setInterval(() => void prune(), interval)
  timer.unref?.()

  const view = (handle) => {
    const s = service.getStatus()
    return { handle, on: holders.has(handle), active: s.active, mode: s.mode }
  }
  const handleOf = (value) => {
    if (typeof value !== 'string' || !value) {
      throw apiError(400, 'bad_request', 'handle 不能为空')
    }
    return value
  }

  return {
    hold,
    release,
    prune,
    holding: () => [...holders],
    dispose() {
      clearInterval(timer)
      for (const h of holders) {
        release(h)
      }
    },
    routes: (readJson) => [
      [
        'GET',
        /^\/api\/session-awake$/,
        async (_req, _params, url) => view(handleOf(url.searchParams.get('handle')))
      ],
      [
        'POST',
        /^\/api\/session-awake$/,
        async (req, _params, _url, { isLan } = {}) => {
          if (isLan) {
            throw apiError(403, 'forbidden', '只能在这台电脑上开关')
          }
          const body = await readJson(req)
          const handle = handleOf(body.handle)
          if (body.on) {
            hold(handle)
          } else {
            release(handle)
          }
          return view(handle)
        }
      ]
    ]
  }
}

/** 桥接服务挂的路由；没注入 service（命令行跑的桥）时不挂 */
export function sessionAwakeRoutes(service, readJson) {
  if (!service) {
    return []
  }
  const awake = createSessionAwake({
    service,
    listHandles: async () => (await call('terminal.list', {})).terminals.map((t) => t.handle)
  })
  return awake.routes(readJson)
}
