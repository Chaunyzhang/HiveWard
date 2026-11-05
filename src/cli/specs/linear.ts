import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { LINEAR_MCP_COMMAND_SPECS } from './linear-mcp'

export const LINEAR_COMMAND_SPECS: CommandSpec[] = [
  ...LINEAR_MCP_COMMAND_SPECS,
  {
    path: ['linear', 'issue'],
    summary: 'Read Linear issue context for agents',
    usage:
      'hiveward linear issue [<id>] [--current] [--comments] [--children] [--depth <n>] [--attachments] [--relations] [--activity] [--full] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'current',
      'comments',
      'children',
      'depth',
      'attachments',
      'relations',
      'activity',
      'full',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'hiveward linear issue ENG-123',
      'hiveward linear issue --current --comments',
      'hiveward linear issue https://linear.app/acme/issue/ENG-123 --full --json'
    ]
  },
  {
    path: ['linear', 'search'],
    summary: 'Search connected Linear workspaces',
    usage: 'hiveward linear search <query> [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'workspace', 'query'],
    positionalArgs: ['query'],
    examples: [
      'hiveward linear search "auth bug"',
      'hiveward linear search ENG --workspace all --json'
    ]
  },
  {
    path: ['linear', 'team', 'list'],
    summary: 'List connected Linear teams',
    usage: 'hiveward linear team list [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace'],
    examples: ['hiveward linear team list --workspace all --json']
  },
  {
    path: ['linear', 'team', 'members'],
    summary: 'List Linear team members',
    usage: 'hiveward linear team members --team <key|id> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'team', 'workspace'],
    examples: ['hiveward linear team members --team ENG --json']
  },
  {
    path: ['linear', 'team', 'states'],
    summary: 'List Linear team workflow states',
    usage: 'hiveward linear team states --team <key|id> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'team', 'workspace'],
    examples: ['hiveward linear team states --team ENG --json']
  },
  {
    path: ['linear', 'team', 'labels'],
    summary: 'List Linear team labels',
    usage: 'hiveward linear team labels --team <key|id> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'team', 'workspace'],
    examples: ['hiveward linear team labels --team ENG --json']
  },
  {
    path: ['linear', 'project', 'list'],
    summary: 'List connected Linear projects',
    usage:
      'hiveward linear project list [--query <text>] [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'workspace'],
    examples: [
      'hiveward linear project list --query launch --json',
      'hiveward linear project list --workspace all --json'
    ]
  },
  {
    path: ['linear', 'list'],
    summary: 'List Linear issues for task triage',
    usage:
      'hiveward linear list [--filter assigned|created|all|completed|open] [--team <key|id>] [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'filter', 'team', 'limit', 'workspace'],
    examples: ['hiveward linear list --filter assigned --limit 10 --json']
  },
  {
    path: ['linear', 'status', 'set'],
    summary: 'Set a Linear issue status',
    usage: 'hiveward linear status set [<id>] [--current] --to <state> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'hiveward linear status set ENG-123 --to "In Review"',
      'hiveward linear status set --current --to Done --json'
    ]
  },
  {
    path: ['linear', 'assignee', 'set'],
    summary: 'Assign a Linear issue',
    usage:
      'hiveward linear assignee set [<id>] [--current] (--me | --to-id <userId>) [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'me', 'to-id', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear assignee set --current --me --json']
  },
  {
    path: ['linear', 'assignee', 'clear'],
    summary: 'Clear a Linear issue assignee',
    usage: 'hiveward linear assignee clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear assignee clear ENG-123 --json']
  },
  {
    path: ['linear', 'priority', 'set'],
    summary: 'Set a Linear issue priority',
    usage:
      'hiveward linear priority set [<id>] [--current] --to none|low|medium|high|urgent [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear priority set --current --to high --json']
  },
  {
    path: ['linear', 'priority', 'clear'],
    summary: 'Clear a Linear issue priority',
    usage: 'hiveward linear priority clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear priority clear ENG-123 --json']
  },
  {
    path: ['linear', 'estimate', 'set'],
    summary: 'Set a Linear issue estimate',
    usage:
      'hiveward linear estimate set [<id>] [--current] --to <number> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear estimate set --current --to 3 --json']
  },
  {
    path: ['linear', 'estimate', 'clear'],
    summary: 'Clear a Linear issue estimate',
    usage: 'hiveward linear estimate clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear estimate clear ENG-123 --json']
  },
  {
    path: ['linear', 'due-date', 'set'],
    summary: 'Set a Linear issue due date',
    usage:
      'hiveward linear due-date set [<id>] [--current] --to <yyyy-mm-dd> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear due-date set --current --to 2026-06-30 --json']
  },
  {
    path: ['linear', 'due-date', 'clear'],
    summary: 'Clear a Linear issue due date',
    usage: 'hiveward linear due-date clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear due-date clear ENG-123 --json']
  },
  {
    path: ['linear', 'label', 'add'],
    summary: 'Add labels to a Linear issue',
    usage:
      'hiveward linear label add [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'label', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear label add --current --label Bug --json']
  },
  {
    path: ['linear', 'label', 'remove'],
    summary: 'Remove labels from a Linear issue',
    usage:
      'hiveward linear label remove [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'label', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear label remove --current --label Bug --json']
  },
  {
    path: ['linear', 'label', 'set'],
    summary: 'Replace labels on a Linear issue',
    usage:
      'hiveward linear label set [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'label', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear label set ENG-123 --label Bug --json']
  },
  {
    path: ['linear', 'comment', 'add'],
    summary: 'Add a comment to a Linear issue',
    usage:
      'hiveward linear comment add [<id>] [--current] (--body <text> | --body-file <path|->) [--reply-to <commentId>] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'current',
      'body',
      'body-file',
      'reply-to',
      'write-id',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'hiveward linear comment add ENG-123 --body "Implementation is ready for review."',
      'hiveward linear comment add --current --body-file - --json'
    ],
    notes: ['Use --body-file - to read multiline comment bodies from stdin.']
  },
  {
    path: ['linear', 'comment', 'edit'],
    summary: 'Replace the body of a Linear comment',
    usage:
      'hiveward linear comment edit <commentId> (--body <text> | --body-file <path|->) [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'body', 'body-file', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'hiveward linear comment edit <commentId> --body "Updated: ready for review."',
      'hiveward linear comment edit <commentId> --body-file - --json'
    ],
    notes: [
      'Comment ids come from `comment add` output or `hiveward linear issue <id> --comments --json`.',
      'Linear only lets a comment be edited by its author.'
    ]
  },
  {
    path: ['linear', 'comment', 'delete'],
    destructive: true,
    aliases: [['linear', 'comment', 'rm']],
    summary: 'Delete a Linear comment',
    usage: 'hiveward linear comment delete <commentId> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['hiveward linear comment delete <commentId> --json'],
    notes: [
      'Comment ids come from `comment add` output or `hiveward linear issue <id> --comments --json`.'
    ]
  },
  {
    path: ['linear', 'attach'],
    summary: 'Attach a link to a Linear issue',
    usage:
      'hiveward linear attach [<id>] [--current] --url <url> [--title <title>] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'url', 'title', 'write-id', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'hiveward linear attach ENG-123 --url https://example.com/review/123 --title "PR/MR link"',
      'hiveward linear attach --current --url https://example.com/review/123 --json'
    ]
  },
  {
    path: ['linear', 'create'],
    summary: 'Create a Linear issue',
    usage:
      'hiveward linear create --title <title> [--body <text> | --body-file <path|->] [--team <key|id>] [--project <projectId-or-exact-name>] [--state <stateId|exact-name>] [--assignee me|<userId>] [--priority none|low|medium|high|urgent] [--estimate <number>] [--due-date <yyyy-mm-dd>] [--label <labelId-or-exact-name>]... [--parent <id> | --parent-current] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'title',
      'body',
      'body-file',
      'team',
      'project',
      'state',
      'assignee',
      'priority',
      'estimate',
      'due-date',
      'label',
      'parent',
      'parent-current',
      'write-id',
      'workspace'
    ],
    examples: [
      'hiveward linear create --title "Investigate flaky login" --team ENG --project "Launch"',
      'hiveward linear create --title "Follow-up bug" --parent-current --body-file - --json'
    ],
    notes: ['Use --body-file - to read multiline issue bodies from stdin.']
  }
]
