import { pathKey } from './workspace-path.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import vm from 'node:vm'
import * as openCode from './opencode-transcripts.mjs'
import * as dispatchPrompt from './dispatch-prompt.mjs'
import { openCodeDbFixture } from './opencode-db-fixture.mjs'

async function fixture(t, platform = process.platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hiveward-transcripts-'))
  const temp = path.join(home, 'tmp')
  fs.mkdirSync(temp)
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
              .join(' ')} ${new Date(p.startedAt).getFullYear()} ${p.name ?? 'Kimi Code'}`
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
    './opencode-transcripts.mjs': openCode,
    './dispatch-prompt.mjs': dispatchPrompt,
    '@hiveward/process-host': {
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
      },
      realpathSync(file) {
        return fs.realpathSync(file === '/tmp' ? temp : file)
      }
    },
    'node:os': { homedir: () => home, tmpdir: () => temp },
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
  const transcript = (id, value = '') => write(`.claude/projects/-project-test/${id}.jsonl`, value)
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
    readChat: source.namespace.readChat,
    readTurnState: source.namespace.readTurnState,
    transcriptSessionId: source.namespace.transcriptSessionId,
    chatImage: source.namespace.chatImage,
    attachPastedImages: source.namespace.attachPastedImages,
    temp,
    findSession: (agent, id, path = cwd) => source.namespace.findSessionTranscript(agent, id, path),
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

test('外部会话按 sessionId 找 Claude / Codex / Kimi 记录，cwd 对不上也能找到', async (t) => {
  const f = await fixture(t)
  const claude = f.transcript('claude-seat')
  const codex = f.write(
    '.codex/sessions/2026/11/02/rollout-2026-11-02T10-00-00-codex-seat.jsonl',
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-seat', cwd: f.cwd } })}\n`
  )
  const kimi = f.write(
    `.kimi/sessions/${crypto.createHash('md5').update(f.cwd).digest('hex')}/kimi-seat/wire.jsonl`
  )
  assert.equal(f.findSession('claude-desktop', 'claude-seat'), claude)
  assert.equal(f.findSession('codex', 'codex-seat'), codex)
  assert.equal(f.findSession('kimi', 'kimi-seat'), kimi)
  // 坐座位时的目录可能不是会话自己的目录：按会话 id 兜底
  assert.equal(f.findSession('claude', 'claude-seat', '/other'), claude)
  assert.equal(f.findSession('codex', 'codex-seat', '/other'), codex)
  assert.equal(f.findSession('kimi', 'kimi-seat', '/other'), kimi)
  assert.equal(f.findSession('claude', 'missing-seat', '/other'), null)
  assert.equal(f.findSession('claude', '../escape'), null)
  console.log(
    'ACCEPT session lookup: Claude/Codex/Kimi by id, wrong cwd falls back to id; missing/malformed id rejected'
  )
})

const png = Buffer.from('89504e470d0a1a0a', 'hex')
const jsonl = (rec) => `${JSON.stringify(rec)}\n`

test('Claude：assistant 的 Markdown 本地图片挂到消息，正文只留下说明', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const image = f.write('work/page.png', png)
  const transcript = f.transcript(
    'claude-local-image',
    jsonl({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `给你看：\n![首页](${image})\n已经截好了` }]
      }
    })
  )
  const items = f.readChat('claude', transcript, work)
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '给你看：\n首页\n已经截好了')
  assert.equal(items[0].images.length, 1)
  const result = f.chatImage(items[0].images[0].id)
  assert.equal(result.type, 'image/png')
  assert.equal(result.raw.equals(png), true)
})

test('Codex：assistant 单独一行的本地绝对图片路径也能显示', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const image = f.write('work/codex.jpg', png)
  const transcript = f.write(
    'codex-local-image.jsonl',
    jsonl({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          id: 'a1',
          type: 'AgentMessage',
          content: [{ type: 'text', text: `截图如下\n${image}` }]
        }
      }
    })
  )
  const items = f.readChat('codex', transcript, work)
  assert.equal(items[0].text.trim(), '截图如下')
  assert.equal(items[0].text.includes(image), false)
  assert.equal(items[0].images.length, 1)
  assert.equal(f.chatImage(items[0].images[0].id).type, 'image/jpeg')
})

