import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyHarnesses, personalAgentBotPatch, personalAgentPatch } from './harnesses.mjs'

function fakeApp(dir, name, version) {
  mkdirSync(join(dir, name, 'Contents'), { recursive: true })
  writeFileSync(
    join(dir, name, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`
  )
}

test('引擎认出的命令行分成 Coding / Personal，Hermes 归 Personal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-harness-'))
  const r = await classifyHarnesses({
    clis: ['claude', 'codex', 'hermes', 'grok', 'kimi'],
    appDirs: [dir]
  })
  assert.deepEqual(
    r.coding.map((h) => h.id),
    ['claude', 'codex', 'grok', 'kimi']
  )
  assert.equal(r.coding[2].name, 'Grok CLI')
  const hermes = r.personal.find((h) => h.id === 'hermes')
  assert.equal(hermes.installed, true)
  assert.equal(hermes.command, 'hermes')
  assert.equal(r.personal.find((h) => h.id === 'muse').installed, false)
})

test('桌面 App 在就算装了，带上版本号', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-harness-'))
  fakeApp(dir, 'Grok Bot.app', '0.78.1')
  const r = await classifyHarnesses({ clis: [], appDirs: [dir] })
  const grok = r.personal.find((h) => h.id === 'grokbot')
  assert.equal(grok.installed, true)
  assert.equal(grok.version, '0.78.1')
  assert.equal(grok.app, join(dir, 'Grok Bot.app'))
  assert.equal(r.personal.find((h) => h.id === 'openclaw').installed, false)
})

test('引擎没开：Coding 为空并带错误，Personal 照样按 App 认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-harness-'))
  const r = await classifyHarnesses({ clis: null, error: '连不上', appDirs: [dir] })
  assert.deepEqual(r.coding, [])
  assert.equal(r.error, '连不上')
  assert.equal(r.personal.length, 4)
})

test('Personal Agent 位只能坐认得的那几家', () => {
  assert.equal(personalAgentPatch('hermes'), 'hermes')
  assert.equal(personalAgentPatch(null), null)
  assert.throws(() => personalAgentPatch('claude'), /personalAgent/)
})

test('Personal Agent 里具体哪个 Bot：只收 id 样子的字符串', () => {
  assert.equal(personalAgentBotPatch('bot_1-A'), 'bot_1-A')
  assert.equal(personalAgentBotPatch(null), null)
  assert.throws(() => personalAgentBotPatch('../x'), /personalAgentBot/)
  assert.throws(() => personalAgentBotPatch(3), /personalAgentBot/)
})
