// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UpdateRow } from './update-row'

let root: Root
let client: QueryClient
let host: HTMLDivElement
const snapshot = {
  appVersion: '1.0.0',
  automatic: true,
  workingAgents: 3,
  notes: '修复问题',
  status: { state: 'downloaded', version: '1.1.0' },
}
const fetchMock = vi.fn()
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
}
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text
  )
  if (!found) {
    throw new Error(`找不到按钮 ${text}`)
  }
  return found
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(snapshot))
  )
  vi.stubGlobal('fetch', fetchMock)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UpdateRow />
      </QueryClientProvider>
    )
  })
  await settle()
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('先显示工作中的 Agent 数量，选择稍后不会发安装请求', async () => {
  await act(async () => button('重启并更新').click())
  expect(document.body.textContent).toContain(
    '3 个 Agent 正在干活，更新会重启 HiveWard 打断它们'
  )
  await act(async () => button('稍后').click())
  expect(
    fetchMock.mock.calls.some(([url]) => url === '/api/updates/install')
  ).toBe(false)
})
it('明确确认后，安装请求携带看到的版本和 Agent 数量', async () => {
  await act(async () => button('重启并更新').click())
  await act(async () => button('现在更新').click())
  await settle()
  const install = fetchMock.mock.calls.find(
    ([url]) => url === '/api/updates/install'
  )
  expect(JSON.parse(install?.[1]?.body)).toEqual({
    version: '1.1.0',
    workingAgents: 3,
  })
})
