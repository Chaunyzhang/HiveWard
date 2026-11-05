import type { ProcessSpec } from '@hiveward/process-host/process-spec'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcessModule from '@hiveward/process-host'

const { runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('@hiveward/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcessModule>()),
  runProcess: runProcessMock,
  spawnProcess: spawnProcessMock
}))

// Real macOS installs would register a park in the developer’s home.
vi.mock('./hivewardd-browser-install-park', () => ({ openHivewarddBrowserInstallPark: () => null }))

import { resolveHivewarddBrowserProvider, type HivewarddBrowserProvider } from './hivewardd-browser-provider'
import { agentBrowserCommandOf } from '../browser/agent-browser/agent-browser-bridge-test-harness'

const FAKE_SIDECAR = join(import.meta.dirname, '__fixtures__', 'fake-hivewardd-electron-sidecar.cjs')
const INSTALLED_EXECUTABLE = join('/Applications', 'HiveWard.app', 'Contents', 'MacOS', 'HiveWard')

let harnessRoot: string
let controlPath: string
let chromiumExecutable: string
let sidecarMode: string | undefined
let provider: HivewarddBrowserProvider | null

function agentBrowserSuccess(data: unknown) {
  return Promise.resolve({
    code: 0,
    signal: null,
    stdout: JSON.stringify({ success: true, data, error: null }),
    stderr: '',
    timedOut: false
  })
}

beforeEach(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), 'hivewardd-provider-selection-'))
  controlPath = join(harnessRoot, 'control.json')
  chromiumExecutable = join(harnessRoot, process.platform === 'win32' ? 'chromium.exe' : 'chromium')
  sidecarMode = undefined
  provider = null
  await writeFile(controlPath, '{}')
  await writeFile(chromiumExecutable, '')
  if (process.platform !== 'win32') {
    await chmod(chromiumExecutable, 0o755)
  }

  const actual = await vi.importActual<typeof RunProcessModule>('@hiveward/process-host')
  spawnProcessMock.mockReset()
  spawnProcessMock.mockImplementation((spec: ProcessSpec) =>
    actual.spawnProcess({
      ...spec,
      program: process.execPath,
      args: [FAKE_SIDECAR, ...(spec.args ?? [])],
      env: {
        ...spec.env,
        HIVEWARD_FAKE_SIDECAR_CONTROL: controlPath,
        ...(sidecarMode ? { HIVEWARD_FAKE_SIDECAR_MODE: sidecarMode } : {})
      }
    })
  )
  runProcessMock.mockReset()
  runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
    const command = agentBrowserCommandOf(spec.args ?? [], spec.input)
    if (command[0] === 'open') {
      return agentBrowserSuccess({ url: 'about:blank', title: '' })
    }
    if (command[0] === 'tab') {
      return agentBrowserSuccess({
        tabs: [{ active: true, tabId: 't1', title: '', url: 'about:blank' }]
      })
    }
    if (command[0] === 'close') {
      return agentBrowserSuccess({ closed: true })
    }
    throw new Error(`Unexpected agent-browser command: ${command.join(' ')}`)
  })
})

afterEach(async () => {
  await provider?.stop()
  vi.restoreAllMocks()
  await rm(harnessRoot, { recursive: true, force: true })
})

describe('resolveHivewarddBrowserProvider Electron preference', () => {
  it('falls back to the operator Chromium when the installed Electron app cannot start', async () => {
    sidecarMode = 'exit-before-ready'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    provider = await resolveHivewarddBrowserProvider({
      userDataPath: join(harnessRoot, 'state'),
      environment: { HIVEWARD_BROWSER_EXECUTABLE: chromiumExecutable },
      resolveInstalledElectronExecutable: async () => INSTALLED_EXECUTABLE,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(spawnProcessMock).toHaveBeenCalled()
    expect(provider?.kind).toBe('chromium')
    expect(warn).toHaveBeenCalledWith(
      '[hivewardd] Installed Electron browser provider unavailable:',
      expect.anything()
    )
  })
})
