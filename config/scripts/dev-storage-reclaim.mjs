import { resolve } from 'node:path'
import { spawnProcess } from '@hiveward/process-host'

export function startDevStorageReclaim({
  repoRoot,
  env = process.env,
  spawn = spawnProcess,
  report = console.error
}) {
  if (env.HIVEWARD_SKIP_DEV_STORAGE_RECLAIM === '1') {
    return
  }
  try {
    // The worker owns its lock after dev exits and must not keep captured dev output open.
    const child = spawn({
      program: process.execPath,
      args: [
        resolve(import.meta.dirname, 'reclaim-worktree-space.mjs'),
        '--repo',
        repoRoot,
        '--exclude-worktree',
        repoRoot,
        '--automatic',
        '--apply'
      ],
      cwd: repoRoot,
      env,
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', (error) => report(`[hiveward-dev] Storage cleanup skipped: ${error.message}`))
    child.on('exit', (code) => {
      if (code !== 0) {
        report('[hiveward-dev] Storage cleanup did not finish; retry with pnpm reclaim-space.')
      }
    })
    child.unref()
  } catch (error) {
    report(`[hiveward-dev] Storage cleanup skipped: ${error.message}`)
  }
}
