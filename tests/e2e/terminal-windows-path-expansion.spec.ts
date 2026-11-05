import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base } from './helpers/hiveward-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'

const probeRoot = mkdtempSync(path.join(os.tmpdir(), 'hiveward-e2e-path-expansion-'))
const probeBin = path.join(probeRoot, 'bin')
mkdirSync(probeBin)
writeFileSync(
  path.join(probeBin, 'hiveward-path-expansion-probe.cmd'),
  '@echo off\r\necho HIVEWARD_PATH_EXPANSION_OK\r\n'
)

const test = base
test.use({
  launchEnv: {
    HIVEWARD_E2E_PATH_ROOT: probeRoot,
    PATH: `%HIVEWARD_E2E_PATH_ROOT%\\bin${path.delimiter}${process.env.PATH ?? ''}`
  }
})

test.afterAll(() => {
  rmSync(probeRoot, { recursive: true, force: true })
})

test.skip(process.platform !== 'win32', 'Windows PATH expansion requires a native Windows shell')

test('expands variables in PATH before spawning a Windows shell', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  const ptyId = await waitForActivePanePtyId(hivewardPage)

  await execInTerminal(hivewardPage, ptyId, 'hiveward-path-expansion-probe')

  await waitForTerminalOutput(hivewardPage, 'HIVEWARD_PATH_EXPANSION_OK')
})