test('Kimi：跨 ContentPart 的图片语法在拼接后识别并去掉', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const image = f.write('work/kimi.webp', png)
  const part = (text) =>
    jsonl({ message: { type: 'ContentPart', payload: { type: 'text', text } } })
  const transcript = f.write(
    'kimi-local-image.jsonl',
    part('看这张图：![效果](') + part(`${image})`) + jsonl({ message: { type: 'TurnEnd' } })
  )
  const items = f.readChat('kimi', transcript, work)
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '看这张图：效果')
  assert.equal(items[0].images.length, 1)
  assert.equal(f.chatImage(items[0].images[0].id).type, 'image/webp')
})

test('本地图片越权路径和不存在的文件都不挂到消息', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const outside = f.write('outside.png', png)
  const missing = path.join(work, 'missing.png')
  const transcript = f.transcript(
    'claude-rejected-images',
    jsonl({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `越权 ![秘密](${outside})` },
          { type: 'text', text: `不存在 ![缺图](${missing})` }
        ]
      }
    })
  )
  const items = f.readChat('claude', transcript, work)
  assert.equal(items.length, 2)
  assert.ok(items.every((item) => !item.images))
  assert.equal(items[0].text.includes(outside), true)
  assert.equal(items[1].text.includes(missing), true)
})

test('本地图片读取时复查，登记后文件被删掉就返回 404', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const image = f.write('work/removed.png', png)
  const transcript = f.transcript(
    'claude-removed-image',
    jsonl({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: `![截图](${image})` }] }
    })
  )
  const [item] = f.readChat('claude', transcript, work)
  const id = item.images[0].id
  fs.rmSync(image)
  assert.throws(
    () => f.chatImage(id),
    (error) => error.status === 404
  )
})

test('Claude 桌面端 updates 旁白按正文显示，summarized 仍是思考', async (t) => {
  const f = await fixture(t)
  const transcript = f.transcript(
    'claude-thinking-display',
    jsonl({
      type: 'assistant',
      uuid: 'updates',
      thinkingDisplay: 'updates',
      timestamp: '2026-11-03T01:02:03.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '我正在查找…接下来会确认…' },
          { type: 'thinking', thinking: '  ' }
        ]
      }
    }) +
      jsonl({
        type: 'assistant',
        uuid: 'summarized',
        thinkingDisplay: 'summarized',
        timestamp: '2026-11-03T01:02:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '整理思路' }]
        }
      })
  )
  const items = f.readChat('claude', transcript, f.cwd)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'updates:0')
  assert.equal(items[0].kind, 'assistant')
  assert.equal(items[0].text, '我正在查找…接下来会确认…')
  assert.equal(items[0].ts, '2026-11-03T01:02:03.000Z')
  assert.equal(items[1].id, 'summarized:0')
  assert.equal(items[1].kind, 'thinking')
  assert.equal(items[1].text, '整理思路')
  assert.equal(items[1].ts, '2026-11-03T01:02:04.000Z')
})

// vm 里出来的对象原型不同，转成普通 JSON 再比
const plain = (value) => JSON.parse(JSON.stringify(value))

test('OpenCode：同目录多个进程按启动先后分到各自的会话，子代理和别的目录的会话不算', async (t) => {
  const f = await fixture(t)
  const dbPath = path.join(f.home, '.local/share/opencode/opencode.db')
  const db = openCodeDbFixture(dbPath)
  t.after(() => db.close())
  const start = Date.now() - 2000
  f.processes.set(1, 'opencode --auto --model opencode-go/deepseek-v4.1-flash')
  f.processes.set(2, 'opencode --auto --model opencode-go/deepseek-v4.1-flash')
  f.peers.push(
    { pid: 1, startedAt: start, name: 'opencode' },
    // 桌面版 OpenCode.app 的进程不算同目录的 OpenCode 下属
    { pid: 3, startedAt: start, name: '/Applications/OpenCode.app/Contents/MacOS/OpenCode' },
    { pid: 2, startedAt: start + 1000, name: 'opencode' }
  )
  db.session('ses_old', f.cwd, start - 60_000)
  db.session('ses_a', f.cwd, start + 900)
  db.session('ses_child', f.cwd, start + 950, { parent: 'ses_a' })
  db.session('ses_b', f.cwd, start + 1900)
  db.session('ses_elsewhere', '/project/other', start + 1950)
  const a = openCode.openCodeRef(dbPath, 'ses_a')
  const b = openCode.openCodeRef(dbPath, 'ses_b')
  assert.deepEqual(plain(await f.locate(2, start + 1000)), { agent: 'opencode', path: b })
  assert.deepEqual(plain(await f.locate(1, start)), { agent: 'opencode', path: a })
  assert.equal(f.transcriptSessionId('opencode', b), 'ses_b')
  // 所有会话共用一个库，不用 lsof 去找「开着的记录文件」
  assert.ok(!f.calls.some((c) => c.command === 'lsof' && c.args[0] === '-Fn'))
})

