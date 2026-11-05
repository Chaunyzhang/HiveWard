import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { mkdtemp, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { HIVEWARDD_NODE_PTY_DIR } from '../../shared/hivewardd-artifacts'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { locatePinnedNodeForTests, skipForMissingInputs } from './hivewardd-node-slot-fixture'

const packageDir = resolve('out/hivewardd')
const pinnedNode = locatePinnedNodeForTests()

const skip = skipForMissingInputs('artifact', [
  ...(pinnedNode ? [] : ['the pinned Node (HIVEWARD_PINNED_NODE or out/runtimes)']),
  ...(existsSync(join(packageDir, HIVEWARDD_NODE_PTY_DIR)) ? [] : [`out/hivewardd/${HIVEWARDD_NODE_PTY_DIR}`])
])

describe.skipIf(skip)('packaged node-pty under the pinned Node', () => {
  it('spawns, reattaches, delivers data and retires a shell from the shipped slot only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hiveward-packaged-node-pty-'))
    try {
      const entry = join(directory, 'local-pty.cjs')
      // Dynamic ESM imports ignore NODE_PATH.
      await symlink(join(packageDir, 'node_modules'), join(directory, 'node_modules'), 'junction')
      await build({
        stdin: {
          contents: `
              import { LocalPtyProvider } from './src/main/providers/local-pty/local-pty-provider'
              import { setAppEnvironment } from './src/shared/app-environment'
              import { getCmdExePath } from './src/shared/windows-batch-spawn'
              const loaded = require('fs').realpathSync(require.resolve('node-pty'))
              if (!loaded.startsWith(require('fs').realpathSync(${JSON.stringify(packageDir)}))) throw new Error('node-pty resolved outside the package: ' + loaded)
              setAppEnvironment({
                getPath: () => process.cwd(), getAppPath: () => process.cwd(),
                getVersion: () => 'test', isPackaged: () => true,
                onWillQuit() {}, exit: code => process.exit(code), getAppMetrics: () => []
              })
              const provider = new LocalPtyProvider()
              let output = '', resolveExit
              const exit = new Promise(resolve => { resolveExit = resolve })
              provider.onData(event => { output += event.data })
              provider.onExit(event => resolveExit(event.code))
              const deadline = setTimeout(() => { provider.killAll(); process.exit(98) }, 10_000)
              ;(async () => {
                const first = await provider.spawn({
                  sessionId: 'packaged-node-pty', cols: 80, rows: 24, cwd: process.cwd(),
                  shellOverride: process.platform === 'win32' ? getCmdExePath() : '/bin/sh'
                })
                const again = await provider.spawn({ sessionId: first.id, cols: 100, rows: 30 })
                provider.write(first.id, process.platform === 'win32'
                  ? 'echo HIVEWARD_PACKAGED_PTY_READY & exit 17\\r'
                  : 'printf HIVEWARD_PACKAGED_PTY_READY; exit 17\\r')
                const code = await exit
                clearTimeout(deadline)
                console.log(JSON.stringify({
                  version: process.versions.node, code, output: output.includes('HIVEWARD_PACKAGED_PTY_READY'),
                  reattached: again.isReattach === true && again.pid === first.pid,
                  retired: provider.getPtyProcess(first.id) === undefined
                }))
              })().catch(error => { clearTimeout(deadline); provider.killAll(); console.error(error); process.exitCode = 1 })
            `,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['node-pty', 'electron', '@parcel/watcher', '*.node'],
        outfile: entry,
        logLevel: 'silent'
      })
      const result = await runProcess({
        program: pinnedNode!,
        args: [entry],
        cwd: directory,
        env: {
          ...process.env,
          HIVEWARD_BACKGROUND_LAUNCH: '1',
          HIVEWARD_DISABLE_MACOS_LOGIN_SHELL: '1',
          HIVEWARD_USER_DATA_PATH: directory
        },
        timeoutMs: 15_000,
        terminationBarrier: true
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        version: NODE_RUNTIME_PIN.version,
        code: 17,
        output: true,
        reattached: true,
        retired: true
      })
    } finally {
      // Remove the junction before recursively deleting the test root.
      await unlink(join(directory, 'node_modules')).catch(() => {})
      removeTreeSync(directory)
    }
  }, 20_000)
})
