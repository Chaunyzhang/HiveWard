import { runProcess } from '@hiveward/process-host'
import { escapeRegex } from '../../shared/string-utils'

export async function stopMacOSPermissionStatusHelper(statusPath: string): Promise<void> {
  // The unique status path isolates this completed probe from other probes and setup helpers.
  await runProcess({
    program: '/usr/bin/pkill',
    args: [
      '-f',
      `(^|[[:space:]/])hiveward-computer-use-macos[[:space:]]+--permission-status-file[[:space:]]+${escapeRegex(statusPath)}$`
    ],
    timeoutMs: 2_000,
    stdio: 'ignore'
  }).catch(() => undefined)
}
