import { net, type ClientRequest, type IncomingMessage } from 'electron'
import { assertVendorUrlAllowed } from '../../shared/hiveward-policy'

// 状态码规定不能带正文的响应
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** 边收边交给调用方；调用方不读了就断开请求。断开后 Electron 不再发任何事件，超时要自己让流报错 */
function bodyStream(
  request: ClientRequest,
  response: IncomingMessage,
  signal: AbortSignal | undefined
): ReadableStream<Uint8Array> {
  let finished = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown) => {
        if (!finished) {
          finished = true
          controller.error(error)
        }
      }
      response.on('data', (chunk) => {
        if (!finished) {
          controller.enqueue(new Uint8Array(chunk))
        }
      })
      response.on('end', () => {
        if (!finished) {
          finished = true
          controller.close()
        }
      })
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('下载被中断')))
      signal?.addEventListener('abort', () => fail(signal.reason), { once: true })
    },
    cancel() {
      finished = true
      request.abort()
    }
  })
}

/** 更新用的单跳请求：Electron 的 net.fetch 一设 redirect: 'manual' 就直接报 Redirect was cancelled，
 * 拿不到 3xx 让 fetchUpdateResource 逐跳核对地址（GitHub 的下载全是跳转，Mac 下载、latest 跳转都卡在这）。
 * 改用 net.request：跳转时把 3xx 和 location 原样交回去、不跟；仍走 Chromium 会话的系统代理 / 代理设置 */
export function fetchReleaseHop(url: string, init: RequestInit = {}): Promise<Response> {
  assertVendorUrlAllowed(url)
  return new Promise((resolve, reject) => {
    const signal = init.signal ?? undefined
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const request = net.request({ url, method: init.method ?? 'GET', redirect: 'manual' })
    for (const [name, value] of new Headers(init.headers)) {
      request.setHeader(name, value)
    }
    let settled = false
    const settle = (finish: () => void) => {
      if (!settled) {
        settled = true
        finish()
      }
    }
    // 正文读到一半超时也要断开：监听到请求结束为止
    const onAbort = () => {
      request.abort()
      settle(() => reject(signal?.reason))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.on('redirect', (status, _method, location) => {
      request.abort()
      settle(() => resolve(new Response(null, { status, headers: { location } })))
    })
    request.on('response', (response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          headers.append(name, item)
        }
      }
      const status = response.statusCode
      const body = NULL_BODY_STATUSES.has(status) ? null : bodyStream(request, response, signal)
      settle(() => resolve(new Response(body, { status, headers })))
    })
    request.on('error', (error) => settle(() => reject(error)))
    request.end()
  })
}
