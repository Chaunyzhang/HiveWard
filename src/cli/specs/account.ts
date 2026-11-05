import { LOCAL_COMMAND_FLAGS, type CommandSpec } from '../args'

// Terminal login lets headless hosts manage accounts without the desktop login UI.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed agent account by signing in on this HiveWard host',
    usage:
      'hiveward account add [--agent claude|codex|opencode|devin] [--label <name>] [--integration <id>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'label', 'integration'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local HiveWard runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'OpenCode 2 uses `opencode auth login --standalone` in private XDG directories. Devin uses `devin auth login --force-manual-token-flow`.',
      'Use --integration <id> to skip the OpenCode integration picker; --label names the saved OpenCode or Devin profile.',
      'OpenCode and Devin profiles apply to new explicit host agent launches. Direct SSH relay and Windows-hosted WSL selection are not supported; run the command on a headless HiveWard runtime on that host.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the HiveWard runtime to be running on this machine.'
    ],
    examples: ['hiveward account add', 'hiveward account add --agent codex']
  },
  {
    path: ['account', 'list'],
    summary: 'List managed agent accounts on this HiveWard host',
    usage: 'hiveward account list [--agent opencode|devin] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent'],
    notes: [
      'Lists the accounts on this machine. `--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['hiveward account list']
  },
  {
    path: ['account', 'select'],
    summary: 'Select an OpenCode or Devin profile for new agent launches',
    usage: 'hiveward account select --agent opencode|devin --account <id|system> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account']
  },
  {
    path: ['account', 'rm'],
    aliases: [['account', 'remove']],
    destructive: true,
    summary: 'Remove a managed OpenCode or Devin profile and its private data',
    usage: 'hiveward account rm --agent opencode|devin --account <id> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account'],
    notes: [
      'Deletes credentials and conversation data in the managed profile. Stop its running agents first. System credentials are never removed.'
    ]
  }
]