test('OpenCode：库里的消息读成对话，最后一条决定这一轮在干还是做完了', async (t) => {
  const f = await fixture(t)
  const dbPath = path.join(f.home, '.local/share/opencode/opencode.db')
  const db = openCodeDbFixture(dbPath)
  t.after(() => db.close())
  db.session('ses_1', f.cwd, 1)
  const ref = openCode.openCodeRef(dbPath, 'ses_1')
  const brief = '改一下 money.ts\n\n（HiveWard：要上外部网站时…）'
  db.message('ses_1', 'msg_1', { role: 'user' }, [
    { type: 'text', text: brief },
    { type: 'text', text: '<file>读进来的附件内容</file>', synthetic: true }
  ])
  db.message(
    'ses_1',
    'msg_2',
    { role: 'assistant', finish: 'tool-calls', time: { created: 2000, completed: 2100 } },
    [
      { type: 'step-start' },
      { type: 'reasoning', text: '先看看文件' },
      {
        type: 'tool',
        tool: 'read',
        callID: 'call_1',
        state: {
          status: 'completed',
          input: { filePath: '/project/test/money.ts' },
          output: 'export {}'
        }
      },
      {
        type: 'tool',
        tool: 'bash',
        callID: 'call_2',
        state: { status: 'error', input: { command: 'npm test' }, error: 'exit 1' }
      },
      { type: 'step-finish', reason: 'tool-calls' }
    ]
  )
  const items = f.readChat('opencode', ref, f.cwd)
  assert.deepEqual(
    plain(
      items.map(({ kind, text, tool, title, output, status }) => ({
        kind,
        text,
        tool,
        title,
        output,
        status
      }))
    ),
    [
      { kind: 'user', text: brief },
      { kind: 'thinking', text: '先看看文件' },
      {
        kind: 'tool',
        tool: 'read',
        title: '读 /project/test/money.ts',
        output: 'export {}',
        status: 'ok'
      },
      { kind: 'tool', tool: 'command', title: 'npm test', output: 'exit 1', status: 'error' }
    ]
  )
  // 要接着调工具：还在干
  assert.equal(f.readTurnState('opencode', ref, f.cwd), 'working')

  db.message(
    'ses_1',
    'msg_3',
    { role: 'assistant', finish: 'stop', time: { created: 3000, completed: 3100 } },
    [{ type: 'text', text: '改好了，测试通过。' }]
  )
  assert.equal(f.readChat('opencode', ref, f.cwd).at(-1).text, '改好了，测试通过。')
  assert.equal(f.readTurnState('opencode', ref, f.cwd), 'completed')

  db.message('ses_1', 'msg_4', { role: 'user' }, [{ type: 'text', text: '再加一个用例' }])
  assert.equal(f.readTurnState('opencode', ref, f.cwd), 'working')
  db.message('ses_1', 'msg_5', {
    role: 'assistant',
    error: { name: 'MessageAbortedError' },
    time: { created: 5000 }
  })
  assert.equal(f.readTurnState('opencode', ref, f.cwd), 'interrupted')
})

