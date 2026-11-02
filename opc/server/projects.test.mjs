import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileBusinesses, projectIdFor } from './projects.mjs'

const exists =
  (...paths) =>
  (p) =>
    paths.includes(p)

test('projectIdFor: 英文目录名转 slug，中文用 p- 前缀，冲突加后缀', () => {
  const taken = new Set(['shop'])
  assert.equal(projectIdFor('CutGo', 'abc123def456', taken), 'cutgo')
  assert.equal(projectIdFor('My App!', 'abc123def456', taken), 'my-app')
  assert.equal(projectIdFor('中文项目', 'abc123def456', taken), 'p-abc123de')
  assert.equal(projectIdFor('shop', 'zzz999xxx000', taken), 'shop-2')
  assert.equal(projectIdFor('shop', 'zzz999xxx111', taken), 'shop-3')
})

test('reconcile: 引擎有项目、业务没有 → 补记录（默认 claude / priority 2 / active）', () => {
  const repos = [{ id: 'r1', path: '/tmp/p1', kind: 'git', displayName: '玉石站' }]
  const { rows, changed } = reconcileBusinesses([], repos, exists('/tmp/p1'))
  assert.equal(changed, true)
  assert.deepEqual(
    rows.map((b) => [
      b.id,
      b.name,
      b.workspacePath,
      b.repoId,
      b.kind,
      b.leaderAgent,
      b.priority,
      b.status,
      b.nameSource
    ]),
    [['p1', '玉石站', '/tmp/p1', 'r1', 'git', 'claude', 2, 'active', 'auto']]
  )
})

test('reconcile: 已有业务 id 不变，挂上 repoId / kind', () => {
  const rows = [
    {
      id: 'shop',
      name: '玉石独立站',
      workspacePath: '/tmp/p1',
      leaderAgent: 'claude',
      priority: 1,
      status: 'active',
      authority: '',
      runIds: [],
      updatedAt: 't0'
    }
  ]
  const repos = [{ id: 'r1', path: '/tmp/p1', kind: 'git', displayName: '别的名' }]
  const result = reconcileBusinesses(rows, repos, exists('/tmp/p1'))
  assert.equal(result.changed, true)
  assert.equal(result.rows[0].id, 'shop')
  assert.equal(result.rows[0].repoId, 'r1')
  assert.equal(result.rows[0].kind, 'git')
  assert.equal(result.rows[0].name, '玉石独立站')
})

test('reconcile: 目录不存在 → 标 missing，记录保留', () => {
  const rows = [
    {
      id: 'shop',
      name: '玉石独立站',
      workspacePath: '/gone',
      leaderAgent: 'claude',
      priority: 1,
      status: 'active',
      authority: '',
      runIds: [],
      repoId: 'r9',
      kind: 'git',
      updatedAt: 't0'
    }
  ]
  const { rows: out, changed } = reconcileBusinesses(rows, [], () => false)
  assert.equal(changed, true)
  assert.equal(out[0].missing, true)
  assert.equal(out[0].repoId, undefined)
  assert.equal(out[0].kind, undefined)
  // 目录回来了：去掉 missing
  const back = reconcileBusinesses(out, [{ id: 'r9', path: '/gone', kind: 'git' }], exists('/gone'))
  assert.equal(back.rows[0].missing, false)
  assert.equal(back.rows[0].repoId, 'r9')
})

test('reconcile: 没有对账变化时 changed 为 false', () => {
  const rows = [
    {
      id: 'shop',
      name: '玉石独立站',
      workspacePath: '/tmp/p1',
      leaderAgent: 'claude',
      priority: 1,
      status: 'active',
      authority: '',
      runIds: [],
      repoId: 'r1',
      kind: 'git',
      updatedAt: 't0'
    }
  ]
  const result = reconcileBusinesses(
    rows,
    [{ id: 'r1', path: '/tmp/p1', kind: 'git' }],
    exists('/tmp/p1')
  )
  assert.equal(result.changed, false)
})

test('reconcile: 已移除（removedAt）的记录不再挂回项目，也不重复补记录', () => {
  const rows = [
    {
      id: 'p1',
      name: '旧项目',
      workspacePath: '/tmp/p1',
      leaderAgent: 'claude',
      priority: 2,
      status: 'archived',
      authority: '',
      runIds: [],
      removedAt: 't1',
      updatedAt: 't0'
    }
  ]
  const repos = [{ id: 'r1', path: '/tmp/p1', kind: 'folder', displayName: '旧项目' }]
  const { rows: out, changed } = reconcileBusinesses(rows, repos, exists('/tmp/p1'))
  assert.equal(changed, false)
  assert.equal(out.length, 1)
  assert.equal(out[0].repoId, undefined)
})
