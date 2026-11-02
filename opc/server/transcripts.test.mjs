import { pathKey } from './workspace-path.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import vm from 'node:vm'

async function fixture(t, platform = process.platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-transcripts-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  let now = Date.now()
  const startedAt = now - 1000
  const calls = []
  class Clock extends Date {
    static now() {
      return now
    }
  }
  const processes = new Map()
  const files = new Map()
  const births = new Map()
  const peers = []
  const children = new Map()
  const context = vm.createContext({
    Buffer,
    Date: Clock,
    process: {
      platform,
      kill(pid) {
        if (!processes.has(pid)) {
          throw new Error('ESRCH')
        }
      }
    }
  })
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args })
    const cb = typeof options === 'function' ? options : callback
    let stdout = ''
    if (command === 'ps' && args[0] === '-axo') {
      stdout = peers
        .map(
          (p) =>
            `${p.pid} ${new Date(p.startedAt)
              .toString()
              .split(' ')
              .filter((_, i) => i < 3 || i === 4)
              .join(' ')} ${new Date(p.startedAt).getFullYear()} Kimi Code`
        )
        .join('\n')
    } else if (command === 'lsof' && args[0] === '-a') {
      stdout = peers.map((p) => `p${p.pid}\nn${cwd}`).join('\n')
    } else if (command === 'ps') {
      const p = processes.get(Number(args.at(-1)))
      stdout = p ? (args[1] === 'command=' ? p : `Sun Nov 1 12:00:00 2026 ${p}`) : ''
    } else if (command === 'pgrep') {
      stdout = (children.get(Number(args[1])) ?? []).join('\n')
    } else if (command === 'lsof') {
      stdout = args
        .at(-1)
        .split(',')
        .flatMap((pid) => (files.get(Number(pid)) ?? []).map((file) => `n${file}`))
        .join('\n')
    }
    cb(null, stdout, '')
  }
  execFile[util.promisify.custom] = (...args) =>
    new Promise((resolve, reject) =>
      execFile(...args, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr })
      )
    )
  const modules = {
    'node:child_process': { execFile },
    './workspace-path.mjs': { pathKey },
    '@orca/process-host': {
      runProcess: ({ program, args }) => util.promisify(execFile)(program, args)
    },
    'node:crypto': crypto,
    'node:fs': {
      ...fs,
      statSync(file) {
        const stat = fs.statSync(file)
        if (births.has(file)) {
          stat.birthtimeMs = births.get(file)
        }
        return stat
      }
    },
    'node:os': { homedir: () => home },
    'node:path': path,
    'node:util': util
  }
  const source = new vm.SourceTextModule(
    fs.readFileSync(new URL('./transcripts.mjs', import.meta.url), 'utf8'),
    { context }
  )
  await source.link((specifier) => {
    const exports = modules[specifier]
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) {
          this.setExport(name, value)
        }
      },
      { context }
    )
  })
  await source.evaluate()
  source.namespace.configureWindowsProcesses(async () =>
    [...processes].map(([pid, command]) => ({
      pid,
      command,
      name: command,
      ppid: [...children].find(([, ids]) => ids.includes(pid))?.[0] ?? 0,
      creationTimeMs: startedAt
    }))
  )
  const cwd = '/project/test'
  const write = (relative, value = '') => {
    const file = path.join(home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    return file
  }
  const transcript = (id) => write(`.claude/projects/-project-test/${id}.jsonl`)
  const session = (pid, id) =>
    write(`.claude/sessions/${pid}.json`, JSON.stringify({ pid, cwd, sessionId: id }))
  return {
    home,
    cwd,
    processes,
    files,
    children,
    births,
    peers,
    write,
    transcript,
    session,
    calls,
    advance: (ms = 4000) => {
      now += ms
    },
    rawLocate: source.namespace.locate,
    locate: (pid, start = startedAt) => source.namespace.locate({ pid, cwd, startedAt: start })
  }
}

test('Claude: same directory stays isolated; child process session outranks lsof', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'zsh')
  f.processes.set(2, 'claude')
  f.children.set(1, [2])
  f.processes.set(3, 'claude')
  const a = f.transcript('a'),
    b = f.transcript('b')
  f.session(2, 'a')
  f.session(3, 'b')
  f.files.set(2, [b])
  assert.equal((await f.locate(1)).path, a)
  assert.equal((await f.locate(3)).path, b)
})

test('Claude: clear/resume updates after TTL; missing new transcript never falls back', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  const a = f.transcript('a')
  f.session(1, 'a')
  assert.equal((await f.locate(1)).path, a)
  f.session(1, 'b')
  f.advance()
  assert.equal((await f.locate(1)).path, null)
  const b = f.transcript('b')
  f.advance()
  assert.equal((await f.locate(1)).path, b)
  f.session(1, 'a')
  f.advance()
  assert.equal((await f.locate(1)).path, a)
})

test('fallback excludes unqueried live Claude sessions but ignores dead owners', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  f.processes.set(2, 'claude')
  const a = f.transcript('a'),
    b = f.transcript('b')
  fs.utimesSync(b, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
  f.session(2, 'b')
  f.session(99, 'a')
  assert.equal((await f.locate(1)).path, a)
  f.processes.delete(2)
  f.advance()
  assert.equal((await f.locate(1)).path, b)
})

test('guesses expire and later exact evidence wins', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  const a = f.transcript('a')
  assert.equal((await f.locate(1)).path, a)
  const b = f.transcript('b')
  fs.utimesSync(b, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
  f.advance()
  assert.equal((await f.locate(1)).path, b)
  f.session(1, 'a')
  f.advance()
  assert.equal((await f.locate(1)).path, a)
})

