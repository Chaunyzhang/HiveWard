// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPluginPanelShellHtml } from './plugin-panel-shell'

type Disposable = { dispose: () => void }
type FrameHiveWard = {
  on: (event: string, handler: (payload: unknown) => unknown) => Disposable
  plugin: {
    request: (name: string, input?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>
    on: (event: string, handler: (payload: unknown) => unknown) => Disposable
  }
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    onDidChange: (handler: (change: { key: string }) => void) => Disposable
  }
  settings: { get: (key?: string) => Promise<unknown> }
}

const realParent = window.parent
afterEach(() => {
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true })
})

function mountShell() {
  const parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  const script = buildPluginPanelShellHtml('<main></main>').match(
    /<script>\n([\s\S]*?)<\/script>/
  )?.[1]
  window.eval(script!.replaceAll('configurable: false', 'configurable: true'))
  const hiveward: FrameHiveWard = Object.getOwnPropertyDescriptor(window, 'hiveward')?.value
  const fromHost = (data: unknown) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shim only compares source identity.
    window.dispatchEvent(new MessageEvent('message', { data, source: parent as never as Window }))
  const requests = () =>
    parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.kind === 'req')
  const answer = (id: number, result: unknown) => fromHost({ hiveward: 1, kind: 'res', id, result })
  const push = (payload: unknown) =>
    fromHost({ hiveward: 1, kind: 'evt', event: 'plugin.push', payload })
  return { hiveward, requests, answer, push }
}

describe('window.hiveward.plugin', () => {
  it('asks the worker through plugin.request and resolves with its output', async () => {
    const { hiveward, requests, answer } = mountShell()
    const todos = hiveward.plugin.request('todos.list', { done: false }, { timeoutMs: 999_999 })
    const [sent] = requests()
    expect(sent).toMatchObject({
      method: 'plugin.request',
      params: { name: 'todos.list', input: { done: false }, timeoutMs: 120_000 }
    })
    answer(sent.id, { output: [{ id: '1' }] })
    await expect(todos).resolves.toEqual([{ id: '1' }])
  })
})

describe('window.hiveward events and data', () => {
  it('subscribes to a workspace or agent event once, on the first listener', () => {
    const { hiveward, requests, push } = mountShell()
    const first = vi.fn()
    hiveward.on('agent.status.changed', first)
    hiveward.on('agent.status.changed', vi.fn())
    hiveward.on('theme', vi.fn())
    expect(requests()).toEqual([
      expect.objectContaining({
        method: 'events.subscribe',
        params: { event: 'agent.status.changed' }
      })
    ])
    push({ kind: 'event', event: 'agent.status.changed', payload: { state: 'done' } })
    expect(first).toHaveBeenCalledWith({ state: 'done' })
  })
})
