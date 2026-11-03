import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForAgent, sendFirst } from './agent-first-prompt.mjs'

function clock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    }
  }
}

test('readiness waits for an Agent and stable screen, including permission and timeout', async () => {
  const timer = clock()
  assert.equal(
    await waitForAgent(
      async () => ({
        agent: timer.now() < 1000 ? null : timer.now() < 2000 ? 'permission' : 'idle',
        text: timer.now() < 3000 ? String(timer.now()) : 'ready'
      }),
      timer
    ),
    true
  )
  assert.ok(timer.now() >= 5000)
  const absent = clock()
  assert.equal(await waitForAgent(async () => ({ agent: null, text: 'shell' }), absent), false)
  assert.equal(absent.now(), 45000)
})

test('first prompt confirms a new matching user message and retries only once', async () => {
  let sends = 0
  const timer = clock()
  const prior = { id: 'old', kind: 'user', text: 'same task' }
  assert.equal(
    await sendFirst('same task', {
      ...timer,
      send: async () => {
        sends++
      },
      chat: async () => ({ items: sends < 2 ? [prior] : [prior, { ...prior, id: 'new' }] })
    }),
    true
  )
  assert.equal(sends, 2)
  sends = 0
  assert.equal(
    await sendFirst('same task', {
      ...clock(),
      send: async () => {
        sends++
      },
      chat: async () => ({ items: [prior] })
    }),
    false
  )
  assert.equal(sends, 2)
})

test('background first prompt persists failure and timeline; successful retry settles dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opc-leader-delivery-'))
  process.env.OPC_DATA_DIR = join(root, 'data')
  await mkdir(process.env.OPC_DATA_DIR)
  await writeFile(
    join(process.env.OPC_DATA_DIR, 'businesses.json'),
    JSON.stringify([{ id: 'b', workspacePath: root }])
  )
  const { createBusinessProject, updateProject, projectSummaries } =
    await import('./business-projects.mjs')
  const { recordDispatch, dispatches } = await import('./dispatches.mjs')
  const { queueLeaderPrompt } = await import('./leader-prompt-delivery.mjs')
  const { listTimeline } = await import('./timeline.mjs')
  try {
    const p = createBusinessProject('b', { name: '项目' })
    const project = updateProject(p.id, {
      leader: { terminal: 't1', agent: 'kimi', startedAt: new Date().toISOString() }
    })
    const create = () =>
      recordDispatch({
        handle: 't1',
        project: root,
        projectId: p.id,
        agent: 'kimi',
        prompt: 'first task',
        delivery: 'queued',
        by: { kind: 'owner', id: 'opc-owner' }
      })
    const summarize = () =>
      projectSummaries('b', [{ handle: 't1', agent: 'kimi' }], dispatches())[0]
    for (const scenario of ['timeout', 'unconfirmed', 'retry-success']) {
      const dispatch = create()
      let sends = 0,
        changed = 0
      const delivery = queueLeaderPrompt(
        project,
        dispatch,
        () => {
          changed++
        },
        {
          ...clock(),
          screen: async () => ({ agent: scenario === 'timeout' ? null : 'idle', text: 'ready' }),
          send: async () => {
            sends++
          },
          chat: async () => ({
            items:
              scenario === 'retry-success' && sends === 2
                ? [{ id: 'received', kind: 'user', text: 'first task' }]
                : []
          })
        }
      )
      assert.equal(sends, 0)
      assert.equal(summarize().leader.state, 'pending')
      await delivery
      assert.equal(changed, 1)
      const row = dispatches().find((d) => d.id === dispatch.id)
      assert.equal(sends, scenario === 'timeout' ? 0 : 2)
      if (scenario === 'retry-success') {
        assert.equal(row.delivery, 'delivered')
        assert.notEqual(summarize().leader.state, 'failed')
      } else {
        assert.equal(row.status, 'failed')
        assert.equal(summarize().leader.state, 'failed')
        assert.match(summarize().leader.activity, /未就绪|未确认收到/)
        assert.ok(
          listTimeline({ projectId: p.id }).items.some(
            (e) => e.taskId === dispatch.id && e.title === 'Leader Agent 首句发送失败：项目'
          )
        )
      }
      console.log(
        `ACCEPT first prompt ${scenario}: sends=${sends}, delivery=${row.delivery}, state=${summarize().leader.state}`
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Kimi defaults to K3.1 Pro and explicit models override for all providers', async () => {
  const { agentCommand } = await import('./business-terminals.mjs')
  assert.equal(agentCommand('kimi'), "kimi --yolo --model 'kimi-code/k3.1-pro'")
  for (const agent of ['kimi', 'codex', 'claude']) {
    const command = agentCommand(agent, { model: 'explicit-model' })
    assert.match(command, /--model 'explicit-model'$/)
    assert.equal((command.match(/--model/g) ?? []).length, 1)
  }
  assert.doesNotMatch(agentCommand('claude'), /--model/)
  assert.doesNotMatch(agentCommand('codex'), /--model/)
})
