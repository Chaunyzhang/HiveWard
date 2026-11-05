// 把终端里 Agent 自己写的对话记录，统一成一种「对话消息」列表。
//
// 三家各自的记录位置：
//   codex  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl      （event_msg.item_completed）
//   claude ~/.claude/projects/<cwd 里英文字母数字以外的字符（含中文）都换成 ->/<id>.jsonl   （user / assistant + content 块）
//   kimi   ~/.kimi/sessions/<md5(cwd)>/<id>/wire.jsonl        （TurnBegin / ContentPart / ToolCall / ToolResult）
//   opencode ~/.local/share/opencode/opencode.db 里的一个会话，记成「<库路径>#<会话 id>」（见 opencode-transcripts.mjs）
//
// 终端 → 记录文件：Claude 的进程会话登记优先，其次 lsof；定位结果最多缓存 4 秒。
// 无精确线索时，先排除其他活进程的记录，再按启动时间猜测。
import { runProcess } from '@hiveward/process-host'
import { pathKey } from './workspace-path.mjs'
import {
  dispatchTaskBody,
  isDispatchPreamble,
  truncatedPreambleBody,
  withoutMailNotices
} from './dispatch-prompt.mjs'
import {
  openCodeDatabasePath,
  openCodeSessions,
  openCodeSessionStamp,
  readOpenCodeMessages,
  splitOpenCodeRef
} from './opencode-transcripts.mjs'
import { createHash } from 'node:crypto'
import {
  openSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
  fstatSync,
  readdirSync,
  existsSync,
  readFileSync,
  constants
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'

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
        /\b(codex|claude|kimi|opencode)(?:\.exe|\.cmd)?\b/i
          .exec(row?.command || row?.name || '')?.[1]
          .toLowerCase() ?? null
      )
    }
    const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)])
    const m = /\b(codex|claude|kimi|opencode)\b/i.exec(stdout)
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
  // 包括从未被 HiveWard 查询过的桌面端 Claude 会话。
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

