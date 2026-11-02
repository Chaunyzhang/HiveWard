// 把终端里 Agent 自己写的对话记录，统一成一种「对话消息」列表。
//
// 三家各自的记录位置：
//   codex  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl      （event_msg.item_completed）
//   claude ~/.claude/projects/<cwd 里英文字母数字以外的字符（含中文）都换成 ->/<id>.jsonl   （user / assistant + content 块）
//   kimi   ~/.kimi/sessions/<md5(cwd)>/<id>/wire.jsonl        （TurnBegin / ContentPart / ToolCall / ToolResult）
//
// 终端 → 记录文件：Claude 的进程会话登记优先，其次 lsof；定位结果最多缓存 4 秒。
// 无精确线索时，先排除其他活进程的记录，再按启动时间猜测。
import { runProcess } from '@orca/process-host'
import { pathKey } from './workspace-path.mjs'
import { createHash } from 'node:crypto'
import {
  openSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
  readdirSync,
  existsSync,
  readFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = (program, args, options = {}) => {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('Unix process probe unavailable'))
  }
  return runProcess({
    program,
    args,
    timeoutMs: 4000,
    maxOutputBytes: options.maxBuffer ?? 1048576
  })
}
let windowsProcesses = async () => []
export function configureWindowsProcesses(read) {
  windowsProcesses = read
}
const HOME = homedir()
const MAX_ITEMS = 300
const MAX_OUTPUT = 4000

// ───────────── 定位 ─────────────

/** 进程命令行里认出是哪家 Agent */
export async function agentOfPid(pid) {
  try {
    if (process.platform === 'win32') {
      const row = (await windowsProcesses()).find((p) => p.pid === pid)
      return (
        /\b(codex|claude|kimi)(?:\.exe|\.cmd)?\b/i
          .exec(row?.command || row?.name || '')?.[1]
          .toLowerCase() ?? null
      )
    }
    const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)])
    const m = /\b(codex|claude|kimi)\b/i.exec(stdout)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * 引擎没给出前台进程 pid 时（Kimi 会把进程名改成「Kimi Code」，引擎认不到），
 * 按目录找：这个目录里正在跑的这家 Agent 进程只有一个时才认它，有多个就不猜。
 */
export async function agentPidIn(agent, cwd) {
  try {
    cwd = realpathSync(cwd)
  } catch {
    /* 目录不在了就按原路径比 */
  }
  let stdout = ''
  try {
    ;({ stdout } = await run('ps', ['-axo', 'pid=,command=']))
  } catch {
    return null
  }
  const name = new RegExp(`^\\s*(\\d+)\\s+${agent}\\b`, 'i')
  const pids = stdout
    .split('\n')
    .map((line) => name.exec(line)?.[1])
    .filter(Boolean)
    .map(Number)
  const here = []
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const { stdout: out } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
        const dir = out
          .split('\n')
          .find((l) => l.startsWith('n'))
          ?.slice(1)
        if (dir === cwd) {
          here.push(pid)
        }
      } catch {
        // 进程已经退出
      }
    })
  )
  return here.length === 1 ? here[0] : null
}

async function descendants(pid) {
  const all = [pid]
  if (process.platform === 'win32') {
    const rows = await windowsProcesses()
    for (let i = 0; i < all.length && all.length < 64; i++) {
      all.push(...rows.filter((r) => r.ppid === all[i] && !all.includes(r.pid)).map((r) => r.pid))
    }
    return all.slice(0, 64)
  }
  for (let i = 0; i < all.length && all.length < 64; i++) {
    try {
      const { stdout } = await run('pgrep', ['-P', String(all[i])])
      all.push(...stdout.split('\n').filter(Boolean).map(Number))
    } catch {
      // 没有子进程
    }
  }
  return all
}

const isTranscript = (agent, path) =>
  agent === 'codex'
    ? /\/\.codex\/sessions\/.*rollout-.*\.jsonl$/.test(path)
    : agent === 'claude'
      ? /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(path)
      : /\/\.kimi\/sessions\/[^/]+\/[^/]+\/wire\.jsonl$/.test(path)

async function openTranscriptOf(agent, pids) {
  try {
    const { stdout } = await run('lsof', ['-Fn', '-p', pids.join(',')], { maxBuffer: 8 << 20 })
    return (
      stdout
        .split('\n')
        .filter((l) => l.startsWith('n'))
        .map((l) => l.slice(1))
        .find((p) => isTranscript(agent, p)) ?? null
    )
  } catch {
    return null
  }
}

