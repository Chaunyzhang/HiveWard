import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const counts = { tasksOpen: 0, tasksDone: 0, decisionsPending: 0 }
const terminalSeat = (terminal) => ({ terminal, occupant: { kind: 'terminal', terminal } })
const sessionSeat = (sessionId) => ({ occupant: { kind: 'session', sessionId } })
const detail = (id, name, workspacePath, { ceo = null, projects = [] } = {}) => ({
  business: { id, name, workspacePath, status: 'active', ceo, projects, counts },
  workers: [],
  tasks: []
})
const localDispatch = (id, handle, project, dispatcherId, extra = {}) => ({
  id,
  dispatchId: id,
  handle,
  project,
  agent: 'claude',
  prompt: id,
  title: `执行任务 ${id}`,
  status: 'completed',
  report: { reportedAt: '2026-11-03T01:00:00.000Z' },
  review: { state: 'awaiting', reviewer: 'dispatcher' },
  at: '2026-11-03T00:00:00.000Z',
  by: {
    kind: 'claude-code',
    id: dispatcherId,
    label: 'Mac 派单方',
    machineId: 'A',
    cwd: '/来源目录'
  },
  alive: true,
  ...extra
})
test('跨电脑架构图投影', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-topology-remote-'))
  const previous = process.env.HIVEWARD_DATA_DIR
  process.env.HIVEWARD_DATA_DIR = join(root, 'data')
  const aPath = join(root, 'a-business')
  const bPath = join(root, 'b-business')
  const otherPath = join(root, 'other-business')
  const outside = join(root, 'outside')
  await mkdir(process.env.HIVEWARD_DATA_DIR, { recursive: true })
  await writeFile(join(process.env.HIVEWARD_DATA_DIR, 'machine.json'), JSON.stringify({ id: 'B' }))
  const { topology } = await import('./orchestration.mjs')
  const aProject = {
    id: 'a_project',
    name: 'A 项目',
    path: join(aPath, 'project'),
    status: 'active',
    leader: {
      ...sessionSeat('session_a_leader'),
      native: { party: { address: 'session_a_leader' } }
    }
  }
  const a = detail('a_business', 'A 业务', aPath, {
    ceo: terminalSeat('term_a_ceo'),
    projects: [aProject]
  })
  const bProject = {
    id: 'b_project',
    name: 'B 项目',
    path: join(bPath, 'project'),
    status: 'active',
    leader: terminalSeat('term_b_leader')
  }
  const b = detail('b_business', 'B 业务', bPath, { projects: [bProject] })
  const other = detail('other_business', '另一业务', otherPath)
  const onlineA = [{ id: 'A', name: 'Mac-A', status: 'online', secure: true }]

  try {
    await t.test('派单方从原生 Dispatch 投影远程执行位置，不读取跨机 JSON', () => {
      const dispatch = localDispatch('dsp_ceo', 'dispatch:dsp_ceo', aPath, 'term_a_ceo', {
        execution: { environmentId: 'environment_b', name: 'B', peerFingerprint: 'peer_b' },
        nativeTerminal: 'term_remote',
        by: { kind: 'cli', id: 'term_a_ceo', cwd: aPath }
      })
      const { nodes } = topology([a], [dispatch], false, [a])
      const worker = nodes.find((node) => node.dispatchId === dispatch.id)
      assert.equal(worker.parentId, 'ceo:a_business')
      assert.equal(worker.federation.environmentId, 'environment_b')
      assert.equal(worker.nativeTerminal, 'term_remote')
    })

    await t.test('Leader 的原生 crew 关系优先于执行目录', () => {
      const dispatch = localDispatch(
        'dsp_leader',
        'dispatch:dsp_leader',
        aPath,
        'session_a_leader',
        { by: { kind: 'cli', id: 'session_a_leader', cwd: aPath } }
      )
      a.business.crew = {
        session_a_leader: {
          sections: { managing: [{ openTarget: { kind: 'terminal', handle: dispatch.handle } }] }
        }
      }
      const { nodes } = topology([a], [dispatch], true, [a])
      assert.equal(
        nodes.find((node) => node.dispatchId === dispatch.id).parentId,
        'leader:a_project'
      )
    })

    await t.test('全公司与单业务共享原生派单投影', () => {
      const dispatch = localDispatch(
        'dsp_consistent',
        'dispatch:dsp_consistent',
        aPath,
        'term_a_ceo'
      )
      const all = topology([a, other], [dispatch], true, [a, other]).nodes
      const single = topology([a], [dispatch], false, [a, other]).nodes
      assert.deepEqual(
        all.filter((node) => node.businessId === 'a_business'),
        single
      )
    })

    await t.test('B 按来源合并空降派单方，下属不挂到本机 Leader', () => {
      const first = localDispatch('dsp_b_1', 'term_b_1', bProject.path, 'session_a_leader', {
        projectId: bProject.id,
        businessName: 'A 业务'
      })
      const second = localDispatch('dsp_b_2', 'term_b_2', bProject.path, 'session_a_leader', {
        projectId: bProject.id
      })
      const { nodes } = topology([b], [first, second], false, [b], onlineA)
      const shadows = nodes.filter((node) => node.id === 'airborne:A:session_a_leader')
      assert.equal(shadows.length, 1)
      assert.equal(shadows[0].kind, 'leader')
      assert.equal(shadows[0].parentId, 'business:b_business')
      assert.equal(shadows[0].label, 'Mac 派单方')
      assert.equal(shadows[0].online, true)
      assert.equal(shadows[0].count, 2)
      assert.deepEqual(shadows[0].remoteChildren, ['dsp_b_1', 'dsp_b_2'])
      assert.deepEqual(shadows[0].airborne, {
        machineId: 'A',
        machineName: 'Mac-A',
        dispatcherId: 'session_a_leader',
        dispatcherLabel: 'Mac 派单方',
        businessName: 'A 业务'
      })
      for (const id of ['dsp_b_1', 'dsp_b_2']) {
        const worker = nodes.find((node) => node.dispatchId === id)
        assert.equal(worker.parentId, 'airborne:A:session_a_leader')
        assert.equal(worker.dispatcherMachineId, 'A')
      }
    })

    await t.test('B 来源离线仍显示影子；全公司与单业务一致', () => {
      const dispatch = localDispatch('dsp_b_online', 'term_b_online', bPath, 'session_a_leader')
      const offlineA = [
        {
          id: 'A',
          name: 'Mac-A',
          status: 'offline',
          secure: false,
          lastSeenAt: '2026-11-03T03:00:00.000Z'
        }
      ]
      const all = topology([b, other], [dispatch], true, [b, other], offlineA).nodes
      const single = topology([b], [dispatch], false, [b, other], offlineA).nodes
      assert.deepEqual(
        all.filter((node) => node.businessId === 'b_business'),
        single
      )
      const shadow = all.find((node) => node.id === 'airborne:A:session_a_leader')
      assert.equal(shadow.online, false)
      assert.equal(shadow.lastSeenAt, '2026-11-03T03:00:00.000Z')
      assert.equal(shadow.airborne.machineName, 'Mac-A')
    })

    await t.test('B 未登记目录进入外来派单分组', () => {
      const dispatch = localDispatch('dsp_outside', 'term_outside', outside, 'session_a_leader')
      const { nodes } = topology([b], [dispatch], true, [b], onlineA)
      const root = nodes.find((node) => node.id === `business:${outside}`)
      const shadow = nodes.find((node) => node.id === 'airborne:A:session_a_leader')
      const worker = nodes.find((node) => node.dispatchId === 'dsp_outside')
      assert.equal(root.label, '外来派单')
      assert.equal(root.unregistered, true)
      assert.equal(shadow.parentId, root.id)
      assert.equal(worker.parentId, shadow.id)
      assert.equal(
        nodes.some((node) => node.id === `leader:${outside}`),
        false
      )
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