// Kimi 没有 PID 会话登记，wire 也不常开；OpenCode 的会话都在同一个库里，lsof 也认不出是哪个会话。
// 按同 cwd 的活进程共同分配候选，避免两个相邻启动的进程各自选中同一会话；这仍是启发式，不是精确归属。
// 进程名：Kimi 会改成「Kimi Code」；OpenCode 就是 opencode（桌面版 OpenCode.app 不算）
const PEER_NAMES = { kimi: /\bkimi\b/i, opencode: /(?:^|\/)opencode(?:\.exe)?$/ }
async function agentPeers(agent, cwd) {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,lstart=,comm='])
    const peers = stdout.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line)
      if (!m || !PEER_NAMES[agent].test(m[3].trim())) {
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
  if (agent === 'kimi' || agent === 'opencode') {
    const candidates =
      agent === 'kimi'
        ? kimiCandidates(cwd)
        : openCodeSessions(openCodeDatabasePath(HOME, process.env), cwd)
    return allocate(
      candidates.filter((c) => !excluded.has(c.p)),
      since,
      startedAt,
      peers,
      pids
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

function kimiCandidates(cwd) {
  const dir = join(HOME, '.kimi/sessions', createHash('md5').update(cwd).digest('hex'))
  const candidates = []
  for (const id of namesIn(dir)) {
    const p = join(dir, id, 'wire.jsonl')
    try {
      const m = statSync(p).mtimeMs
      const born = statSync(join(dir, id)).birthtimeMs
      candidates.push({ p, m, born })
    } catch {
      /* 会话可能正在创建或删除 */
    }
  }
  return candidates
}

/** 候选会话按同目录进程的启动先后依次分配：每个进程拿启动后最先出生的那个 */
function allocate(candidates, since, startedAt, peers, pids) {
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

export function transcriptSessionId(agent, path) {
  if (!path) {
    return null
  }
  if (agent === 'claude') {
    return basename(path, '.jsonl')
  }
  if (agent === 'kimi') {
    return basename(dirname(path))
  }
  if (agent === 'opencode') {
    return splitOpenCodeRef(path)?.sessionId ?? null
  }
  if (agent === 'codex') {
    try {
      const payload = JSON.parse(firstLine(path))?.payload
      return payload?.id ?? payload?.session_id ?? payload?.thread_id ?? null
    } catch {
      return null
    }
  }
  return null
}

const sessionFiles = new Map() // agent:sessionId -> 记录文件（会话 id 不会重复，找到一次就记住）

/** 在每个子目录里找 <sessionId><suffix>：坐座位时的 cwd 不一定是会话自己的目录（比如 cd 进业务目录再跑 hiwd seat） */
function findInSubdirectories(root, suffix) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const file = join(root, entry.name, suffix)
    if (entry.isDirectory() && existsSync(file)) {
      return file
    }
  }
  return null
}

/** 外部会话没有终端进程可定位，按会话 id 找它自己的记录：先按 cwd，对不上再按会话 id 全找一遍。 */
export function findSessionTranscript(agent, sessionId, cwd) {
  const key = `${agent}:${sessionId}`
  const known = sessionFiles.get(key)
  if (known && existsSync(known)) {
    return known
  }
  const file = findSessionTranscriptUncached(agent, sessionId, cwd)
  if (file) {
    sessionFiles.set(key, file)
  }
  return file
}

function findSessionTranscriptUncached(agent, sessionId, cwd) {
  agent = agent === 'claude-desktop' || agent === 'claude-code' ? 'claude' : agent
  if (
    !['claude', 'codex', 'kimi'].includes(agent) ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    /[/\\]/.test(sessionId) ||
    typeof cwd !== 'string' ||
    !cwd
  ) {
    return null
  }
  if (agent === 'claude') {
    const paths = [cwd]
    try {
      paths.push(realpathSync(cwd))
    } catch {
      /* Keep the original cwd when it no longer exists. */
    }
    for (const path of paths) {
      const file = join(
        HOME,
        '.claude/projects',
        path.replace(/[^A-Za-z0-9]/g, '-'),
        `${sessionId}.jsonl`
      )
      if (existsSync(file)) {
        return file
      }
    }
    return findInSubdirectories(join(HOME, '.claude/projects'), `${sessionId}.jsonl`)
  }
  if (agent === 'kimi') {
    const file = join(
      HOME,
      '.kimi/sessions',
      createHash('md5').update(cwd).digest('hex'),
      sessionId,
      'wire.jsonl'
    )
    return existsSync(file)
      ? file
      : findInSubdirectories(join(HOME, '.kimi/sessions'), join(sessionId, 'wire.jsonl'))
  }
  const root = join(HOME, '.codex/sessions')
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        entry.name.includes(sessionId)
      ) {
        try {
          // 文件名带着会话 id，再核对一遍记录里的 id；cwd 不强求一致（同上，坐座位时的目录可能不是会话的）
          if (transcriptSessionId('codex', path) === sessionId) {
            return path
          }
        } catch {
          /* A rollout can still be creating its first line. */
        }
      }
    }
  }
  return null
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
  // OpenCode 所有会话共用一个库，lsof 看到库开着也分不出是哪个会话
  const exact = registered ?? (agent === 'opencode' ? null : await openTranscriptOf(agent, pids))
  if (exact) {
    const identity = await processIdentity(pid)
    if (identity) {
      located.set(pid, { path: exact, identity })
    }
    // /clear 后登记可能先于 jsonl 创建；此时宁可暂空，也不读其他会话。
    return { agent, path: existsSync(exact) ? exact : null }
  }
  const excluded = await ownedElsewhere(pids)
  const peers = Object.hasOwn(PEER_NAMES, agent) ? await agentPeers(agent, cwd) : []
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
// 对话里的图片：id → 记录里的位置或本地文件；GET /api/chat-images/:id 时再读出来
const images = new Map()
const MAX_IMAGES = 5000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function imageRef(line, block, index, sub = -1) {
  const id = createHash('sha256')
    .update(`${line.path}\0${line.at}\0${index}\0${sub}`)
    .digest('hex')
    .slice(0, 32)
  images.delete(id)
  images.set(id, { ...line, index, sub })
  if (images.size > MAX_IMAGES) {
    images.delete(images.keys().next().value)
  }
  return { id, type: block.source?.media_type ?? 'image/png' }
}