function namesIn(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function claudeSession(pid) {
  try {
    const session = JSON.parse(readFileSync(join(HOME, '.claude/sessions', `${pid}.json`), 'utf8'))
    if (
      session.pid !== pid ||
      typeof session.cwd !== 'string' ||
      typeof session.sessionId !== 'string' ||
      !/^[\w-]+$/.test(session.sessionId)
    ) {
      return null
    }
    return join(
      HOME,
      '.claude/projects',
      session.cwd.replace(/[^A-Za-z0-9]/g, '-'),
      `${session.sessionId}.jsonl`
    )
  } catch {
    return null
  }
}

async function processIdentity(pid) {
  try {
    if (process.platform === 'win32') {
      const row = (await windowsProcesses()).find((p) => p.pid === pid)
      return row?.creationTimeMs ? `${row.pid}:${row.creationTimeMs}:${row.command}` : null
    }
    const { stdout } = await run('ps', ['-o', 'lstart=,command=', '-p', String(pid)])
    return stdout.trim() || null
  } catch {
    return null
  }
}

// 只记录精确归属，用于排除；绝不把它当作 locate 的返回值缓存。
const located = new Map() // pid -> { path, identity }
async function ownedElsewhere(pids) {
  const excluded = new Set()
  await Promise.all(
    [...located].map(async ([pid, claim]) => {
      if ((await processIdentity(pid)) !== claim.identity) {
        if (located.get(pid) === claim) {
          located.delete(pid)
        }
      } else if (!pids.includes(pid)) {
        excluded.add(claim.path)
      }
    })
  )
  // 包括从未被 OPC 查询过的桌面端 Claude 会话。
  for (const name of namesIn(join(HOME, '.claude/sessions'))) {
    if (!/^\d+\.json$/.test(name)) {
      continue
    }
    const pid = Number(name.slice(0, -5))
    if (pids.includes(pid)) {
      continue
    }
    try {
      process.kill(pid, 0)
    } catch {
      continue
    }
    const path = claudeSession(pid)
    if (path) {
      excluded.add(path)
    }
  }
  return excluded
}

const newestIn = (dir, test, since, excluded) => {
  if (!existsSync(dir)) {
    return null
  }
  let best = null
  for (const name of namesIn(dir)) {
    const p = join(dir, name)
    try {
      if (excluded.has(p) || !test(p)) {
        continue
      }
      const m = statSync(p).mtimeMs
      if (m >= since && (!best || m > best.m)) {
        best = { p, m }
      }
    } catch {
      /* 文件可能在扫描期间被删除 */
    }
  }
  return best?.p ?? null
}

// Kimi 没有 PID 会话登记，wire 也不常开。按同 cwd 的活进程共同分配候选，
// 避免两个相邻启动的进程各自选中同一文件；这仍是启发式，不是精确归属。
async function kimiPeers(cwd) {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,lstart=,comm='])
    const peers = stdout.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line)
      if (!m || !/\bkimi\b/i.test(m[3])) {
        return []
      }
      const startedAt = Date.parse(m[2])
      return Number.isFinite(startedAt) ? [{ pid: Number(m[1]), startedAt }] : []
    })
    if (!peers.length) {
      return []
    }
    const result = await run('lsof', [
      '-a',
      '-d',
      'cwd',
      '-p',
      peers.map((p) => p.pid).join(','),
      '-Fpn'
    ])
    const inDirectory = new Set()
    let pid
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1))
      }
      if (line === `n${cwd}`) {
        inDirectory.add(pid)
      }
    }
    return peers
      .filter((p) => inDirectory.has(p.pid) && !located.has(p.pid))
      .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
  } catch {
    return []
  }
}

