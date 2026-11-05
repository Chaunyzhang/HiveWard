import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {}
  aborted = false
  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
  abort() {
    this.aborted = true
  }
  end() {}
}
const fixtures = vi.hoisted(() => {
  const requests: FakeRequest[] = []
  const options: unknown[] = []
  return { requests, options }
})
vi.mock('electron', () => ({
  net: {
    request: (options: unknown) => {
      const request = new FakeRequest()
      fixtures.options.push(options)
      fixtures.requests.push(request)
      return request
    }
  }
}))
const { fetchReleaseHop } = await import('./electron-release-fetch')
function lastRequest(): FakeRequest {
  const request = fixtures.requests.at(-1)
  if (!request) {
    throw new Error('还没有发出请求')
  }
  return request
}
beforeEach(() => {
  fixtures.requests.length = 0
  fixtures.options.length = 0
})

it('跳转不跟，把 3xx 和 location 交回去逐跳核对', async () => {
  const pending = fetchReleaseHop('https://github.com/Chaunyzhang/HiveWard/releases/latest', {
    headers: { Accept: 'text/html' }
  })
  const request = lastRequest()
  expect(fixtures.options[0]).toMatchObject({ method: 'GET', redirect: 'manual' })
  expect(request.headers).toEqual({ accept: 'text/html' })
  request.emit(
    'redirect',
    302,
    'GET',
    'https://github.com/Chaunyzhang/HiveWard/releases/tag/v1.1.2'
  )
  const response = await pending
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(
    'https://github.com/Chaunyzhang/HiveWard/releases/tag/v1.1.2'
  )
  expect(request.aborted).toBe(true)
})

it('正文边收边读', async () => {
  const pending = fetchReleaseHop('https://github.com/Chaunyzhang/HiveWard/releases/download/v1/a')
  const response = new EventEmitter()
  Object.assign(response, { statusCode: 200, headers: { 'content-type': ['text/plain'] } })
  lastRequest().emit('response', response)
  const result = await pending
  response.emit('data', Buffer.from('ab'))
  response.emit('data', Buffer.from('c'))
  response.emit('end')
  expect(result.headers.get('content-type')).toBe('text/plain')
  expect(await result.text()).toBe('abc')
})

it('正文读到一半超时：断开请求，流报错，不会一直挂着', async () => {
  const controller = new AbortController()
  const pending = fetchReleaseHop(
    'https://github.com/Chaunyzhang/HiveWard/releases/download/v1/a',
    {
      signal: controller.signal
    }
  )
  const response = new EventEmitter()
  Object.assign(response, { statusCode: 200, headers: {} })
  lastRequest().emit('response', response)
  const result = await pending
  response.emit('data', Buffer.from('a'))
  controller.abort(new Error('timeout'))
  expect(lastRequest().aborted).toBe(true)
  await expect(result.text()).rejects.toThrow('timeout')
})

it('连接失败向调用方报告', async () => {
  const pending = fetchReleaseHop(
    'https://api.github.com/repos/Chaunyzhang/HiveWard/releases/latest'
  )
  lastRequest().emit('error', new Error('net::ERR_CONNECTION_CLOSED'))
  await expect(pending).rejects.toThrow('ERR_CONNECTION_CLOSED')
})