function fileImageRef(item, image, line, index) {
  const id = createHash('sha256')
    .update(`file\0${line.path}\0${item.id}\0${image.path}\0${index}`)
    .digest('hex')
    .slice(0, 32)
  images.delete(id)
  images.set(id, { file: image.path, cwd: line.cwd })
  if (images.size > MAX_IMAGES) {
    images.delete(images.keys().next().value)
  }
  return { id, type: image.type }
}

function localImage(path, cwd) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    return null
  }
  const type = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!type) {
    return null
  }
  try {
    const real = realpathSync(path)
    const allowed = [cwd, '/tmp', tmpdir()].filter(Boolean).some((root) => {
      try {
        const rel = relative(realpathSync(root), real)
        return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      } catch {
        return false
      }
    })
    if (!allowed) {
      return null
    }
    const info = statSync(real)
    return info.isFile() && info.size <= MAX_IMAGE_BYTES ? { path: real, type } : null
  } catch {
    return null
  }
}

const PASTED_IMAGE = /^\[Image: source: ([^\]\n]+)\]$/

/**
 * 引擎读出的对话不带图本身，只有 Claude Code 给贴图记的「[Image: source: 路径]」：
 * 把它认成图，挂到前面老板那条消息上（像读对话记录时一样放进同一个气泡），这一行本身不显示。
 */
export function attachPastedImages(items, cwd) {
  const out = []
  for (const item of items) {
    const path = item.kind === 'user' && PASTED_IMAGE.exec(item.text?.trim() ?? '')?.[1]
    if (!path) {
      out.push(item)
      continue
    }
    const image = localImage(path, cwd)
    const owner = out.findLast((i) => i.kind === 'user')
    if (image && owner) {
      const index = owner.images?.length ?? 0
      const ref = fileImageRef(owner, image, { path: 'engine-chat', cwd }, index)
      out[out.lastIndexOf(owner)] = { ...owner, images: [...(owner.images ?? []), ref] }
    }
  }
  return out
}

/** Agent 写的本地图片：去掉标记、留下说明，图片仍按 id 延迟读取 */
function attachLocalImages(item, line) {
  const found = []
  const take = (path, alt) => {
    const image = localImage(path, line.cwd)
    if (!image) {
      return null
    }
    found.push(fileImageRef(item, image, line, (item.images?.length ?? 0) + found.length))
    return alt
  }
  let text = item.text.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, alt, target) => {
    const raw = target.trim()
    const path = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
    return take(path, alt) ?? whole
  })
  text = text
    .split('\n')
    .map((line) => take(line.trim(), '') ?? line)
    .join('\n')
  item.text = text
  if (found.length) {
    item.images = [...(item.images ?? []), ...found]
  }
}