function guessTranscript(agent, cwd, since, excluded, startedAt, peers, pids) {
  if (agent === 'claude') {
    const dir = join(HOME, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    return newestIn(dir, (p) => p.endsWith('.jsonl'), since, excluded)
  }
  if (agent === 'kimi') {
    const dir = join(HOME, '.kimi/sessions', createHash('md5').update(cwd).digest('hex'))
    if (!existsSync(dir)) {
      return null
    }
    const candidates = []
    for (const id of namesIn(dir)) {
      const p = join(dir, id, 'wire.jsonl')
      if (excluded.has(p)) {
        continue
      }
      try {
        const m = statSync(p).mtimeMs
        const born = statSync(join(dir, id)).birthtimeMs
        candidates.push({ p, m, born })
      } catch {
        /* 会话可能正在创建或删除 */
      }
    }
    for (const peer of peers) {
      const eligible = candidates
        .filter((c) => c.born >= peer.startedAt)
        .sort((a, b) => a.born - b.born || a.p.localeCompare(b.p))
      const hit = eligible[0]
      if (pids.includes(peer.pid)) {
        return hit?.p ?? null
      }
      if (hit) {
        candidates.splice(candidates.indexOf(hit), 1)
      }
    }
    // ps/lsof 无法枚举同目录进程时仍可兜底，结果也只短暂缓存。
    return (
      candidates
        .filter((c) => c.m >= since)
        .sort((a, b) => {
          const distance = (c) => (startedAt && c.born >= startedAt ? c.born - startedAt : Infinity)
          return distance(a) - distance(b) || b.m - a.m
        })[0]?.p ?? null
    )
  }
  // codex：按日期目录找，读首行 session_meta.cwd 对上项目
  const d = new Date(since || Date.now())
  const dir = join(
    HOME,
    '.codex/sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  )
  return newestIn(
    dir,
    (p) => p.endsWith('.jsonl') && transcriptCwdMatches(firstLine(p), cwd),
    since,
    excluded
  )
}

export function transcriptCwdMatches(line, cwd) {
  try {
    return pathKey(JSON.parse(line)?.payload?.cwd) === pathKey(cwd)
  } catch {
    return false
  }
}

function firstLine(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8').split('\n')[0]
  } finally {
    closeSync(fd)
  }
}

const LOCATE_TTL_MS = 4_000
const locateCache = new Map() // pid -> { identity, cwd, expiresAt, promise }

/** startedAt 来自调用方的进程现场；身份变化立即失效，换会话最多延迟一个 TTL。 */
export async function locate({ pid, startedAt, cwd }) {
  try {
    cwd = realpathSync(cwd)
  } catch {
    /* Keep unavailable paths for the existing empty-result handling. */
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { agent: null, path: null }
  }
  // 正常调用有启动时间，命中时不启动任何子进程。缺失时用 ps 核验身份，
  // 不能只凭 PID 复用缓存，否则系统复用 PID 后可能读到旧进程的记录。
  const identity =
    Number.isFinite(startedAt) && startedAt > 0 ? startedAt : await processIdentity(pid)
  if (identity === null) {
    locateCache.delete(pid)
    located.delete(pid)
    return { agent: null, path: null }
  }
  const now = Date.now()
  const cached = locateCache.get(pid)
  if (cached && cached.identity === identity && cached.cwd === cwd && now < cached.expiresAt) {
    return cached.promise
  }
  for (const [key, entry] of locateCache) {
    if (now >= entry.expiresAt) {
      locateCache.delete(key)
    }
  }
  // 同时到达的 /chat 和 observeDispatches 共用一次定位；精确、猜测、空结果同 TTL。
  const entry = { identity, cwd, expiresAt: now + LOCATE_TTL_MS, promise: null }
  entry.promise = locateUncached({ pid, startedAt, cwd }).catch((error) => {
    if (locateCache.get(pid) === entry) {
      locateCache.delete(pid)
    }
    throw error
  })
  locateCache.set(pid, entry)
  return entry.promise
}

async function locateUncached({ pid, startedAt, cwd }) {
  const pids = await descendants(pid)
  let agent = null
  for (const child of pids) {
    agent = await agentOfPid(child)
    if (agent) {
      break
    }
  }
  located.delete(pid)
  if (!agent) {
    return { agent: null, path: null }
  }
  const registered = agent === 'claude' ? pids.map(claudeSession).find(Boolean) : null
  const exact = registered ?? (await openTranscriptOf(agent, pids))
  if (exact) {
    const identity = await processIdentity(pid)
    if (identity) {
      located.set(pid, { path: exact, identity })
    }
    // /clear 后登记可能先于 jsonl 创建；此时宁可暂空，也不读其他会话。
    return { agent, path: existsSync(exact) ? exact : null }
  }
  const excluded = await ownedElsewhere(pids)
  const peers = agent === 'kimi' ? await kimiPeers(cwd) : []
  return {
    agent,
    path:
      typeof cwd === 'string'
        ? guessTranscript(agent, cwd, (startedAt ?? 0) - 5_000, excluded, startedAt, peers, pids)
        : null
  }
}

// ───────────── 解析（按字节增量） ─────────────

const cache = new Map() // path -> { offset, rest, items, state }

/** 读记录文件里新增的部分，返回到目前为止的全部消息（最多 MAX_ITEMS 条）。 */
export function readChat(agent, path) {
  let c = cache.get(path)
  if (!c) {
    cache.set(path, (c = { offset: 0, rest: '', items: [], state: {} }))
  }
  const size = statSync(path).size
  if (size < c.offset) {
    Object.assign(c, { offset: 0, rest: '', items: [], state: {} })
  }
  if (size > c.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - c.offset)
      readSync(fd, buf, 0, buf.length, c.offset)
      c.offset = size
      const lines = (c.rest + buf.toString('utf8')).split('\n')
      c.rest = lines.pop() ?? ''
      const parse = parsers[agent]
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        let rec
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        parse(rec, c)
      }
      if (c.items.length > MAX_ITEMS * 2) {
        c.items = c.items.slice(-MAX_ITEMS)
      }
    } finally {
      closeSync(fd)
    }
  }
  return c.items.slice(-MAX_ITEMS)
}

