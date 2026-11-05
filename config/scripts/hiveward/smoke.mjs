import { call } from './rpc.mjs'
import { writeFileSync } from 'node:fs'
const evidence = {}
async function checked(method, params) {
  const response = await call(method, params)
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  }
  return response.result
}
evidence.status = await checked('status.get')
evidence.repo = await checked('repo.add', { path: process.cwd() })
evidence.created = await checked('terminal.create', {
  worktree: `path:${process.cwd()}`,
  title: 'HiveWard package verification',
  presentation: 'background'
})
const terminal = evidence.created.terminal.handle
try {
  evidence.sent = await checked('terminal.send', {
    terminal,
    text: 'printf "HIVEWARD_PTY_OK\\n"; claude --version',
    enter: true
  })
  for (let attempt = 0; attempt < 30; attempt++) {
    evidence.read = await checked('terminal.read', { terminal, screen: true })
    if (evidence.read.terminal.tail.some((line) => line.includes('(Claude Code)'))) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!evidence.read.terminal.tail.some((line) => line.includes('(Claude Code)'))) {
    throw new Error('Claude version output missing')
  }
  evidence.process = await checked('terminal.inspectProcess', { terminal })
  evidence.agentStatus = await checked('terminal.agentStatus', { terminal })
  evidence.terminals = await checked('terminal.list')
  evidence.worktrees = await checked('worktree.list')
  evidence.inbox = await checked('orchestration.inbox', { limit: 10 })
} finally {
  evidence.closed = await checked('terminal.close', { terminal })
  writeFileSync(
    'docs/hiveward/evidence/packaged-smoke.json',
    `${JSON.stringify(evidence, null, 2)}\n`
  )
}
console.log(
  JSON.stringify(
    {
      runtimeId: evidence.status.runtimeId,
      terminal,
      tail: evidence.read.terminal.tail,
      closed: evidence.closed
    },
    null,
    2
  )
)