/** 读出对话里的一张图；没登记过或复查不通过的 id 一律 404 */
export function chatImage(id) {
  const ref = images.get(id)
  const fail = () => Object.assign(new Error('图片不在了'), { status: 404, code: 'not_found' })
  if (!ref) {
    throw fail()
  }
  if (ref.file) {
    const image = localImage(ref.file, ref.cwd)
    if (!image) {
      throw fail()
    }
    let fd
    try {
      fd = openSync(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = fstatSync(fd)
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
        throw fail()
      }
      const raw = Buffer.alloc(info.size)
      let offset = 0
      while (offset < raw.length) {
        const n = readSync(fd, raw, offset, raw.length - offset, offset)
        if (!n) {
          break
        }
        offset += n
      }
      return { raw: offset === raw.length ? raw : raw.subarray(0, offset), type: image.type }
    } catch {
      throw fail()
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  }
  const buf = Buffer.alloc(ref.length)
  const fd = openSync(ref.path, 'r')
  try {
    readSync(fd, buf, 0, ref.length, ref.at)
  } finally {
    closeSync(fd)
  }
  let block
  try {
    const rec = JSON.parse(buf.toString('utf8'))
    block = rec.message?.content?.[ref.index]
    if (ref.sub >= 0) {
      block = block?.content?.[ref.sub]
    }
  } catch {
    throw fail()
  }
  const src = block?.type === 'image' ? block.source : null
  if (
    src?.type !== 'base64' ||
    typeof src.data !== 'string' ||
    !String(src.media_type).startsWith('image/')
  ) {
    throw fail()
  }
  return { raw: Buffer.from(src.data, 'base64'), type: src.media_type }
}

export function readChat(agent, path, cwd) {
  return withoutMailNotices(readChatItems(agent, path, cwd))
}

function readChatItems(agent, path, cwd) {
  if (agent === 'opencode') {
    return readOpenCodeChat(path, cwd)
  }
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
      // 每行在文件里的字节位置：对话里的图片不放进缓存，只记它在哪一行，要看时再去读
      let at = c.offset - Buffer.byteLength(c.rest)
      c.offset = size
      const lines = (c.rest + buf.toString('utf8')).split('\n')
      c.rest = lines.pop() ?? ''
      const parse = parsers[agent]
      for (const line of lines) {
        const length = Buffer.byteLength(line)
        c.line = { path, at, length, cwd }
        at += length + 1
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

const isoMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined)

/** OpenCode：库里这个会话有变化才重读最近的消息，对话项和本轮状态一起换掉 */
function readOpenCodeChat(path, cwd) {
  const stamp = openCodeSessionStamp(path)
  const cached = cache.get(path)
  // 没变，或这一轮读不到（库被锁、会话还没建）：维持上次读到的
  if (cached && (cached.stamp === stamp || stamp === null)) {
    return cached.items.slice(-MAX_ITEMS)
  }
  if (stamp === null) {
    return []
  }
  const messages = readOpenCodeMessages(path)
  const items = []
  for (const message of messages) {
    const info = message.info
    const ts = isoMs(info.time?.created)
    if (info.role === 'user') {
      // synthetic 是 OpenCode 自己补的（读进来的附件内容之类），不是老板说的话
      const text = message.parts
        .filter((p) => p.type === 'text' && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? '')
        .join('\n')
        .trim()
      if (text) {
        items.push({ id: message.id, kind: 'user', text: shownUserText(text), ts })
      }
      continue
    }
    if (info.role !== 'assistant') {
      continue
    }
    for (const part of message.parts) {
      const at = isoMs(part.time?.start) ?? ts
      const text = typeof part.text === 'string' ? part.text.trim() : ''
      if (part.type === 'reasoning' && text) {
        items.push({ id: part.id, kind: 'thinking', text, ts: at })
      } else if (part.type === 'text' && text && !part.synthetic) {
        const item = { id: part.id, kind: 'assistant', text, ts: at }
        attachLocalImages(item, { path, cwd })
        items.push(item)
      } else if (part.type === 'tool') {
        const state = part.state ?? {}
        const input = state.input ?? {}
        // OpenCode 的文件参数叫 filePath，照 HiveWard 改成通用的 file_path 再起标题
        const { kind, title } = toolTitle(
          part.tool ?? 'tool',
          typeof input.filePath === 'string' && !input.file_path
            ? { ...input, file_path: input.filePath }
            : input
        )
        items.push({
          id: part.id,
          kind: 'tool',
          tool: kind,
          title,
          output: clip(state.error ?? state.output ?? ''),
          status:
            state.status === 'completed' ? 'ok' : state.status === 'error' ? 'error' : 'running',
          ts: at
        })
      }
    }
  }
  // 本轮状态看最后一条消息：老板刚说完、还没写完、或者要接着调工具都算在干
  const last = messages.at(-1)?.info
  const turn = !last
    ? null
    : last.role === 'user'
      ? 'working'
      : last.error
        ? 'interrupted'
        : !last.time?.completed || last.finish === 'tool-calls'
          ? 'working'
          : 'completed'
  cache.set(path, { stamp, items, state: { turn } })
  return items.slice(-MAX_ITEMS)
}

export function readTurnState(agent, path, cwd) {
  readChat(agent, path, cwd)
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

/** 派单前言只显示任务正文，其余原样 */
const shownUserText = (text) => dispatchTaskBody(text) ?? text

function rememberDispatchPrompts(rec, c) {
  const content = rec.message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
  const prompts = blocks.flatMap((b) =>
    b?.type === 'text' && isDispatchPreamble(b.text) ? [b.text] : []
  )
  if (prompts.length) {
    c.state.dispatchPrompts = [...(c.state.dispatchPrompts ?? []), ...prompts].slice(-20)
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
        c.items.push({ id: it.id, kind: 'user', text: shownUserText(joinText(it.content)), ts })
        break
      case 'AgentMessage': {
        const item = { id: it.id, kind: 'assistant', text: joinText(it.content), ts }
        attachLocalImages(item, c.line)
        c.items.push(item)
        break
      }
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
    // 新版 Claude Code 把发给模型的完整原文另记一条；对话那条里的派单前言是截断的，正文要从这里取
    if (rec.type === 'api-request-blob') {
      rememberDispatchPrompts(rec, c)
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
    // 老板贴的图：和这条消息的文字放进同一个气泡
    const images = blocks.flatMap((b, i) => (b.type === 'image' ? [imageRef(c.line, b, i)] : []))
    let bubble = null
    blocks.forEach((b, i) => {
      const id = `${rec.uuid ?? ts}:${i}`
      if (b.type === 'text') {
        const text = (b.text ?? '').trim()
        // 「[Image: source: …]」是 Claude Code 给贴图记的路径，图本身已经显示了
        if (
          !text ||
          /^<(command|local-command|system-reminder)/.test(text) ||
          /^\[Image: source: [^\]]+\]$/.test(text)
        ) {
          return
        }
        // 上下文太长被压缩时塞进来的摘要不是老板说的话：包成系统消息，排成一行灰字
        const item = rec.isCompactSummary
          ? {
              id,
              kind: 'user',
              text: `<context-compacted><summary>上文太长，压缩成了一段摘要</summary><result>${text}</result></context-compacted>`,
              ts
            }
          : rec.type === 'user'
            ? {
                id,
                kind: 'user',
                text:
                  truncatedPreambleBody(text, c.state.dispatchPrompts ?? []) ?? shownUserText(text),
                ts
              }
            : { id, kind: 'assistant', text, ts }
        if (item.kind === 'assistant') {
          attachLocalImages(item, c.line)
        }
        bubble ??= item
        c.items.push(item)
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        const kind = rec.thinkingDisplay === 'updates' ? 'assistant' : 'thinking'
        c.items.push({ id, kind, text: b.thinking.trim(), ts })
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
        // 工具返回的截图（浏览器截图、读图片文件…）
        const shots = Array.isArray(b.content)
          ? b.content.flatMap((x, j) => (x?.type === 'image' ? [imageRef(c.line, x, i, j)] : []))
          : []
        if (shots.length) {
          item.images = shots
        }
      }
    })
    if (images.length && rec.type === 'user') {
      if (bubble) {
        bubble.images = images
      } else {
        c.items.push({ id: `${rec.uuid ?? ts}:images`, kind: 'user', text: '', images, ts })
      }
    }
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
    const closeOpen = () => {
      if (c.state.open?.kind === 'assistant') {
        attachLocalImages(c.state.open, c.line)
      }
      c.state.open = null
    }
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
        c.items.push({ id: n(), kind: 'user', text: shownUserText(text.trim()), ts })
        closeOpen()
        break
      }
      case 'StepBegin':
      case 'TurnEnd':
      case 'TurnInterrupted':
        closeOpen()
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
          closeOpen()
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
        closeOpen()
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
