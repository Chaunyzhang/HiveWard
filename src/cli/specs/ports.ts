import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PORTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ports'],
    summary: 'List the listening ports HiveWard detected for a workspace',
    usage: 'hiveward ports [--worktree <selector>] [--all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'all'],
    notes: [
      'Defaults to the HiveWard workspace that contains the current directory.',
      'Scans the host the workspace runs on and lists the ports HiveWard tied to it, by process working directory (match=cwd) or command line (match=command).',
      '--all lists every listener found on that host, including other workspaces and processes HiveWard could not tie to one. A native folder workspace needs --all, because HiveWard does not tie ports to folders.',
      'url is the address the dev server printed in an HiveWard terminal; it is missing when HiveWard did not see one.'
    ],
    examples: [
      'hiveward ports',
      'hiveward ports --worktree branch:feature/login --json',
      'hiveward ports --all',
      "hiveward ports --json | jq -r '.result.ports[0].advertisedUrl'"
    ]
  }
]
