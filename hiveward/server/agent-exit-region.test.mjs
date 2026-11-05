import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawnProcess, runProcess } from '@hiveward/process-host'
import { createExitRegionGuard, DEFAULT_EXIT_POLICY } from './agent-exit-region.mjs'
import {
  probeExitRegion,
  parseTraceCountry,
  EXIT_REGION_TARGETS,
  environmentFingerprint
} from './exit-region-probe.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (command, result) => console.log(`${command}\n${JSON.stringify(result)}`)
async function api(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  })
  return { status: r.status, data: await r.json() }
}

test('policy, fail closed, freshness, environment changes and manual warning deduplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-region-unit-'))
  let clock = 100000,
    country = 'US',
    revision = 1,
    probes = 0
  let captureFailed = false
  const warnings = []
  const guard = createExitRegionGuard({
    directory,
    now: () => clock,
    capture: async () => {
      if (captureFailed) {
        throw new Error('shell timeout')
      }
      return { env: { HTTPS_PROXY: `http://127.0.0.1:${revision}` }, shell: '/bin/zsh' }
    },
    fingerprint: (c) => environmentFingerprint(c, {}),
    probe: async () => {
      probes++
      return { country, method: 'login-shell-proxy-trace', source: EXIT_REGION_TARGETS[0] }
    },
    onWarning: (w) => warnings.push(w)
  })
  try {
    assert.deepEqual(guard.policy(), DEFAULT_EXIT_POLICY)
    await guard.assertAllowed('claude')
    clock += 59000
    await guard.assertAllowed('codex')
    assert.equal(probes, 1)
    clock += 1001
    country = 'CN'
    await assert.rejects(guard.assertAllowed('claude'), { code: 'exit_region_blocked' })
    assert.equal(probes, 2)
    country = 'US'
    revision++
    await guard.assertAllowed('codex')
    assert.equal(probes, 3)
    country = null
    revision++
    await assert.rejects(guard.assertAllowed('codex'), { code: 'exit_region_blocked' })
    await guard.assertAllowed('kimi')
    captureFailed = true
    await assert.rejects(guard.assertAllowed('claude'), { code: 'exit_region_blocked' })
    captureFailed = false
    assert.notEqual(
      environmentFingerprint({ env: {}, shell: 'zsh' }, { en0: [{ address: '192.0.2.1' }] }),
      environmentFingerprint({ env: {}, shell: 'zsh' }, { en0: [{ address: '192.0.2.2' }] })
    )
    guard.setPolicy({ ...DEFAULT_EXIT_POLICY, claude: ['CN'] })
    country = 'CN'
    await guard.assertAllowed('claude')
    await assert.rejects(guard.assertAllowed('codex'), { code: 'exit_region_blocked' })
    await assert.rejects(guard.beforeRpc('terminal.create', { command: 'HTTPS_PROXY=x claude' }), {
      code: 'exit_region_blocked'
    })
    await assert.rejects(
      guard.beforeRpc('terminal.create', { command: 'codex', env: { HTTPS_PROXY: 'x' } }),
      { code: 'exit_region_blocked' }
    )
    await assert.rejects(
      guard.beforeRpc('terminal.create', { launchAgent: 'kimi', command: 'claude' }),
      { code: 'exit_region_blocked' }
    )
    guard.setPolicy(DEFAULT_EXIT_POLICY)
    const running = [{ handle: 'manual-1', agent: 'claude', connected: true }]
    await guard.observe(running)
    await guard.observe(running)
    assert.equal(warnings.length, 1)
    assert.equal(guard.warnings()[0].country, 'CN')
    await guard.observe([])
    assert.deepEqual(guard.warnings(), [])
    assert.throws(() => guard.setPolicy({ claude: null, codex: ['US'], kimi: null }), {
      status: 400
    })
    await writeFile(join(directory, 'agent-exit-region-policy.json'), '{broken')
    await assert.rejects(guard.assertAllowed('claude'), { code: 'exit_region_blocked' })
    log('unit acceptance', {
      blockedNonUS: true,
      blockedUnknown: true,
      cache60Seconds: true,
      proxyChangeInvalidates: true,
      policyApplied: true,
      corruptPolicyBlocked: true,
      warningsDeduplicated: true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('probe only uses fixed neutral HTTPS targets, never follows redirects, and discards IP', async () => {
  const requests = []
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' }
  const result = await probeExitRegion({ env, shell: '/bin/zsh' }, async (spec) => {
    requests.push(spec)
    assert.equal(spec.env, env)
    assert.equal(spec.args[0], '--disable')
    assert.ok(!spec.args.includes('--location'))
    return { code: 0, stdout: 'ip=203.0.113.9\nloc=US\nHIVEWARD_HTTP_STATUS=200' }
  })
  assert.equal(result.country, 'US')
  assert.ok(!JSON.stringify(result).includes('203.0.113.9'))
  assert.equal(parseTraceCountry('loc=US\nloc=CN'), null)
  const failure = await probeExitRegion({ env, shell: '/bin/zsh' }, async (spec) => {
    requests.push(spec)
    return { code: 0, stdout: 'loc=US\nHIVEWARD_HTTP_STATUS=302' }
  })
  assert.equal(failure.country, null)
  const timeout = await probeExitRegion({ env, shell: '/bin/zsh' }, async () => ({
    code: null,
    timedOut: true,
    stdout: ''
  }))
  assert.equal(timeout.country, null)
  assert.ok(requests.every((r) => EXIT_REGION_TARGETS.includes(r.args.at(-1))))
  log('neutral transport safety', {
    requests: requests.map((r) => r.args.at(-1)),
    redirectsRejected: true,
    timeoutCountry: timeout.country,
    rawIPReturned: false
  })
})

test(
  'isolated HTTP, CLI, leader and LAN requests enforce target exit; manual agent only warns',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-region-http-'))
    const children = [],
      sockets = new Set(),
      creates = []
    let manual = false
    const runtime = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString()
        let end
        while ((end = buffer.indexOf('\n')) !== -1) {
          const req = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          const replies = {
            'repo.list': {
              repos: [
                { id: 'test-project', path: root, displayName: 'Test project', kind: 'folder' }
              ]
            },
            'status.get': { appVersion: 'fixture' },
            'repo.add': { repo: { id: 'fixture-caller', path: process.cwd() } },
            'orchestration.hivewardSessionRegister': {
              address: 'hiveward_session_id:hiveward_fixture',
              sessionId: 'hiveward_fixture'
            },
            'terminal.list': {
              terminals: manual
                ? [
                    {
                      handle: 'manual-claude',
                      agentIdentity: 'claude',
                      worktreePath: root,
                      connected: true
                    }
                  ]
                : []
            },
            'worktree.list': { worktrees: [] },
            'orchestration.runList': { runs: [] },
            'orchestration.inbox': { messages: [] },
            'terminal.inspectProcess': {
              process: { hasChildProcesses: false, foregroundProcess: null }
            }
          }
          let result = replies[req.method]
          if (req.method === 'terminal.create') {
            creates.push(req.params.command)
            result = { terminal: { handle: `fixture-${creates.length}` } }
          }
          socket.write(
            `${JSON.stringify({ id: req.id, ok: !!result, result, error: result ? undefined : { code: req.method === 'orchestration.workerStart' ? 'environment_not_found' : 'method_not_found', message: req.method === 'orchestration.workerStart' ? 'environment_not_found' : req.method } })}\n`
          )
        }
      })
    })
    const socketPath =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\region-${process.pid}`
        : join(root, 'rpc.sock')
    runtime.listen(socketPath)
    await once(runtime, 'listening')
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({ authToken: 'fixture', transports: [{ kind: 'unix', endpoint: socketPath }] })
    )
    async function start(name, port, country) {
      const dir = join(root, name)
      await mkdir(dir)
      await writeFile(join(dir, 'machine.json'), JSON.stringify({ id: name, name }))
      await writeFile(
        join(dir, 'businesses.json'),
        JSON.stringify([
          {
            id: 'project',
            name: 'Test project',
            nameSource: 'user',
            workspacePath: root,
            repoId: 'test-project',
            kind: 'folder',
            leaderAgent: 'claude',
            priority: 1,
            status: 'active',
            runIds: [],
            updatedAt: new Date().toISOString()
          }
        ])
      )
      await writeFile(join(dir, 'test-exit-region.json'), JSON.stringify({ country, revision: 1 }))
      const child = spawnProcess({
        program: process.execPath,
        args: ['hiveward/server/tests/exit-region-bridge-fixture.mjs'],
        env: {
          ...process.env,
          HIVEWARD_BACKGROUND_LAUNCH: '1',
          HIVEWARD_PORT: String(port),
          HIVEWARD_LAN_PORT: String(port + 1),
          HIVEWARD_DATA_DIR: dir,
          HIVEWARD_RUNTIME_META: join(root, 'runtime.json')
        }
      })
      children.push(child)
      let output = ''
      child.stdout.on('data', (d) => {
        output += d.toString()
      })
      child.stderr.on('data', (d) => {
        output += d.toString()
      })
      for (let n = 0; n < 100; n++) {
        if (child.exitCode !== null) {
          throw new Error(output)
        }
        if (output.includes('bridge on')) {
          return dir
        }
        await pause(50)
      }
      throw new Error('fixture startup timeout')
    }
    try {
      await start('US-machine', 18907, 'US')
      const target = await start('CN-machine', 18917, 'CN')
      const blocked = await api(18917, '/api/hiveward/terminals', { project: root, agent: 'claude' })
      log('POST target /api/hiveward/terminals claude', blocked)
      assert.equal(blocked.status, 403)
      assert.equal(blocked.data.error.code, 'exit_region_blocked')
      assert.deepEqual(creates, [])
      const createdProject = await api(18917, '/api/businesses/project/projects', { name: '主线' })
      assert.equal(createdProject.status, 200)
      for (const args of [
        ['new', root, 'codex', '测试任务'],
        ['assign', 'Test project', 'test task']
      ]) {
        const r = await runProcess({
          program: process.execPath,
          args: ['hiveward/server/hiwd.mjs', ...args],
          env: { ...process.env, HIVEWARD_BRIDGE: 'http://127.0.0.1:18917' },
          timeoutMs: 15000
        })
        log(`hiwd ${args[0]} denied`, { code: r.code, stderr: r.stderr })
        assert.equal(r.code, 1)
        assert.match(r.stderr, /exit_region_blocked/)
      }
      const leader = await api(
        18917,
        `/api/businesses/project/projects/${createdProject.data.project.id}/leader`,
        { agent: 'claude' }
      )
      log('POST target /api/businesses/project/leader', leader)
      assert.equal(leader.status, 403)
      assert.deepEqual(creates, [])
      const invite = await api(18907, '/api/machines/invite', { address: '127.0.0.1:18918' })
      assert.equal(
        (await api(18917, `/api/machines/invitations/${invite.data.id}/accept`, {})).status,
        200
      )
      const remote = await api(18907, '/api/m/CN-machine/api/hiveward/terminals', {
        project: root,
        agent: 'codex'
      })
      log('US machine -> CN machine launch codex', remote)
      assert.equal(remote.status, 403)
      assert.deepEqual(creates, [])
      const cliRemote = await runProcess({
        program: process.execPath,
        args: ['hiveward/server/hiwd.mjs', '--on', 'CN-machine', 'new', root, 'claude', '测试任务'],
        env: { ...process.env, HIVEWARD_BRIDGE: 'http://127.0.0.1:18907' },
        timeoutMs: 15000
      })
      log('hiwd --on CN-machine new ... claude', { code: cliRemote.code, stderr: cliRemote.stderr })
      assert.equal(cliRemote.code, 1)
      assert.match(cliRemote.stderr, /environment_not_found/)
      assert.deepEqual(creates, [])
      assert.equal(
        (await api(18917, '/api/hiveward/terminals', { project: root, agent: 'kimi' })).status,
        200
      )
      assert.match(creates[0], /^kimi/)
      await writeFile(
        join(target, 'test-exit-region.json'),
        JSON.stringify({ country: null, revision: 2 })
      )
      const unknown = await api(18917, '/api/hiveward/terminals', { project: root, agent: 'claude' })
      log('unknown exit -> launch denied', unknown)
      assert.equal(unknown.status, 403)
      assert.equal(creates.length, 1)
      await writeFile(
        join(target, 'test-exit-region.json'),
        JSON.stringify({ country: 'CN', revision: 3 })
      )
      assert.equal(
        (
          await api(18917, '/api/exit-region/policy', {
            allowedCountries: { ...DEFAULT_EXIT_POLICY, claude: ['CN'] }
          })
        ).status,
        200
      )
      const changed = await api(18917, '/api/hiveward/terminals', { project: root, agent: 'claude' })
      log('policy claude=[CN] -> launch reaches RPC stub', changed)
      assert.equal(changed.status, 200)
      assert.equal(creates.length, 2)
      await api(18917, '/api/exit-region/policy', { allowedCountries: DEFAULT_EXIT_POLICY })
      manual = true
      let state
      for (let n = 0; n < 110; n++) {
        state = await api(18917, '/api/exit-region')
        if (state.data.warnings.length) {
          break
        }
        await pause(150)
      }
      log('manually recognized Claude -> warning', state)
      assert.equal(state.data.warnings[0].terminal, 'manual-claude')
      const native = (await readFile(join(target, 'test-warnings.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
      assert.equal(native.length, 1)
      assert.equal(native[0].agent, 'claude')
      assert.equal(creates.length, 2)
      const machines = await api(18917, '/api/machines')
      log('GET machines self region', machines.data.machines.find((m) => m.self).exitRegion)
      assert.equal(machines.data.machines.find((m) => m.self).exitRegion.country, 'CN')
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) {
            return
          }
          const ended = once(child, 'exit')
          child.kill('SIGTERM')
          await ended
        })
      )
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => runtime.close(resolve))
      await rm(root, { recursive: true, force: true })
      log('cleanup', { instancesStopped: children.length, removed: root })
    }
  }
)