test('OpenCode：库不在或会话引用不对时读成空，不抛错', async (t) => {
  const f = await fixture(t)
  const missing = openCode.openCodeRef(
    path.join(f.home, '.local/share/opencode/opencode.db'),
    'ses_x'
  )
  assert.deepEqual(plain(f.readChat('opencode', missing, f.cwd)), [])
  assert.equal(f.readTurnState('opencode', missing, f.cwd), null)
  assert.equal(openCode.splitOpenCodeRef('/tmp/other.db#ses_x'), null)
  assert.deepEqual(openCode.splitOpenCodeRef('/data/opencode.db#ses_x'), {
    dbPath: '/data/opencode.db',
    sessionId: 'ses_x'
  })
  assert.equal(
    openCode.openCodeDatabasePath('/home/a', {}),
    '/home/a/.local/share/opencode/opencode.db'
  )
  assert.equal(
    openCode.openCodeDatabasePath('/home/a', {
      XDG_DATA_HOME: '/xdg',
      OPENCODE_DB: 'opencode-dev.db'
    }),
    '/xdg/opencode/opencode-dev.db'
  )
  assert.equal(openCode.openCodeDatabasePath('/home/a', { OPENCODE_DB: ':memory:' }), null)
})

const dispatchPreamble = (task) =>
  [
    'Please carry out this task from my HiveWard coordinator by following the brief I pasted below. You are working inside HiveWard, a multi-agent IDE. You are a dispatched worker.',
    'Your task ID is: task_1',
    '',
    '=== CLI COMMANDS ===',
    '  hiveward orchestration ask --from term_x --question "<your question>"',
    '---',
    '',
    '=== TASK ===',
    task
  ].join('\n')

test('Claude：派单前言只显示任务正文，收消息提示不显示；对话记录截断时从完整原文里取', async (t) => {
  const f = await fixture(t)
  const work = path.join(f.home, 'work')
  const full = dispatchPreamble('把浏览器打开，我要登上腾讯文档')
  const truncated = `${full.slice(0, 120)}\n… (truncated)`
  const transcript = f.transcript(
    'claude-dispatch-preamble',
    jsonl({
      type: 'api-request-blob',
      message: { role: 'user', content: [{ type: 'text', text: full }] }
    }) +
      jsonl({ type: 'user', uuid: 'u1', message: { role: 'user', content: truncated } }) +
      jsonl({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: dispatchPreamble('测试：只回一句收到') }
      }) +
      jsonl({
        type: 'user',
        uuid: 'n1',
        message: {
          role: 'user',
          content:
            '\nYou have 1 orchestration message. Run `hiveward orchestration check --run run_1`.\n'
        }
      }) +
      jsonl({ type: 'user', uuid: 'u3', message: { role: 'user', content: '普通的一句话' } })
  )
  const items = f.readChat('claude', transcript, work)
  assert.deepEqual(
    Array.from(items, (i) => [i.kind, i.text]),
    [
      ['user', '把浏览器打开，我要登上腾讯文档'],
      ['user', '测试：只回一句收到'],
      ['user', '普通的一句话']
    ]
  )
})

test('派单前言：没有单独成行的 === TASK === 或不是派单开头时原样不动', () => {
  assert.equal(dispatchPrompt.dispatchTaskBody('普通的话 === TASK === 不算'), undefined)
  assert.equal(
    dispatchPrompt.dispatchTaskBody(
      'You are working inside HiveWard, a multi-agent IDE.\n提交标题 === TASK === 引用'
    ),
    undefined
  )
  assert.equal(
    dispatchPrompt.dispatchTaskBody(
      '<pasted_content id="1">\nYou are working inside HiveWard, a multi-agent IDE.\n=== TASK ===\n正文\n</pasted_content>'
    ),
    '正文'
  )
})

test('引擎读出的对话：Claude Code 记的贴图路径挂到老板那条消息上，这一行不显示', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.temp, 'hiveward-paste-1.png')
  fs.writeFileSync(file, png)
  const items = f.attachPastedImages(
    [
      { id: 'u1', kind: 'user', text: '[Image #1] 这是什么？' },
      { id: 'u2', kind: 'user', text: `[Image: source: ${file}]` },
      { id: 'u3', kind: 'user', text: '[Image: source: /etc/passwd.png]' },
      { id: 'a1', kind: 'assistant', text: '一颗心' }
    ],
    '/project/test'
  )
  assert.deepEqual(
    Array.from(items, (i) => [i.id, i.images?.length ?? 0]),
    [
      ['u1', 1],
      ['a1', 0]
    ]
  )
  assert.equal(f.chatImage(items[0].images[0].id).type, 'image/png')
})