test('exact lsof ownership excluded from fallback; changed process identity releases claim', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'kimi')
  f.processes.set(2, 'kimi')
  const hash = crypto.createHash('md5').update(f.cwd).digest('hex')
  const p = f.write(`.kimi/sessions/${hash}/a/wire.jsonl`)
  f.files.set(1, [p])
  assert.equal((await f.locate(1)).path, p)
  assert.equal((await f.locate(2)).path, null)
  f.processes.set(1, 'zsh')
  f.advance()
  assert.equal((await f.locate(2)).path, p)
})

test('Codex lsof tracks new rollout after TTL', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'codex')
  const a = f.write('.codex/sessions/2026/11/01/rollout-a.jsonl')
  const b = f.write('.codex/sessions/2026/11/01/rollout-b.jsonl')
  f.files.set(1, [a])
  assert.equal((await f.locate(1)).path, a)
  f.files.set(1, [b])
  f.advance()
  assert.equal((await f.locate(1)).path, b)
})

test('malformed session metadata and invalid pid return safely', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  f.write('.claude/sessions/1.json', '{')
  assert.equal((await f.locate(1)).path, null)
  assert.equal((await f.locate(-1)).agent, null)
})

test('Kimi fallback prefers first session born after startup, not adjacent older or newest writer', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'kimi')
  f.processes.set(2, 'kimi')
  const hash = crypto.createHash('md5').update(f.cwd).digest('hex')
  const a = f.write(`.kimi/sessions/${hash}/a/wire.jsonl`)
  const b = f.write(`.kimi/sessions/${hash}/b/wire.jsonl`)
  const start = Date.now() - 2000
  f.births.set(path.dirname(a), start + 962)
  f.births.set(path.dirname(b), start + 1916)
  fs.utimesSync(a, new Date(), new Date(Date.now() + 5000))
  assert.equal((await f.locate(2, start + 1000)).path, b)
  assert.equal((await f.locate(1, start)).path, a)
})

test('Kimi overlapping startup allocates distinct files independent of query order', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'kimi')
  f.processes.set(2, 'kimi')
  const hash = crypto.createHash('md5').update(f.cwd).digest('hex')
  const a = f.write(`.kimi/sessions/${hash}/a/wire.jsonl`)
  const b = f.write(`.kimi/sessions/${hash}/b/wire.jsonl`)
  const start = Math.floor(Date.now() / 1000) * 1000 - 3000
  f.births.set(path.dirname(a), start + 1257)
  f.births.set(path.dirname(b), start + 2253)
  f.peers.push({ pid: 1, startedAt: start }, { pid: 2, startedAt: start + 1000 })
  assert.equal((await f.locate(2, start + 1000)).path, b)
  assert.equal((await f.locate(1, start)).path, a)
  fs.utimesSync(a, new Date(), new Date(Date.now() + 5000))
  assert.equal((await f.locate(2, start + 1000)).path, b)
})

for (const exact of [true, false]) {
  test(`${exact ? 'exact' : 'guessed'} cache hits spawn no commands; fixed TTL refreshes at 4000 ms`, async (t) => {
    const f = await fixture(t)
    f.processes.set(1, 'claude')
    const a = f.transcript('a')
    if (exact) {
      f.session(1, 'a')
    }
    assert.equal((await f.locate(1)).path, a)
    const count = f.calls.length
    assert.ok(count > 0)
    const b = f.transcript('b')
    fs.utimesSync(b, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    if (exact) {
      f.session(1, 'b')
    }
    for (let i = 0; i < 10; i++) {
      assert.equal((await f.locate(1)).path, a)
    }
    f.advance(3999)
    assert.equal((await f.locate(1)).path, a)
    assert.equal(f.calls.length, count)
    f.advance(1)
    assert.equal((await f.locate(1)).path, b)
    assert.ok(f.calls.length > count)
  })
}

test('changed process start time invalidates a PID cache entry before TTL', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  const a = f.transcript('a'),
    b = f.transcript('b')
  f.session(1, 'a')
  assert.equal((await f.locate(1, 1000)).path, a)
  const count = f.calls.length
  f.session(1, 'b')
  assert.equal((await f.locate(1, 2000)).path, b)
  assert.ok(f.calls.length > count)
})

test('without startedAt, ps identity changes invalidate cached results', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  const a = f.transcript('a')
  f.session(1, 'a')
  const args = { pid: 1, cwd: f.cwd }
  assert.equal((await f.rawLocate(args)).path, a)
  f.processes.set(1, 'zsh')
  assert.equal((await f.rawLocate(args)).agent, null)
})

test('concurrent cache misses share one lookup', async (t) => {
  const f = await fixture(t)
  f.processes.set(1, 'claude')
  const a = f.transcript('a')
  f.session(1, 'a')
  const results = await Promise.all(Array.from({ length: 10 }, () => f.locate(1)))
  assert.ok(results.every((r) => r.path === a))
  assert.equal(f.calls.filter((c) => c.command === 'pgrep').length, 1)
})

test('Windows native process rows locate Claude child sessions without Unix subprocesses', async (t) => {
  const f = await fixture(t, 'win32')
  f.processes.set(410, 'powershell.exe')
  f.processes.set(411, 'C:\\Users\\me\\.local\\bin\\claude.exe')
  f.children.set(410, [411])
  const expected = f.transcript('windows-session')
  f.session(411, 'windows-session')
  assert.equal((await f.locate(410)).path, expected)
  assert.equal(f.calls.length, 0)
})
