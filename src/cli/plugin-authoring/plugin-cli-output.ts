import { isAbsolute, resolve } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/types'
import { writeStdoutLine } from '../stdout-line'

/** One `{ ok, result }` object on stdout for --json; plain text otherwise. */
export function printPluginResult(ctx: HandlerContext, result: unknown, text: string): void {
  writeStdoutLine(ctx.json ? JSON.stringify({ ok: true, result }, null, 2) : text)
}

export function requirePluginPathArg(ctx: HandlerContext, flag: string): string {
  const value = ctx.flags.get(flag)
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeClientError('invalid_argument', `Missing <${flag}>.`)
  }
  return value
}

/**
 * Authoring commands read and write the files of the machine that runs them. Why refuse a bridged
 * shell: there the CLI runs on the HiveWard host, so the caller's paths would name the wrong machine.
 */
export function resolveLocalPluginPath(
  ctx: HandlerContext,
  value: string,
  command: string
): string {
  rejectRemoteSelectionFlags(ctx.flags, `hiveward plugin ${command}; it works on local files`)
  if (process.env.HIVEWARD_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      `hiveward plugin ${command} works on the files of the machine that runs it, but this shell forwards hiveward to the HiveWard host. Write and check the plugin files on this machine directly, or run the command on the HiveWard host.`
    )
  }
  return isAbsolute(value) ? value : resolve(ctx.cwd, value)
}
