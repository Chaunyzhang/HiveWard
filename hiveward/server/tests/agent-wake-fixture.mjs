import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const terminalSeat = (terminal) => ({
  terminal,
  occupant: { kind: 'terminal', terminal },
  agent: 'claude',
  liveness: 'live',
  state: 'idle',
  startedAt: new Date().toISOString()
})

export const sessionSeat = (sessionId, cwd) => ({
  occupant: { kind: 'session', sessionId, agent: 'claude', cwd },
  agent: 'claude',
  liveness: 'unverifiable',
  state: 'idle',
  startedAt: new Date().toISOString()
})

export async function startAgentWakeRuntime({
  root,
  workspace,
  terminals,
  statuses,
  screens,
  sends,
  closes
}) {
  const sockets = new Set()
  const repos = [{ id: 'repo', path: workspace, displayName: '唤醒业务', kind: 'folder' }]
  const respond = ({ method, params = {} }) => {
    switch (method) {
      case 'notifications.getMissedSince':
        return { epoch: 'agent-wake', notifications: [] }
      case 'repo.list':
        return { repos }
      case 'repo.add': {
        const repo = { id: `repo-${repos.length}`, ...params }
        repos.push(repo)
        return { repo }
      }
      case 'repo.update':
        return {}
      case 'terminal.send':
        sends.push(params)
        return {}
      case 'status.get':
        return { appVersion: 'stub', graphStatus: 'ready' }
      case 'terminal.list':
        return { terminals }
      case 'terminal.agentStatus': {
        const current = statuses.get(params.terminal) ?? 'idle'
        return {
          agentStatus: {
            isRunningAgent: true,
            ...(typeof current === 'string' ? { status: current } : current)
          }
        }
      }
      case 'terminal.read':
        return {
          terminal: {
            tail: screens.get(params.terminal) ?? ['ready'],
            status: 'running'
          }
        }
      case 'terminal.inspectProcess':
        return { process: { hasChildProcesses: true, foregroundProcess: 'claude' } }
      case 'terminal.close':
        closes.push(params.terminal)
        return {}
      case 'worktree.list':
        return { worktrees: [] }
      case 'orchestration.runList':
        return { runs: [] }
      case 'orchestration.inbox':
        return { messages: [] }
      default:
        return undefined
    }
  }
  const socketPath = join(root, 'runtime.sock')
  const runtime = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        let result
        let error
        try {
          result = respond(request)
        } catch (cause) {
          error = { code: cause.code ?? 'stub_error', message: cause.message }
        }
        if (result === undefined && !error) {
          error = { code: 'method_not_found', message: request.method }
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: !error, result, error })}\n`)
      }
    })
  })
  runtime.listen(socketPath)
  await once(runtime, 'listening')
  const meta = join(root, 'runtime.json')
  await writeFile(
    meta,
    JSON.stringify({ authToken: 'test', transports: [{ kind: 'unix', endpoint: socketPath }] })
  )
  return { runtime, sockets, meta }
}

export function createAgentWakeCli({ hiwd, home, data, meta, workspace, getBase }) {
  const children = new Set()
  const cliProcess = (args, options = {}) => {
    const env = {
      ...process.env,
      HOME: home,
      HIVEWARD_BRIDGE: getBase(),
      HIVEWARD_DATA_DIR: data,
      HIVEWARD_RUNTIME_META: meta,
      HIVEWARD_BACKGROUND_LAUNCH: '1'
    }
    for (const key of [
      'HIVEWARD_TERMINAL_HANDLE',
      'HIVEWARD_DISPATCHER',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CODEX_THREAD_ID'
    ]) {
      delete env[key]
    }
    if (options.session) {
      env.CLAUDE_CODE_SESSION_ID = options.session
    }
    if (options.codex) {
      env.CODEX_THREAD_ID = options.codex
    }
    if (options.terminal) {
      env.HIVEWARD_TERMINAL_HANDLE = options.terminal
    }
    const child = spawn(process.execPath, [hiwd, ...args], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.add(child)
    const result = new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', reject)
      child.on('close', (code, signal) => {
        children.delete(child)
        resolve({ code, signal, stdout, stderr })
      })
    })
    return { child, result }
  }
  const cli = async (args, options = {}) => {
    const running = cliProcess(args, options)
    const timer = setTimeout(() => running.child.kill(), 15_000)
    try {
      return await running.result
    } finally {
      clearTimeout(timer)
    }
  }
  return { children, cliProcess, cli }
}

export async function seedAgentWakeData(data, workspace) {
  await writeFile(
    join(data, 'businesses.json'),
    JSON.stringify([
      {
        id: 'business',
        name: '唤醒业务',
        nameSource: 'user',
        workspacePath: workspace,
        status: 'active',
        priority: 1,
        leaderAgent: 'claude',
        runIds: [],
        ceo: terminalSeat('ceo-terminal'),
        updatedAt: new Date().toISOString()
      }
    ])
  )
  await writeFile(
    join(data, 'business-projects.json'),
    JSON.stringify({
      projects: [
        {
          id: 'project',
          businessId: 'business',
          name: '唤醒项目',
          path: workspace,
          status: 'active',
          leader: terminalSeat('leader-terminal'),
          counts: { workersLive: 0, dispatches: 0, dispatchesDone: 0 },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      migrated: ['business'],
      bindings: { 'leader-terminal': 'project' }
    })
  )
  await writeFile(join(data, 'dispatches.json'), '[]')
}

export function createAgentWakeReviewSeeder({ data, workspace, invalidate, api }) {
  return async (id, by, round = 1, report = {}) => {
    const file = join(data, 'dispatches.json')
    const rows = JSON.parse(await readFile(file, 'utf8'))
    const value = {
      id,
      handle: `worker-${id}`,
      projectId: 'project',
      project: workspace,
      prompt: `任务 ${id}`,
      title: `标题 ${id}`,
      by,
      status: 'completed',
      report: {
        outcome: 'succeeded',
        summary: report.summary ?? `汇报 ${id}`,
        reportedAt: report.reportedAt ?? new Date().toISOString()
      },
      review: {
        state: 'awaiting',
        reviewer: by.kind === 'owner' ? 'owner' : 'dispatcher',
        round
      },
      at: new Date().toISOString()
    }
    const existing = rows.find((row) => row.id === id)
    if (existing) {
      Object.assign(existing, value)
    } else {
      rows.push(value)
    }
    await writeFile(file, JSON.stringify(rows))
    invalidate()
    const result = await api('/api/tasks')
    if (result.status !== 200) {
      throw new Error(JSON.stringify(result))
    }
  }
}
