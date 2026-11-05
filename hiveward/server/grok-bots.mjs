import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_PATH = '/Applications/Grok Bot.app'
const STATUS_FILE = 'desktop-status.json'
const PERSISTENCE_DIR = 'sand-client-persistence'
const ACCOUNT_SLOT_KEY = 'sand.client.slice.client-meta.account-slot'
const ROSTER_KEY = /^sand\.client\.slice\.account\.(.+)\.roster\.last-roster$/
const TRANSCRIPT_KEY = /^sand\.client\.slice\.account\.(.+)\.transcript\.replicas\.(.+)$/
const BASE32_FILE = /^[a-z2-7]+\.blob$/
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const DEFAULT_SHAPES = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop']
const DEFAULT_COLORS = [
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray'
]
const SHAPES = new Set([
  'blob',
  'pebble',
  'bean',
  'egg',
  'squircle',
  'tablet',
  'capsule',
  'cylinder',
  'hex',
  'gem',
  'crystal',
  'wedge',
  'shield',
  'dome',
  'arch',
  'cloud',
  'teardrop',
  'leaf',
  'square',
  'sparkle',
  'clover',
  'flower',
  'heart',
  'house',
  'star',
  'pumpkin'
])
const COLORS = new Set(['black', ...DEFAULT_COLORS])
const GOLDEN = 2654435769
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code })

function fnv(s) {
  let t = 2166136261
  for (let i = 0; i < s.length; i++) {
    t ^= s.charCodeAt(i)
    t = Math.imul(t, 16777619)
  }
  return t >>> 0
}

function mix(s) {
  let t = fnv(s) | 0
  t = Math.imul(t ^ (t >>> 16), 73244475)
  t = Math.imul(t ^ (t >>> 13), 3266489909)
  return (t ^ (t >>> 16)) >>> 0
}

function rng(seed) {
  let t = seed >>> 0
  return () => {
    t = (t + 1831565813) | 0
    let e = Math.imul(t ^ (t >>> 15), 1 | t)
    e = (e + Math.imul(e ^ (e >>> 7), 61 | e)) ^ e
    return ((e ^ (e >>> 14)) >>> 0) / 4294967296
  }
}

export const defaultGrokBotShape = (id) => DEFAULT_SHAPES[mix(id) % DEFAULT_SHAPES.length]
export const defaultGrokBotColor = (id) => {
  const h = (fnv(id) ^ Math.imul(1, GOLDEN)) >>> 0
  return DEFAULT_COLORS[Math.floor(rng((h ^ Math.imul(1, GOLDEN)) >>> 0)() * DEFAULT_COLORS.length)]
}

function dataDirectory() {
  return (
    process.env.HIVEWARD_GROK_DATA_DIR || join(homedir(), 'Library/Application Support/Grok Bot')
  )
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function decodeBlobKey(file) {
  let bits = 0
  let value = 0
  const bytes = []
  for (const char of file.slice(0, -'.blob'.length)) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

async function cacheFiles(directory) {
  const persistence = join(directory, PERSISTENCE_DIR)
  let files
  try {
    files = await readdir(persistence)
  } catch {
    return []
  }
  return files
    .filter((file) => BASE32_FILE.test(file))
    .map((file) => ({ file, key: decodeBlobKey(file), path: join(persistence, file) }))
}

async function readRoster(directory) {
  const files = await cacheFiles(directory)
  const rosters = []
  for (const entry of files) {
    const match = ROSTER_KEY.exec(entry.key)
    if (!match) {
      continue
    }
    try {
      const info = await stat(entry.path)
      rosters.push({ ...entry, account: match[1], mtimeMs: info.mtimeMs })
    } catch {}
  }
  let selected
  const slot = files.find((entry) => entry.key === ACCOUNT_SLOT_KEY)
  const slotJson = slot ? await readJson(slot.path) : undefined
  if (typeof slotJson?.value === 'string') {
    selected = rosters.find((entry) => entry.account === slotJson.value)
  }
  selected ??= rosters.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  const json = selected ? await readJson(selected.path) : undefined
  const rows = Array.isArray(json?.value?.rows) ? json.value.rows : []
  return { files, account: selected?.account, bots: rows.map(botFromRow).filter(Boolean) }
}

function iso(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined
  }
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return undefined
  }
}

function preview(text) {
  if (typeof text !== 'string') {
    return undefined
  }
  const oneLine = text.replaceAll('**', '').replaceAll('`', '').replace(/\s+/g, ' ').trim()
  return oneLine ? Array.from(oneLine).slice(0, 200).join('') : undefined
}