export function readTurnState(agent, path) {
  readChat(agent, path)
  return cache.get(path)?.state.turn ?? null
}

const clip = (s) => (s && s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…` : s)
const joinText = (parts) => {
  if (parts == null) {
    return ''
  }
  if (typeof parts === 'string') {
    return parts.trim()
  }
  const list = Array.isArray(parts) ? parts : [parts]
  return list
    .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
    .join('')
    .trim()
}

/** 工具调用起个人话标题 */
function toolTitle(name, args) {
  const a = args ?? {}
  const cmd = a.command ?? a.cmd
  if (cmd) {
    return { kind: 'command', title: Array.isArray(cmd) ? cmd.join(' ') : String(cmd) }
  }
  const path = a.file_path ?? a.path ?? a.notebook_path
  if (path) {
    const edit = /write|edit|replace|patch|create|notebook/i.test(name)
    return { kind: edit ? 'edit' : 'read', title: `${edit ? '改' : '读'} ${path}` }
  }
  if (a.pattern) {
    return { kind: 'read', title: `${name} ${a.pattern}` }
  }
  if (a.url) {
    return { kind: 'other', title: `${name} ${a.url}` }
  }
  return { kind: 'other', title: name }
}

const parseArgs = (s) => {
  if (typeof s !== 'string') {
    return s ?? {}
  }
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

const parsers = {
  codex(rec, c) {
    const p = rec.payload
    if (rec.type === 'event_msg') {
      if (p?.type === 'task_started') {
        c.state.turn = 'working'
      }
      if (p?.type === 'task_complete') {
        c.state.turn = 'completed'
      }
      if (p?.type === 'turn_aborted') {
        c.state.turn = 'interrupted'
      }
    }
    if (rec.type !== 'event_msg' || p?.type !== 'item_completed') {
      return
    }
    const it = p.item
    const ts = rec.timestamp
    switch (it.type) {
      case 'UserMessage':
        c.state.turn = 'working'
        c.items.push({ id: it.id, kind: 'user', text: joinText(it.content), ts })
        break
      case 'AgentMessage':
        c.items.push({ id: it.id, kind: 'assistant', text: joinText(it.content), ts })
        break
      case 'Reasoning': {
        const text = (it.summary_text ?? []).join('\n').replace(/\*\*/g, '').trim()
        if (text) {
          c.items.push({ id: it.id, kind: 'thinking', text, ts })
        }
        break
      }
      case 'CommandExecution': {
        const cmd = Array.isArray(it.command)
          ? it.command[0]?.endsWith('sh') && it.command[1]?.startsWith('-')
            ? it.command.slice(2).join(' ')
            : it.command.join(' ')
          : String(it.command)
        const read = it.parsed_cmd?.length === 1 && it.parsed_cmd[0].type === 'read'
        c.items.push({
          id: it.id,
          kind: 'tool',
          tool: read ? 'read' : 'command',
          title: read ? `读 ${it.parsed_cmd[0].path ?? it.parsed_cmd[0].name}` : cmd,
          output: clip(it.aggregated_output ?? it.stdout ?? ''),
          status: it.exit_code === 0 ? 'ok' : 'error',
          ts
        })
        break
      }
      case 'FileChange': {
        const files = Object.entries(it.changes ?? {})
        const verb = { add: '新建', delete: '删除', update: '修改' }
        c.items.push({
          id: it.id,
          kind: 'tool',
          tool: 'edit',
          title: files.length === 1 ? `改 ${files[0][0]}` : `改了 ${files.length} 个文件`,
          output: files.map(([f, ch]) => `${verb[ch.type] ?? ch.type}  ${f}`).join('\n'),
          status: it.status === 'completed' ? 'ok' : 'error',
          ts
        })
        break
      }
      default:
        c.items.push({
          id: it.id,
          kind: 'tool',
          tool: 'other',
          title: it.kind ?? it.type,
          status: it.status === 'failed' ? 'error' : 'ok',
          ts
        })
    }
  },

  claude(rec, c) {
    if (rec.isSidechain || rec.isMeta) {
      return
    }
    const m = rec.message
    if (!m || (rec.type !== 'user' && rec.type !== 'assistant')) {
      return
    }
    if (rec.type === 'user' && !rec.toolUseResult) {
      c.state.turn = 'working'
    }
    if (m.stop_reason === 'end_turn') {
      c.state.turn = 'completed'
    }
    const ts = rec.timestamp
    const blocks =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    c.state.tools ??= new Map()
    blocks.forEach((b, i) => {
      const id = `${rec.uuid ?? ts}:${i}`
      if (b.type === 'text') {
        const text = (b.text ?? '').trim()
        if (!text || /^<(command|local-command|system-reminder)/.test(text)) {
          return
        }
        c.items.push({ id, kind: rec.type === 'user' ? 'user' : 'assistant', text, ts })
      } else if (b.type === 'thinking' && b.thinking) {
        c.items.push({ id, kind: 'thinking', text: b.thinking.trim(), ts })
      } else if (b.type === 'tool_use') {
        const { kind, title } = toolTitle(b.name, b.input)
        const item = { id, kind: 'tool', tool: kind, title, status: 'running', ts }
        c.state.tools.set(b.id, item)
        c.items.push(item)
      } else if (b.type === 'tool_result') {
        const item = c.state.tools.get(b.tool_use_id)
        if (!item) {
          return
        }
        const out = typeof b.content === 'string' ? b.content : joinText(b.content)
        item.output = clip(out)
        item.status = b.is_error ? 'error' : 'ok'
      }
    })
  },

  kimi(rec, c) {
    const msg = rec.message
    if (!msg) {
      return
    }
    const ts = rec.timestamp ? new Date(rec.timestamp * 1000).toISOString() : undefined
    const p = msg.payload ?? {}
    c.state.tools ??= new Map()
    const n = () => `${ts}:${c.items.length}`
    if (msg.type === 'TurnBegin') {
      c.state.turn = 'working'
    }
    if (msg.type === 'TurnEnd') {
      c.state.turn = 'completed'
    }
    if (msg.type === 'TurnInterrupted') {
      c.state.turn = 'interrupted'
    }
    switch (msg.type) {
      case 'TurnBegin': {
        const text = typeof p.user_input === 'string' ? p.user_input : joinText(p.user_input)
        c.items.push({ id: n(), kind: 'user', text: text.trim(), ts })
        c.state.open = null
        break
      }
      case 'StepBegin':
      case 'TurnEnd':
        c.state.open = null
        break
      case 'ContentPart': {
        const kind = p.type === 'think' ? 'thinking' : p.type === 'text' ? 'assistant' : null
        const piece = p.type === 'think' ? p.think : p.text
        if (!kind || !piece) {
          break
        }
        const open = c.state.open
        if (open && open.kind === kind) {
          open.text += piece
        } else {
          const item = { id: n(), kind, text: piece, ts }
          c.items.push(item)
          c.state.open = item
        }
        break
      }
      case 'ToolCall': {
        const name = p.function?.name ?? 'tool'
        const { kind, title } = toolTitle(name, parseArgs(p.function?.arguments))
        const item = { id: p.id ?? n(), kind: 'tool', tool: kind, title, status: 'running', ts }
        c.state.tools.set(p.id, item)
        c.items.push(item)
        c.state.open = null
        break
      }
      case 'ToolResult': {
        const item = c.state.tools.get(p.tool_call_id)
        if (!item) {
          break
        }
        const rv = p.return_value ?? {}
        item.output = clip(joinText(rv.output))
        item.status = rv.is_error ? 'error' : 'ok'
        break
      }
    }
  }
}
