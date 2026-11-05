import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AUTOMATION_TARGET_FLAGS = [
  'repo',
  'workspace',
  'project',
  'host',
  'project-host-setup',
  'source-context',
  'workspace-mode',
  'base-branch',
  'setup'
]
const AUTOMATION_SCHEDULE_FLAGS = ['trigger', 'schedule', 'time', 'day', 'timezone']
const AUTOMATION_PRECHECK_FLAGS = ['precheck', 'precheck-timeout']
const AUTOMATION_STATE_FLAGS = [
  'enabled',
  'disabled',
  'missed-run-grace-minutes',
  'reuse-session',
  'fresh-session'
]

export const AUTOMATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['automations', 'list'],
    summary: 'List scheduled HiveWard automations',
    usage: 'hiveward automations list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['hiveward automations list', 'hiveward automations list --json']
  },
  {
    path: ['automations', 'show'],
    summary: 'Show one HiveWard automation',
    usage: 'hiveward automations show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward automations show 2f9e...', 'hiveward automations show --id 2f9e... --json']
  },
  {
    path: ['automations', 'create'],
    summary: 'Create a scheduled HiveWard automation',
    usage:
      'hiveward automations create --name <name> --trigger <preset|cron|rrule> --prompt <text> --provider <agent> [--precheck <command>] [--setup run|skip] [--repo <selector>|--workspace <selector>|--project <id-or-name> [--host <host>]|--project-host-setup <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    notes: [
      'Trigger accepts hourly, daily, weekdays, weekly, a 5-field cron expression, or an RRULE string.',
      'When --repo is omitted, the CLI uses the enclosing HiveWard worktree when one can be resolved from cwd.',
      'Use --project, or --project-host-setup, to run on a specific project host setup. --project takes the project id or the display name from `hiveward project list`, and --host is only needed when the project is set up on more than one host.',
      '--host takes local, ssh:<target-id>, runtime:<environment-id>, or the bare host name `hiveward host list` prints for any of them.',
      'Use --source-context with a JSON TaskSourceContext when task/provider data should come from a specific host/account; pass null on edit to clear it.',
      'Use --workspace to run in an existing worktree. With --repo or a project target, the automation creates a new worktree per run; with no target, a local create runs in the current HiveWard worktree unless you pass --workspace-mode new-per-run.',
      'Use --setup run|skip for repository setup on new-per-run automations. Explicit choices override the repository setup policy and need a host running current HiveWard. When omitted on create, no choice is saved; current HiveWard skips setup.',
      'Use --precheck to run a command only before scheduled runs; exit code 0 continues, any other exit, error, or timeout skips the run.',
      'Use --precheck-timeout <seconds> to set the time limit (default 60 seconds). Skips appear in HiveWard run history and hiveward automations runs --id <automation-id> as skipped_precheck.',
      'Run now in HiveWard and hiveward automations run intentionally bypass the precheck so you can test or override the scheduled condition.',
      'Use --reuse-session only with existing-workspace automations to submit later runs to the previous live automation session when it is still available. Use --fresh-session to disable reuse.',
      'Use --extra-agent-args="--model opus --effort high" to add arguments after the host\'s default agent Arguments on each fresh run. Only model, effort, and a few safe options are accepted (Claude, Codex, CodeBuddy, Cursor, Grok, OMP, Pi); extras cannot be combined with --reuse-session. On edit, --extra-agent-args= clears them.'
    ],
    examples: [
      'hiveward automations create --name "Daily review" --trigger daily --prompt "Review open changes" --provider codex',
      'hiveward automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo my-repo',
      'hiveward automations create --name "PR review" --trigger hourly --precheck "gh pr list --json number -q .[0].number" --prompt "Review requested PRs" --provider codex',
      'hiveward automations create --name "Docs pass" --trigger daily --prompt "Tidy the docs" --provider claude --extra-agent-args="--model opus --effort high --add-dir docs"'
    ]
  },
  {
    path: ['automations', 'edit'],
    summary: 'Edit an HiveWard automation',
    usage:
      'hiveward automations edit <id> [--name <name>] [--trigger <preset|cron|rrule>] [--setup run|skip] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    positionalArgs: ['id'],
    notes: [
      'Use --setup run|skip only for new-per-run automations. Omit it to preserve the saved setup choice.'
    ],
    examples: [
      'hiveward automations edit 2f9e... --disabled',
      'hiveward automations edit --id 2f9e... --trigger "30 * * * *" --json',
      'hiveward automations edit 2f9e... --extra-agent-args='
    ]
  },
  {
    path: ['automations', 'remove'],
    destructive: true,
    summary: 'Remove an HiveWard automation and its run history',
    usage: 'hiveward automations remove <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: [
      'hiveward automations remove 2f9e...',
      'hiveward automations remove --id 2f9e... --json'
    ]
  },
  {
    path: ['automations', 'run'],
    summary: 'Run an HiveWard automation now',
    usage: 'hiveward automations run <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      'Use the full automation UUID from hiveward automations list; shortened prefixes are not accepted.',
      'Like Run now in HiveWard, this manually starts a run without executing the precheck; prechecks gate scheduled runs only.',
      'A queued or dispatching run has been accepted but may not have a workspace or terminal yet. Use hiveward automations runs --id <automation-id> to follow its progress.'
    ],
    examples: [
      'hiveward automations run 497bafa9-5a97-4f85-9e48-2b211b8f31fa',
      'hiveward automations run --id 497bafa9-5a97-4f85-9e48-2b211b8f31fa --json'
    ]
  },
  {
    path: ['automations', 'runs'],
    summary: 'List automation run history',
    usage:
      'hiveward automations runs [--id <automation-id>] [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'limit', 'cursor'],
    notes: [
      'Without --limit or --cursor, reads the whole history in pages, so a large history from a paired server still fits in its replies.',
      'With --limit or --cursor, prints one page (newest first, at most 100 runs) and its nextCursor; pass that as --cursor for the next page.'
    ],
    examples: [
      'hiveward automations runs',
      'hiveward automations runs --id 2f9e... --json',
      'hiveward automations runs --limit 20 --json'
    ]
  }
]
