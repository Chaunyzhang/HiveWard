import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const counts = { tasksOpen: 0, tasksDone: 0, decisionsPending: 0 }
const seat = (terminal) => ({ terminal, occupant: { kind: 'terminal', terminal } })
const detail = (id, name, workspacePath, { ceo = null, projects = [], workers = [] } = {}) => ({
  business: {
    id,
    name,
    workspacePath,
    status: 'active',
    ceo,
    projects,
    counts
  },
  workers,
  tasks: []
})
const dispatch = (id, handle, project, by, extra = {}) => ({
  id,
  handle,
  project,
  agent: 'claude',
  prompt: id,
  title: '',
  status: 'completed',
  review: { state: 'awaiting', reviewer: 'dispatcher' },
  at: '2026-11-03T00:00:00.000Z',
  by: { kind: 'cli', id: by, label: 'Agent', cwd: project },
  alive: true,
  ...extra
})

test('架构图跨业务外援', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-topology-external-'))
  const previous = process.env.HIVEWARD_DATA_DIR
  process.env.HIVEWARD_DATA_DIR = join(root, 'data')
  const aPath = join(root, 'arkeego'),
    bPath = join(root, 'hiveward-app')
  await Promise.all([
    mkdir(process.env.HIVEWARD_DATA_DIR, { recursive: true }),
    mkdir(aPath, { recursive: true }),
    mkdir(bPath, { recursive: true })
  ])
  await writeFile(join(process.env.HIVEWARD_DATA_DIR, 'machine.json'), JSON.stringify({ id: 'B' }))
  const { topology } = await import('./orchestration.mjs')
  const bug = {
    id: 'project_bug',
    businessId: 'hiveward-app',
    name: 'bug 修复组',
    path: bPath,
    status: 'active',
    leader: seat('term_leader_b')
  }
  const a = detail('arkeego', 'arkeego', aPath, { ceo: seat('term_ceo_a') })
  const b = detail('hiveward-app', 'HiveWard', bPath, { projects: [bug] })
  const byA = { kind: 'cli', id: 'term_ceo_a', label: 'Agent', cwd: aPath }
  const home = dispatch('dsp_home', 'term_leader_b', bPath, 'term_owner', {
    projectId: bug.id,
    by: { kind: 'owner', id: 'hiveward-owner', label: '老板' },
    role: 'leader'
  })
  const cross = dispatch('dsp_cross', 'term_leader_b', bPath, 'term_ceo_a', {
    projectId: bug.id,
    by: byA
  })

  try {
    await t.test('跨业务发话：派单归发话方，接活方标成原业务的 Leader 外援', () => {
      const { nodes } = topology([a], [home, cross], false, [a, b])
      const node = nodes.find((n) => n.id === 'dispatch:term_leader_b')
      assert.equal(node.kind, 'worker')
      assert.equal(node.businessId, 'arkeego')
      assert.equal(node.parentId, 'ceo:arkeego')
      assert.equal(node.review, 'awaiting')
      assert.deepEqual(node.external, {
        businessId: 'hiveward-app',
        businessName: 'HiveWard',
        projectId: bug.id,
        projectName: 'bug 修复组',
        role: 'leader'
      })
    })

    await t.test('同业务派下属：不返回 external', () => {
      const worker = {
        dispatchId: 'term:term_worker_a',
        terminal: 'term_worker_a',
        path: aPath,
        agent: 'claude'
      }
      const own = detail('arkeego', 'arkeego', aPath, {
        ceo: seat('term_ceo_a'),
        workers: [worker]
      })
      const ownDispatch = dispatch('dsp_own', 'term_worker_a', aPath, 'term_ceo_a', { by: byA })
      const { nodes } = topology([own], [ownDispatch], false, [own, b])
      const node = nodes.find((n) => n.id === 'dispatch:term_worker_a')
      assert.equal(node.businessId, 'arkeego')
      assert.equal(node.parentId, 'ceo:arkeego')
      assert.equal(Object.hasOwn(node, 'external'), false)
    })

    await t.test('全公司架构图带外援，每块业务子树与单业务请求完全一致', () => {
      const all = topology([a, b], [home, cross], true, [a, b]).nodes
      const external = all.find((n) => n.id === 'dispatch:term_leader_b')
      assert.equal(external.businessId, 'arkeego')
      assert.deepEqual(external.external, {
        businessId: 'hiveward-app',
        businessName: 'HiveWard',
        projectId: bug.id,
        projectName: 'bug 修复组',
        role: 'leader'
      })
      for (const [businessId, selected] of [
        ['arkeego', a],
        ['hiveward-app', b]
      ]) {
        const single = topology([selected], [home, cross], false, [a, b]).nodes
        assert.deepEqual(
          all.filter((n) => n.businessId === businessId),
          single
        )
      }
    })

    await t.test('远程派单按执行项目归属，不拿派单电脑 cwd 比较', () => {
      const remote = dispatch('dsp_remote', 'term_remote', bPath, 'mac-session', {
        projectId: bug.id,
        by: { ...byA, machineId: 'A' }
      })
      const { nodes } = topology([a, b], [remote], true, [a, b])
      const node = nodes.find((item) => item.terminal === 'term_remote')
      assert.equal(node.businessId, 'hiveward-app')
      assert.equal(node.dispatcherMachineId, 'A')
      assert.equal(node.dispatchId, 'dsp_remote')
      assert.equal(node.taskId, 'dsp_remote')
    })

    await t.test('外援在自己业务里仍是项目 Leader，不变成 dispatch worker', () => {
      const { nodes } = topology([b], [home, cross], false, [a, b])
      const leader = nodes.find((n) => n.id === `leader:${bug.id}`)
      assert.equal(leader.kind, 'leader')
      assert.equal(leader.businessId, 'hiveward-app')
      assert.equal(leader.terminal, 'term_leader_b')
      assert.equal(
        nodes.some((n) => n.id === 'dispatch:term_leader_b'),
        false
      )
    })

    await t.test('架构图直接显示当前编排 Task 的复核状态', () => {
      const fixtures = [
        {
          handle: 'term_rework',
          root: {
            status: 'dispatched',
            report: undefined,
            review: { state: 'rework', reviewer: 'dispatcher', round: 2 }
          },
          expected: ['working', 'rework']
        },
        {
          handle: 'term_accepted',
          root: { review: { state: 'accepted', reviewer: 'dispatcher', round: 1 } },
          expected: undefined
        },
        {
          handle: 'term_new_round',
          root: {
            status: 'dispatched',
            report: undefined,
            review: undefined,
            reviewRound: 3,
            reworkPrompt: '当前轮新话'
          },
          expected: ['working', undefined]
        },
        {
          handle: 'term_awaiting',
          root: { review: { state: 'awaiting', reviewer: 'dispatcher', round: 4 } },
          expected: ['done', 'awaiting']
        }
      ]
      const roots = fixtures.map(({ handle, root }, index) =>
        dispatch(`dsp_root_${index}`, handle, aPath, 'term_ceo_a', root)
      )
      const { nodes } = topology([a], roots, false, [a])
      for (const [index, { handle, expected }] of fixtures.entries()) {
        const node = nodes.find((n) => n.terminal === handle)
        if (!expected) {
          // 复核通过即已结算，不再作为在线下属留在架构图。
          assert.equal(node, undefined)
          continue
        }
        assert.equal(node.state, expected[0])
        assert.equal(node.review, expected[1])
        assert.equal(node.taskId, `dsp_root_${index}`)
        assert.equal(node.dispatchId, `dsp_root_${index}`)
      }
      const unregistered = topology([], [roots[2]], true, []).nodes.find(
        (n) => n.terminal === 'term_new_round'
      )
      assert.equal(unregistered.review, undefined)
      assert.equal(unregistered.taskId, roots[2].id)
      assert.equal(unregistered.activity, '当前轮新话')
    })
  } finally {
    if (previous === undefined) {
      delete process.env.HIVEWARD_DATA_DIR
    } else {
      process.env.HIVEWARD_DATA_DIR = previous
    }
    await rm(root, { recursive: true, force: true })
  }
})