function botFromRow(row) {
  const createdAt = iso(row?.createdAt)
  if (
    row?.isRemovedFromSidebar === true ||
    typeof row?.id !== 'string' ||
    typeof row?.name !== 'string' ||
    !createdAt
  ) {
    return undefined
  }
  return {
    id: row.id,
    name: row.name,
    description:
      typeof row.description === 'string' && row.description ? row.description : undefined,
    shape: SHAPES.has(row.avatarShape) ? row.avatarShape : defaultGrokBotShape(row.id),
    color: COLORS.has(row.avatarColor) ? row.avatarColor : defaultGrokBotColor(row.id),
    createdAt,
    lastActivityAt: iso(row.lastActivityAt),
    unreadCount:
      typeof row.unreadCount === 'number' && Number.isFinite(row.unreadCount) ? row.unreadCount : 0,
    awaitingYou: !!row.awaitingUserResponse,
    lastMessage: preview(row.lastEntry?.text),
    voice: typeof row.voiceId === 'string' && row.voiceId ? row.voiceId : undefined
  }
}

function sortBots(bots) {
  return bots.sort((a, b) => {
    if ((a.name === 'Grok Bot') !== (b.name === 'Grok Bot')) {
      return a.name === 'Grok Bot' ? -1 : 1
    }
    return (
      (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0) -
      (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0)
    )
  })
}

function running(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function listGrokBots(directory = dataDirectory()) {
  const [status, roster] = await Promise.all([
    readJson(join(directory, STATUS_FILE)),
    readRoster(directory)
  ])
  return {
    installed: existsSync(APP_PATH) || existsSync(directory),
    running: running(status?.pid),
    signedIn: status?.signedIn === true,
    bots: sortBots(roster.bots)
  }
}

function messageFromEntry(entry) {
  const at = iso(entry?.timestampMs)
  if (typeof entry?.id !== 'string' || !at) {
    return undefined
  }
  const base = { id: entry.id, at }
  if (
    entry.kind === 'message' &&
    (entry.role === 'user' || entry.role === 'assistant') &&
    typeof entry.content === 'string'
  ) {
    return {
      ...base,
      from: entry.role === 'user' ? 'you' : 'bot',
      kind: 'text',
      text: entry.content
    }
  }
  if (
    entry.kind === 'send-message' &&
    entry.message?.type === 'text' &&
    typeof entry.message.content === 'string'
  ) {
    return { ...base, from: 'bot', kind: 'text', text: entry.message.content }
  }
  if (
    entry.kind === 'send-message' &&
    entry.message?.type === 'widget' &&
    typeof entry.message.widget?.prompt === 'string'
  ) {
    const options = Array.isArray(entry.message.widget.options)
      ? entry.message.widget.options
          .map((option) => option?.label)
          .filter((label) => typeof label === 'string')
      : []
    return { ...base, from: 'bot', kind: 'choice', text: entry.message.widget.prompt, options }
  }
  if (entry.kind === 'user-attachment' && typeof entry.file_name === 'string') {
    const name = entry.file_name.split(/[\\/]/).findLast(Boolean)
    return name ? { ...base, from: 'you', kind: 'attachment', text: name } : undefined
  }
  if (entry.kind === 'voice-call') {
    const description = entry.call?.description
    const durationMs = entry.call?.durationMs
    const minutes =
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? Math.round(durationMs / 60000)
        : 0
    return {
      ...base,
      from: 'bot',
      kind: 'call',
      text:
        typeof description === 'string' && description ? description : `语音通话 ${minutes} 分钟`
    }
  }
  return undefined
}

function messageLimit(value) {
  if (value === null || value === undefined) {
    return 50
  }
  const limit = Number(value)
  if (value === '' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw httpError(400, 'bad_request', 'limit 必须是 1 到 200 的整数')
  }
  return limit
}

export async function listGrokBotMessages(directory, id, limit = 50) {
  const roster = await readRoster(directory)
  if (!roster.bots.some((bot) => bot.id === id)) {
    throw httpError(404, 'not_found', 'Grok Bot 不存在')
  }
  const transcript = roster.files.find((entry) => {
    const match = TRANSCRIPT_KEY.exec(entry.key)
    return match?.[1] === roster.account && match?.[2] === id
  })
  const json = transcript ? await readJson(transcript.path) : undefined
  const entries = Array.isArray(json?.value?.entries) ? json.value.entries : []
  return { messages: entries.map(messageFromEntry).filter(Boolean).slice(-limit) }
}

function localOnly(handler) {
  return async (req, params, url, context) => {
    if (context?.isLan || req.headers['x-hiveward-caller'] === 'agent') {
      throw httpError(403, 'forbidden', 'Grok Bot 数据只能由老板直接在本机查看')
    }
    return handler(req, params, url)
  }
}

export function checkGrokBotForward(_req, url) {
  if (/^\/api\/m\/[^/]+\/(?:api\/)?grok\/bots(?:\/|$)/.test(url.pathname)) {
    throw httpError(403, 'forbidden', 'Grok Bot 数据只能由老板直接在本机查看')
  }
}

export const grokBotRoutes = [
  ['GET', /^\/api\/grok\/bots$/, localOnly(async () => listGrokBots())],
  [
    'GET',
    /^\/api\/grok\/bots\/([^/]+)\/messages$/,
    localOnly(async (_req, [id], url) =>
      listGrokBotMessages(dataDirectory(), id, messageLimit(url.searchParams.get('limit')))
    )
  ]
]
