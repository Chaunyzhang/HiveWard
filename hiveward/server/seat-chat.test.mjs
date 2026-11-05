import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'seat-chat-'))
const previousHome = process.env.HOME
process.env.HOME = home
// transcripts.mjs fixes HOME at import time.
const { seatSessionChat } = await import('./seat-chat.mjs')
process.env.HOME = previousHome

test.after(() => rm(home, { recursive: true, force: true }))

const cwd = '/work/video'
const session = (sessionId) => ({
  agent: 'claude',
  occupant: { kind: 'session', agent: 'claude-desktop', sessionId, cwd }
})
function transcript(sessionId, records) {
  const dir = join(home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${records.map((r, i) => JSON.stringify({ uuid: `${sessionId}-${i}`, ...r })).join('\n')}\n`
  )
}
const details = [
  {
    business: {
      id: 'video',
      ceo: session('ceo-session'),
      projects: [
        { id: 'skill', leader: session('leader-session') },
        { id: 'terminal', leader: { agent: 'claude', terminal: 'term_1' } }
      ]
    }
  }
]

test('reads the conversation of the desktop session sitting in a Leader seat', async () => {
  transcript('leader-session', [
    { type: 'user', message: { role: 'user', content: '写分镜' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '写好了' }] }
    }
  ])
  const chat = await seatSessionChat(details, 'leader:skill', async () => ({
    hivewardTaskList: { items: [], updatedAt: null }
  }))
  assert.equal(chat.agent, 'claude')
  assert.ok(chat.source?.endsWith('leader-session.jsonl'))
  assert.deepEqual(
    chat.items.map((i) => [i.kind, i.text]),
    [
      ['user', '写分镜'],
      ['assistant', '写好了']
    ]
  )
})

test('CEO seat works the same; a missing transcript is an empty chat, not an error', async () => {
  const chat = await seatSessionChat(details, 'ceo:video')
  assert.equal(chat.source, null)
  assert.deepEqual(chat.items, [])
})

test('only registered session seats: terminal seats and unknown ids are 404', async () => {
  for (const id of ['leader:terminal', 'leader:nope', 'ceo:nope', 'worker:x', 'nonsense']) {
    await assert.rejects(seatSessionChat(details, id), { status: 404 })
  }
})
