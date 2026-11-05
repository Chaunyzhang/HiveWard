import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: "Prepare a WSL pane's HiveWard-managed Codex home before a shell launch",
    usage: 'hiveward agent hooks prepare-codex',
    allowedFlags: [...LOCAL_COMMAND_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether HiveWard-managed agent status hooks are enabled',
    usage: 'hiveward agent hooks status [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    examples: ['hiveward agent hooks status', 'hiveward agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable HiveWard-managed agent status hooks and remove local hook entries',
    usage: 'hiveward agent hooks off [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    examples: ['hiveward agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable HiveWard-managed agent status hooks',
    usage: 'hiveward agent hooks on [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    examples: ['hiveward agent hooks on']
  }
]
