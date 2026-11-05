import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isRootLikePath } from '../providers/pty-path-safety'

// Folder names predate the generic probe naming; keep them so existing dirs are reused.
const HIDDEN_PROBE_CWD_DIR = 'rate-limit-pty-cwd'
const WSL_HIDDEN_PROBE_CWD_DIR = 'hiveward-rate-limit-pty-cwd'

// Never let hidden Claude discovery start at a filesystem root; bound cwd to userData or tmpdir (runaway-cpu-hidden-usage-pty-design.md).
function resolveUserDataRoot(userDataPath?: string | null): string {
  const root = userDataPath?.trim() || process.env.HIVEWARD_USER_DATA_PATH?.trim()
  if (root && !isRootLikePath(root)) {
    return root
  }
  return join(tmpdir(), 'hiveward-rate-limit-pty')
}

export function resolveHiddenProbeCwd(options?: { userDataPath?: string | null }): string {
  const cwd = join(resolveUserDataRoot(options?.userDataPath), HIDDEN_PROBE_CWD_DIR)
  mkdirSync(cwd, { recursive: true })
  const realCwd = realpathSync(cwd)
  if (isRootLikePath(realCwd) || !statSync(realCwd).isDirectory()) {
    throw new Error(`Hidden probe cwd is not a safe directory: ${realCwd}`)
  }
  return realCwd
}

export function getHiddenProbeWslCwdSetupCommands(): string[] {
  return [
    `hiveward_rate_limit_cwd="\${TMPDIR:-/tmp}/${WSL_HIDDEN_PROBE_CWD_DIR}"`,
    'mkdir -p "$hiveward_rate_limit_cwd"',
    'cd "$hiveward_rate_limit_cwd"'
  ]
}
