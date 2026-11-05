// Decorate logged errors with a bounded redacted host tail, never telemetry; missing host evidence preserves the original failure.
import { redactString } from '../../observability/redactor'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { HIVEWARDD_LOG_FILENAME } from './hivewardd-remote-host-support'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  hivewarddWindowsSlotOpCommand,
  readHivewarddWindowsEncodedAnswer
} from './hivewardd-remote-windows-node'
import { HIVEWARDD_WINDOWS_LOG_TAIL_MARKER } from '../host-state/hivewardd-windows-host-script'
import type { HivewarddRemoteExecTarget } from './hivewardd-remote-runtime-control'

export const HIVEWARDD_LOG_TAIL_LINES = 40
export const HIVEWARDD_LOG_TAIL_MAX_BYTES = 8 * 1024
// Error decoration must not add an unbounded delay.
const HIVEWARDD_LOG_TAIL_TIMEOUT_MS = 10_000

export function hivewarddLogTailCommand(host: RemoteHostPlatform, slotDir: string): string {
  const log = joinRemotePath(host, slotDir, HIVEWARDD_LOG_FILENAME)
  if (isWindowsRemoteHost(host)) {
    return hivewarddWindowsSlotOpCommand(host, slotDir, 'log-tail', [
      log,
      String(HIVEWARDD_LOG_TAIL_MAX_BYTES)
    ])
  }
  return `tail -c ${HIVEWARDD_LOG_TAIL_MAX_BYTES} ${quotePosixShell(log)} 2>/dev/null || true`
}

export function parseHivewarddLogTail(host: RemoteHostPlatform, output: string): string | null {
  const raw = isWindowsRemoteHost(host)
    ? (readHivewarddWindowsEncodedAnswer(output, HIVEWARDD_WINDOWS_LOG_TAIL_MARKER) ?? '')
    : output
  const bounded = Buffer.from(raw, 'utf8').subarray(-HIVEWARDD_LOG_TAIL_MAX_BYTES).toString('utf8')
  const lines = bounded.replace(/\s+$/u, '').split(/\r?\n/u).slice(-HIVEWARDD_LOG_TAIL_LINES)
  const tail = redactString(lines.join('\n'))
  return tail.trim() ? tail : null
}

async function readHivewarddLogTail(
  target: HivewarddRemoteExecTarget,
  slotDir: string
): Promise<string | null> {
  try {
    // Observe cancellation failures without reusing the already-aborted request signal.
    const output = await execCommand(target.conn, hivewarddLogTailCommand(target.host, slotDir), {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: HIVEWARDD_LOG_TAIL_TIMEOUT_MS
    })
    return parseHivewarddLogTail(target.host, output)
  } catch (error) {
    console.warn('[ssh] Could not read the hivewardd.log tail:', error)
    return null
  }
}

export async function withHivewarddLogTail(
  target: HivewarddRemoteExecTarget,
  slotDir: string,
  message: string
): Promise<string> {
  const tail = await readHivewarddLogTail(target, slotDir)
  return tail ? `${message}\nLast lines of hivewardd.log:\n${tail}` : message
}
