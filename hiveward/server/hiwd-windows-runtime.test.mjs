import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { businessRoutes } from './business-routes.mjs'
import { decisionScreenshot } from './hiveward-decisions.mjs'
import { topology } from './orchestration.mjs'

const cli = fileURLToPath(new URL('./hiwd.mjs', import.meta.url))

function runHiwd(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HIVEWARD_DISPATCHER: 'cli:test', ...env },
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

async function withBridge(handler, run) {
  const server = createServer(handler)
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

test('hiwd new accepts existing absolute and home directories with spaces and tilde separators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-hiwd-new-'))
  const home = join(root, 'Home')
  const direct = join(root, 'Directory With Spaces')
  const tilde = join(home, 'Tilde Project')
  await mkdir(tilde, { recursive: true })
  await mkdir(direct)
  // hiwd uses fs.realpathSync, which keeps Windows 8.3 short names (RUNNER~1) that the native realpath expands.
  const realDirect = realpathSync(direct)
  const realTilde = realpathSync(tilde)
  const created = []
  try {
    await withBridge(
      async (req, res) => {
        if (req.method === 'GET' && req.url === '/api/hiveward/projects') {
          json(res, { projects: [] })
          return
        }
        if (req.method === 'POST' && req.url === '/api/workers/start') {
          let body = ''
          for await (const chunk of req) {
            body += chunk
          }
          created.push(JSON.parse(body))
          json(res, {
            terminal: `term_${created.length}`,
            taskId: 'task',
            dispatchId: 'dispatch',
            state: 'ready'
          })
          return
        }
        json(res, {})
      },
      async (base) => {
        const inputs = [direct, `~/${basename(tilde)}`]
        if (process.platform === 'win32') {
          inputs.push(`~\\${basename(tilde)}`)
        }
        for (const [index, input] of inputs.entries()) {
          const result = await runHiwd(['new', input, 'codex', '测试任务'], {
            HIVEWARD_BRIDGE: base,
            HOME: home,
            USERPROFILE: home
          })
          assert.equal(result.code, 0, result.stderr)
          assert.match(result.stdout, new RegExp(`term_${index + 1}`))
        }
      }
    )
    assert.deepEqual(
      created.map(({ path: project, agent }) => ({ project, agent })),
      [
        { project: realDirect, agent: 'codex' },
        { project: realTilde, agent: 'codex' },
        ...(process.platform === 'win32' ? [{ project: realTilde, agent: 'codex' }] : [])
      ]
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'hiwd new realpaths a symlinked directory before matching the registered project',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-hiwd-symlink-'))
    const realDir = join(root, 'real project')
    await mkdir(realDir)
    const real = await realpath(realDir)
    const alias = join(root, 'alias project')
    await symlink(real, alias)
    let created
    try {
      await withBridge(
        async (req, res) => {
          if (req.method === 'GET' && req.url === '/api/hiveward/projects') {
            json(res, { projects: [{ id: 'repo-real', name: 'Real', path: real }] })
            return
          }
          if (req.method === 'POST' && req.url === '/api/workers/start') {
            let body = ''
            for await (const chunk of req) {
              body += chunk
            }
            created = JSON.parse(body)
            json(res, {
              terminal: 'term_1',
              taskId: 'task',
              dispatchId: 'dispatch',
              state: 'ready'
            })
            return
          }
          json(res, {})
        },
        async (base) => {
          const result = await runHiwd(['new', alias, 'codex', '测试任务'], {
            HIVEWARD_BRIDGE: base
          })
          assert.equal(result.code, 0, result.stderr)
        }
      )
      assert.equal(created.path, real)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('hiwd new --on passes an unregistered Windows directory to the executor unchanged', async () => {
  let created
  await withBridge(
    async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/machines') {
        json(res, {
          machines: [{ id: 'B', name: 'Windows-B', self: false, paired: true }]
        })
        return
      }
      if (req.method === 'GET' && req.url === '/api/hiveward/projects') {
        json(res, { projects: [] })
        return
      }
      if (req.method === 'POST' && req.url === '/api/workers/start') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
        }
        created = JSON.parse(body)
        json(res, {
          terminal: 'term_remote',
          taskId: 'task',
          dispatchId: 'dispatch',
          state: 'ready'
        })
        return
      }
      json(res, {})
    },
    async (base) => {
      const result = await runHiwd(
        ['new', String.raw`C:\work\demo`, 'claude', '测试任务', '--on', 'B'],
        {
          HIVEWARD_BRIDGE: base
        }
      )
      assert.equal(result.code, 0, result.stderr)
    }
  )
  assert.equal(created.path, String.raw`C:\work\demo`)
  assert.equal(created.on, 'B')
})

