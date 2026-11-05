// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationRow } from './migration-row'

let root: Root
let client: QueryClient
let host: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          status: 'deferred',
          path: '/tmp/OPC-Engine',
          reason: 'migration_source_busy',
        },
      ])
    )
  )
  vi.stubGlobal('fetch', fetchMock)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MigrationRow />
      </QueryClientProvider>
    )
  })
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      '资料迁移暂缓，继续使用原资料。'
    )
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('旧资料仍在用时显示暂缓，而不是迁移失败', () => {
  expect(document.body.textContent).toContain(
    '资料迁移暂缓，继续使用原资料。请在终端和服务结束后重新启动。'
  )
  expect(document.body.textContent).not.toContain('资料迁移失败')
})
