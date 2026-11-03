import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseMenu, menuKeys, screenMenu } from './screen-menu.mjs'

const kimiPlan = `│ 1. 先读 api.ts
│ 2. 再写 mcp-shares.mjs
│ ? Approve this plan                                │
│                                                    │
│ → [1] Approve                                      │
│       Exit plan mode and start execution           │
│   [2] Reject                                       │
│       Reject and stay in plan mode                 │
│   [3] Reject and Exit                              │
│       Reject and exit plan mode                    │
│   [4] Revise                                       │
│       Stay in plan mode and provide feedback       │
╰────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────
yolo  plan  agent (K3.1 Pro ●)  ~/opc-app
                                 context: 12.9%`

test('认出 Kimi 计划模式的批准菜单', () => {
  const m = screenMenu(kimiPlan)
  assert.equal(m.question, 'Approve this plan')
  assert.deepEqual(
    m.options.map((o) => o.label),
    ['Approve', 'Reject', 'Reject and Exit', 'Revise']
  )
  assert.equal(m.cursor, 1)
})

test('认出 Claude 的确认菜单，带 ANSI 也行', () => {
  const m = screenMenu(
    '\x1b[1m Do you want to proceed?\x1b[0m\n \x1b[36m❯ 1. Yes\x1b[0m\n   2. No, and tell Claude what to do differently (esc)'
  )
  assert.equal(m.question, 'Do you want to proceed?')
  assert.equal(m.options.length, 2)
})

test('普通的编号列表、只有一项、编号不从 1 开始都不算菜单', () => {
  assert.equal(screenMenu('计划：\n1. 读代码\n2. 改代码\n── input ──\nyolo agent'), null)
  assert.equal(screenMenu('? 继续吗\n→ [1] 好'), null)
  assert.equal(screenMenu('? 继续吗\n→ [2] 好\n  [3] 不好'), null)
  assert.equal(screenMenu(''), null)
})

test('按键：从光标上下移到目标再回车', () => {
  const m = screenMenu(kimiPlan)
  assert.equal(menuKeys(m, 1), '\r')
  assert.equal(menuKeys(m, 3), '\x1b[B\x1b[B\r')
  assert.equal(menuKeys({ ...m, cursor: 3 }, 1), '\x1b[A\x1b[A\r')
})

test('chooseMenu 先确认菜单还在；不在了 409，不往终端按键', async () => {
  const sent = []
  const rpc = (screen) => async (method, params) => {
    if (method === 'terminal.read') {
      return { terminal: { tail: screen.split('\n') } }
    }
    sent.push(params)
    return {}
  }
  const option = await chooseMenu(rpc(kimiPlan), 'term_x', 'Revise')
  assert.equal(option.n, 4)
  assert.deepEqual(sent, [{ terminal: 'term_x', text: '\x1b[B\x1b[B\x1b[B\r', enter: false }])
  await assert.rejects(chooseMenu(rpc('── input ──'), 'term_x', 1), { code: 'menu_gone' })
  await assert.rejects(chooseMenu(rpc(kimiPlan), 'term_x', 9), { code: 'menu_option_missing' })
  assert.equal(sent.length, 1)
})