test('hiwd review refuses ambiguous cached task ids before sending a mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-hiwd-route-'))
  let mutated = false
  try {
    const dispatch = {
      id: 'dsp_same',
      terminal: 'term_remote',
      project: '/remote',
      title: '同名任务',
      status: 'completed',
      by: { kind: 'cli', id: 'cli:test', label: 'CLI', machineId: 'A' }
    }
    await writeFile(
      join(root, 'remote-dispatches.json'),
      JSON.stringify({
        machines: [
          { machineId: 'B', machineName: 'Windows-B', dispatches: [dispatch] },
          { machineId: 'C', machineName: 'Windows-C', dispatches: [dispatch] }
        ]
      })
    )
    await withBridge(
      async (req, res) => {
        if (req.method === 'GET' && req.url === '/api/tasks') {
          json(res, [])
          return
        }
        mutated ||= req.method === 'POST'
        json(res, {})
      },
      async (base) => {
        const result = await runHiwd(['review', 'dsp_same', '--accept'], {
          HIVEWARD_BRIDGE: base,
          HIVEWARD_DATA_DIR: root
        })
        assert.equal(result.code, 1)
        assert.match(result.stderr, /原生任务/)
      }
    )
    assert.equal(mutated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default screenshots use the OS temp directory and the strict route reads them back', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  let shot
  try {
    await withBridge(
      (req, res) => {
        if (req.method === 'GET' && req.url === '/api/browser/tabs') {
          json(res, {
            tabs: [{ id: 'tab_1', active: true, profile: 'default', title: '', url: '' }]
          })
          return
        }
        if (req.method === 'GET' && req.url === '/api/browser/tabs/tab_1/screenshot') {
          res.writeHead(200, { 'content-type': 'image/png' })
          res.end(png)
          return
        }
        json(res, {})
      },
      async (base) => {
        const result = await runHiwd(['web', 'screenshot'], { HIVEWARD_BRIDGE: base })
        assert.equal(result.code, 0, result.stderr)
        shot = result.stdout.trim()
      }
    )
    assert.equal(dirname(shot), resolve(tmpdir()))
    assert.match(basename(shot), /^hiveward-shot-\d+\.png$/)
    assert.deepEqual(await readFile(shot), png)

    const route = businessRoutes(async () => {}).find(
      ([method, pattern]) => method === 'GET' && pattern.source.includes('shots')
    )
    const match = route[1].exec(`/api/shots/${basename(shot)}`)
    assert.ok(match)
    const response = await route[2]({}, match.slice(1))
    assert.equal(response.type, 'image/png')
    assert.deepEqual(response.raw, png)
    for (const name of ['hiveward-shot-123.jpg', 'hiveward-shot-123.png.exe', 'other-123.png']) {
      assert.equal(route[1].test(`/api/shots/${name}`), false, name)
    }
  } finally {
    if (shot) {
      await rm(shot, { force: true })
    }
  }
})

test('dispatchDecision maps Windows and POSIX screenshot paths to shot URLs', () => {
  const paths = [
    String.raw`C:\Users\Owner\AppData\Local\Temp\hiveward-shot-123.png`,
    '/tmp/hiveward-shot-456.png',
    '/var/folders/ab/cdef/T/hiveward-shot-789.png'
  ]
  for (const [index, path] of paths.entries()) {
    assert.equal(
      decisionScreenshot(`截图：${path}`),
      `/api/shots/hiveward-shot-${[123, 456, 789][index]}.png`
    )
  }
})

test('unregistered Windows project labels use the final path component', () => {
  const path = String.raw`C:\Work\My Project`
  const { nodes } = topology(
    [],
    [
      {
        id: 'dsp_windows',
        handle: 'term_windows',
        project: path,
        agent: 'codex',
        prompt: 'do work',
        title: '',
        status: 'dispatched',
        at: '2026-11-03T00:00:00.000Z',
        by: { kind: 'cli', id: 'cli', label: 'CLI', cwd: path },
        alive: true
      }
    ]
  )
  assert.equal(nodes.find((node) => node.unregistered)?.label, 'My Project')
})

test(
  'non-macOS dispatcher detection never invokes ps',
  { skip: process.platform === 'darwin' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-hiwd-ps-'))
    const bin = join(root, 'bin')
    const marker = join(root, 'ps-called')
    await mkdir(bin)
    const env = {
      HIVEWARD_BRIDGE: 'http://127.0.0.1:1',
      HIVEWARD_DISPATCHER: '',
      HIVEWARD_TERMINAL_HANDLE: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      PS_MARKER: marker,
      PATH: bin,
      Path: bin
    }
    try {
      if (process.platform === 'win32') {
        const hook = join(root, 'ps-probe.cjs')
        await writeFile(
          hook,
          "if (process.argv0.toLowerCase().endsWith('ps.exe')) require('node:fs').writeFileSync(process.env.PS_MARKER, 'called')\n"
        )
        const ps = join(bin, 'ps.exe')
        await link(process.execPath, ps).catch((error) =>
          error.code === 'EXDEV' ? copyFile(process.execPath, ps) : Promise.reject(error)
        )
        env.NODE_OPTIONS = `--require ${JSON.stringify(hook)}`
      } else {
        const ps = join(bin, 'ps')
        await writeFile(ps, '#!/bin/sh\nprintf called > "$PS_MARKER"\n')
        await chmod(ps, 0o755)
      }
      const result = await runHiwd(['review', 'dsp_missing', '--accept'], env)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /连不上 HiveWard/)
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
