import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkGrokBotForward,
  defaultGrokBotColor,
  defaultGrokBotShape,
  grokBotRoutes,
  listGrokBotMessages,
  listGrokBots
} from './grok-bots.mjs'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ACCOUNT = 'grok%7Cuser_fixture'
const MAIN_CREATED = Date.UTC(2025, 0, 1)

function blobName(key) {
  let bits = 0
  let value = 0
  let encoded = ''
  for (const byte of Buffer.from(key)) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      encoded += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits) {
    encoded += ALPHABET[(value << (5 - bits)) & 31]
  }
  return `${encoded}.blob`
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hiveward-grok-bots-'))
  await mkdir(join(directory, 'sand-client-persistence'), { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeBlob(directory, key, value) {
  await writeFile(
    join(directory, 'sand-client-persistence', blobName(key)),
    JSON.stringify({ value })
  )
}

async function writeRoster(directory, rows, account = ACCOUNT) {
  await writeBlob(directory, `sand.client.slice.account.${account}.roster.last-roster`, { rows })
}

function row(id, name, lastActivityAt, extra = {}) {
  return {
    id,
    name,
    description: '',
    createdAt: MAIN_CREATED,
    lastActivityAt,
    unreadCount: 0,
    ...extra
  }
}

async function callRoute(path, { agent = false, isLan = false } = {}) {
  const url = new URL(path, 'http://127.0.0.1')
  const route = grokBotRoutes.find(
    ([method, pattern]) => method === 'GET' && pattern.test(url.pathname)
  )
  assert.ok(route)
  const params = route[1].exec(url.pathname).slice(1).map(decodeURIComponent)
  return route[2]({ headers: agent ? { 'x-hiveward-caller': 'agent' } : {} }, params, url, {
    isLan
  })
}

async function closeHttp(server) {
  if (!server) {
    return
  }
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
}

test('default Grok Bot shapes and colors match fixed reference vectors', () => {
  const vectors = [
    ['bot-alpha', 'wedge', 'cyan'],
    ['bot-beta', 'teardrop', 'yellow'],
    ['grok-main', 'teardrop', 'green'],
    ['bot-🚀', 'cloud', 'blue']
  ]
  for (const [id, shape, color] of vectors) {
    assert.equal(defaultGrokBotShape(id), shape)
    assert.equal(defaultGrokBotColor(id), color)
  }
})

test('bot list maps, sorts and previews roster rows', async (t) => {
  const directory = await fixture(t)
  await writeFile(
    join(directory, 'desktop-status.json'),
    JSON.stringify({ pid: process.pid, appVersion: 'fixture', signedIn: true })
  )
  await writeRoster(directory, [
    row('bot-beta', 'Beta', 2000),
    row('removed', 'Removed', 9000, { isRemovedFromSidebar: true }),
    row('bot-alpha', 'Alpha', 3000, {
      description: 'Alpha description',
      unreadCount: 4,
      voiceId: null,
      lastEntry: { text: 'x'.repeat(205) }
    }),
    row('grok-main', 'Grok Bot', 1000, {
      avatarShape: 'heart',
      avatarColor: 'black',
      awaitingUserResponse: true,
      voiceId: 'liora',
      lastEntry: { text: '  **Main** `line`\npreview  ' }
    }),
    { name: 'Missing id', createdAt: MAIN_CREATED }
  ])
  const result = await listGrokBots(directory)
  assert.equal(result.installed, true)
  assert.equal(result.running, true)
  assert.equal(result.signedIn, true)
  assert.deepEqual(
    result.bots.map((bot) => bot.id),
    ['grok-main', 'bot-alpha', 'bot-beta']
  )
  const [main, alpha, beta] = result.bots
  assert.equal(main.shape, 'heart')
  assert.equal(main.color, 'black')
  assert.equal(main.createdAt, new Date(MAIN_CREATED).toISOString())
  assert.equal(main.lastActivityAt, new Date(1000).toISOString())
  assert.equal(main.awaitingYou, true)
  assert.equal(main.lastMessage, 'Main line preview')
  assert.equal(main.voice, 'liora')
  assert.equal(main.description, undefined)
  assert.equal(alpha.shape, 'wedge')
  assert.equal(alpha.color, 'cyan')
  assert.equal(alpha.unreadCount, 4)
  assert.equal(alpha.awaitingYou, false)
  assert.equal(alpha.lastMessage.length, 200)
  assert.equal(alpha.voice, undefined)
  assert.equal(beta.shape, 'teardrop')
  assert.equal(beta.color, 'yellow')
})

test('current account wins, otherwise the newest roster wins', async (t) => {
  const directory = await fixture(t)
  const currentKey = `sand.client.slice.account.${ACCOUNT}.roster.last-roster`
  const otherKey = 'sand.client.slice.account.grok%7Cuser_other.roster.last-roster'
  await writeRoster(directory, [row('current', 'Current', 1000)])
  await writeBlob(directory, otherKey, { rows: [row('other', 'Other', 2000)] })
  await writeBlob(directory, 'sand.client.slice.client-meta.account-slot', ACCOUNT)
  const old = new Date('2025-01-01T00:00:00Z')
  const recent = new Date('2025-02-01T00:00:00Z')
  await utimes(join(directory, 'sand-client-persistence', blobName(currentKey)), old, old)
  await utimes(join(directory, 'sand-client-persistence', blobName(otherKey)), recent, recent)
  assert.deepEqual(
    (await listGrokBots(directory)).bots.map((bot) => bot.id),
    ['current']
  )
  await rm(
    join(
      directory,
      'sand-client-persistence',
      blobName('sand.client.slice.client-meta.account-slot')
    )
  )
  assert.deepEqual(
    (await listGrokBots(directory)).bots.map((bot) => bot.id),
    ['other']
  )
})

test('transcript entries map all supported message kinds and apply limit after filtering', async (t) => {
  const directory = await fixture(t)
  await writeRoster(directory, [row('bot-alpha', 'Alpha', 1000)])
  const at = 1700000000000
  const entries = [
    { id: 'user', kind: 'message', role: 'user', content: 'question', timestampMs: at },
    { id: 'assistant', kind: 'message', role: 'assistant', content: 'answer', timestampMs: at + 1 },
    {
      id: 'text',
      kind: 'send-message',
      message: { type: 'text', content: '**bold** `code`' },
      timestampMs: at + 2
    },
    {
      id: 'choice',
      kind: 'send-message',
      message: {
        type: 'widget',
        widget: { prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }
      },
      timestampMs: at + 3
    },
    {
      id: 'attachment',
      kind: 'user-attachment',
      file_name: '/private/folder/report.pdf',
      timestampMs: at + 4
    },
    {
      id: 'call-description',
      kind: 'voice-call',
      call: { description: 'Call summary', durationMs: 60000 },
      timestampMs: at + 5
    },
    { id: 'call-duration', kind: 'voice-call', call: { durationMs: 120000 }, timestampMs: at + 6 },
    { id: 'event', kind: 'event', timestampMs: at + 7 },
    {
      id: 'permission',
      kind: 'send-message',
      message: { type: 'local-tool-permission' },
      timestampMs: at + 8
    },
    { id: 'other-role', kind: 'message', role: 'system', content: 'skip', timestampMs: at + 9 }
  ]
  await writeBlob(directory, `sand.client.slice.account.${ACCOUNT}.transcript.replicas.bot-alpha`, {
    entries
  })
  const result = await listGrokBotMessages(directory, 'bot-alpha', 20)
  assert.deepEqual(
    result.messages.map((message) => [message.id, message.from, message.kind, message.text]),
    [
      ['user', 'you', 'text', 'question'],
      ['assistant', 'bot', 'text', 'answer'],
      ['text', 'bot', 'text', '**bold** `code`'],
      ['choice', 'bot', 'choice', 'Pick one'],
      ['attachment', 'you', 'attachment', 'report.pdf'],
      ['call-description', 'bot', 'call', 'Call summary'],
      ['call-duration', 'bot', 'call', '语音通话 2 分钟']
    ]
  )
  assert.deepEqual(result.messages[3].options, ['A', 'B'])
  assert.equal(result.messages[0].at, new Date(at).toISOString())
  assert.deepEqual(
    (await listGrokBotMessages(directory, 'bot-alpha', 3)).messages.map((message) => message.id),
    ['attachment', 'call-description', 'call-duration']
  )
})

test('message limit defaults to 50 and missing or malformed data stays nonfatal', async (t) => {
  const directory = await fixture(t)
  await writeRoster(directory, [row('bot-alpha', 'Alpha', 1000)])
  const entries = Array.from({ length: 55 }, (_, index) => ({
    id: `m${index}`,
    kind: 'message',
    role: 'user',
    content: 'fixture',
    timestampMs: 1700000000000 + index
  }))
  const transcriptKey = `sand.client.slice.account.${ACCOUNT}.transcript.replicas.bot-alpha`
  await writeBlob(directory, transcriptKey, { entries })
  const defaultPage = await listGrokBotMessages(directory, 'bot-alpha')
  assert.equal(defaultPage.messages.length, 50)
  assert.equal(defaultPage.messages[0].id, 'm5')
  assert.equal(defaultPage.messages.at(-1).id, 'm54')
  await writeFile(join(directory, 'sand-client-persistence', blobName(transcriptKey)), '{bad json')
  assert.deepEqual(await listGrokBotMessages(directory, 'bot-alpha'), { messages: [] })
  await assert.rejects(listGrokBotMessages(directory, 'missing'), {
    status: 404,
    code: 'not_found'
  })
  await writeFile(join(directory, 'desktop-status.json'), '{bad json')
  await writeFile(
    join(
      directory,
      'sand-client-persistence',
      blobName(`sand.client.slice.account.${ACCOUNT}.roster.last-roster`)
    ),
    '{bad json'
  )
  const damaged = await listGrokBots(directory)
  assert.deepEqual(damaged.bots, [])
  assert.equal(damaged.running, false)
  assert.equal(damaged.signedIn, false)
  const empty = await fixture(t)
  assert.deepEqual((await listGrokBots(empty)).bots, [])
  assert.deepEqual(
    await listGrokBotMessages(directory, 'bot-alpha').catch((error) => ({ status: error.status })),
    { status: 404 }
  )
})

test('Grok routes reject LAN, agents and every forwarded form before reading data', async () => {
  for (const path of ['/api/grok/bots', '/api/grok/bots/bot-alpha/messages']) {
    await assert.rejects(callRoute(path, { isLan: true }), { status: 403, code: 'forbidden' })
    await assert.rejects(callRoute(path, { agent: true }), { status: 403, code: 'forbidden' })
  }
  for (const path of [
    '/api/m/machine/grok/bots',
    '/api/m/machine/api/grok/bots',
    '/api/m/machine/grok/bots/bot-alpha/messages',
    '/api/m/machine/api/grok/bots/bot-alpha/messages'
  ]) {
    assert.throws(() => checkGrokBotForward({}, new URL(path, 'http://local')), { status: 403 })
  }
  checkGrokBotForward({}, new URL('/api/m/machine/api/machines', 'http://local'))
})

test(
  'HTTP bridge enforces limits and privacy without logging or persisting private content',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-grok-http-'))
    const grokDirectory = join(root, 'grok')
    const opcDirectory = join(root, 'hiveward')
    await mkdir(join(grokDirectory, 'sand-client-persistence'), { recursive: true })
    await mkdir(opcDirectory, { recursive: true })
    const marker = 'PRIVATE_MESSAGE_MARKER_NEVER_PERSIST'
    await writeRoster(grokDirectory, [
      row('bot-alpha', 'Alpha', 1000, { description: 'PRIVATE_DESCRIPTION_MARKER' })
    ])
    await writeBlob(
      grokDirectory,
      `sand.client.slice.account.${ACCOUNT}.transcript.replicas.bot-alpha`,
      {
        entries: [
          {
            id: 'private',
            kind: 'message',
            role: 'user',
            content: marker,
            timestampMs: 1700000000000
          }
        ]
      }
    )
    await writeFile(join(grokDirectory, 'sand-secrets.json'), marker)
    await writeFile(join(grokDirectory, 'Cookies'), marker)
    const previous = {
      HIVEWARD_GROK_DATA_DIR: process.env.HIVEWARD_GROK_DATA_DIR,
      HIVEWARD_DATA_DIR: process.env.HIVEWARD_DATA_DIR,
      HIVEWARD_RUNTIME_META: process.env.HIVEWARD_RUNTIME_META
    }
    process.env.HIVEWARD_GROK_DATA_DIR = grokDirectory
    process.env.HIVEWARD_DATA_DIR = opcDirectory
    process.env.HIVEWARD_RUNTIME_META = join(root, 'absent-runtime.json')
    const logs = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => logs.push(args.join(' '))
    let server
    const guard = {
      assertAllowed: async () => {},
      beforeRpc: async () => {},
      observe: async () => {},
      warnings: () => [],
      status: async () => ({})
    }
    try {
      const [{ startBridge }, { closeRuntimeConnection }] = await Promise.all([
        import('./hiveward-bridge.mjs'),
        import('./hiveward-client.mjs')
      ])
      server = await startBridge({ port: 0, lanPort: false, regionGuard: guard })
      const base = `http://127.0.0.1:${server.address().port}`
      const api = async (path, headers) => {
        const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) })
        const raw = await response.text()
        return { status: response.status, raw, data: raw ? JSON.parse(raw) : undefined }
      }
      assert.equal((await api('/api/grok/bots')).status, 200)
      const privateResponse = await api('/api/grok/bots/bot-alpha/messages?limit=1')
      assert.equal(privateResponse.status, 200)
      assert.ok(privateResponse.raw.includes(marker))
      assert.equal((await api('/api/grok/bots', { 'x-hiveward-caller': 'agent' })).status, 403)
      assert.equal((await api('/api/m/any-machine/api/grok/bots')).status, 403)
      assert.equal((await api('/api/m/any-machine/grok/bots/bot-alpha/messages')).status, 403)
      for (const limit of ['0', '201', 'x', '1.5', '']) {
        assert.equal((await api(`/api/grok/bots/bot-alpha/messages?limit=${limit}`)).status, 400)
      }
      assert.equal((await api('/api/grok/bots/missing/messages')).status, 404)
      const { listTimeline } = await import('./timeline.mjs')
      const timeline = JSON.stringify(listTimeline({ limit: 100 }))
      assert.ok(!timeline.includes(marker))
      assert.ok(!timeline.includes('PRIVATE_DESCRIPTION_MARKER'))
      assert.ok(!logs.join('\n').includes(marker))
      assert.ok(!logs.join('\n').includes('PRIVATE_DESCRIPTION_MARKER'))
      const persisted = await readdir(opcDirectory, { recursive: true })
      for (const name of persisted) {
        const path = join(opcDirectory, name)
        const content = await readFile(path).catch(() => '')
        assert.ok(!content.toString().includes(marker))
        assert.ok(!content.toString().includes('PRIVATE_DESCRIPTION_MARKER'))
      }
      closeRuntimeConnection()
    } finally {
      await closeHttp(server)
      console.log = originalLog
      console.error = originalError
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)
