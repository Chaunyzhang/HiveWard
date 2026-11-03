import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { businessRoutes } from './business-routes.mjs'
import { dispatchDecision } from './dispatches.mjs'
import { topology } from './orchestration.mjs'

const cli = fileURLToPath(new URL('./hiwd.mjs', import.meta.url))

function runHiwd(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, OPC_DISPATCHER: 'cli:test', ...env },
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
  const root = await mkdtemp(join(tmpdir(), 'opc-hiwd-new-'))
  const home = join(root, 'Home')
  const direct = join(root, 'Directory With Spaces')
  const tilde = join(home, 'Tilde Project')
  await mkdir(tilde, { recursive: true })
  await mkdir(direct)
  const created = []
  try {
    await withBridge(
      async (req, res) => {
        if (req.method === 'GET' && req.url === '/api/orca/projects') {
          json(res, { projects: [] })
          return
        }
        if (req.method === 'POST' && req.url === '/api/orca/terminals') {
          let body = ''
          for await (const chunk of req) {
            body += chunk
          }
          created.push(JSON.parse(body))
          json(res, { handle: `term_${created.length}` })
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
          const result = await runHiwd(['new', input, 'codex'], {
            OPC_BRIDGE: base,
            HOME: home,
            USERPROFILE: home
          })
          assert.equal(result.code, 0, result.stderr)
          assert.match(result.stdout, new RegExp(`term_${index + 1}`))
        }
      }
    )
    assert.deepEqual(
      created.map(({ project, agent }) => ({ project, agent })),
      [
        { project: resolve(direct), agent: 'codex' },
        { project: resolve(tilde), agent: 'codex' },
        ...(process.platform === 'win32' ? [{ project: resolve(tilde), agent: 'codex' }] : [])
      ]
    )
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
        const result = await runHiwd(['browser', 'screenshot'], { OPC_BRIDGE: base })
        assert.equal(result.code, 0, result.stderr)
        shot = result.stdout.trim()
      }
    )
    assert.equal(dirname(shot), resolve(tmpdir()))
    assert.match(basename(shot), /^opc-shot-\d+\.png$/)
    assert.deepEqual(await readFile(shot), png)

    const route = businessRoutes(async () => {}).find(
      ([method, pattern]) => method === 'GET' && pattern.source.includes('shots')
    )
    const match = route[1].exec(`/api/shots/${basename(shot)}`)
    assert.ok(match)
    const response = await route[2]({}, match.slice(1))
    assert.equal(response.type, 'image/png')
    assert.deepEqual(response.raw, png)
    for (const name of ['opc-shot-123.jpg', 'opc-shot-123.png.exe', 'other-123.png']) {
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
    String.raw`C:\Users\Owner\AppData\Local\Temp\opc-shot-123.png`,
    '/tmp/opc-shot-456.png',
    '/var/folders/ab/cdef/T/opc-shot-789.png'
  ]
  for (const [index, path] of paths.entries()) {
    const decision = dispatchDecision({
      id: `dsp_${index}`,
      blockedReason: '发布前需要确认',
      report: { summary: `【需要确认】发布\n截图：${path}` },
      by: { label: 'CLI' },
      at: '2026-11-03T00:00:00.000Z'
    })
    assert.equal(decision.screenshot, `/api/shots/opc-shot-${[123, 456, 789][index]}.png`)
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
    const root = await mkdtemp(join(tmpdir(), 'opc-hiwd-ps-'))
    const bin = join(root, 'bin')
    const marker = join(root, 'ps-called')
    await mkdir(bin)
    const env = {
      OPC_BRIDGE: 'http://127.0.0.1:1',
      OPC_DISPATCHER: '',
      ORCA_TERMINAL_HANDLE: '',
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
