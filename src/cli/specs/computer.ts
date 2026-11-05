import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const COMPUTER_FLAGS = [...GLOBAL_FLAGS, 'worktree', 'session', 'app']
const COMPUTER_WINDOW_TARGET_FLAGS = ['window-id', 'window-index']
const COMPUTER_OBSERVE_FLAGS = [
  ...COMPUTER_FLAGS,
  ...COMPUTER_WINDOW_TARGET_FLAGS,
  'restore-window',
  'no-screenshot'
]
const COMPUTER_ACTION_FLAGS = [...COMPUTER_OBSERVE_FLAGS, 'full-tree']

export const COMPUTER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['computer', 'capabilities'],
    summary: 'Show computer-use provider capabilities',
    usage: 'hiveward computer capabilities [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['computer', 'list-apps'],
    summary: 'List running apps available to computer-use',
    usage: 'hiveward computer list-apps [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['computer', 'permissions'],
    summary: 'Open computer-use permission setup',
    usage: 'hiveward computer permissions [--id <accessibility|screenshots>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  },
  {
    path: ['computer', 'list-windows'],
    summary: 'List windows for an app available to computer-use',
    usage: 'hiveward computer list-windows --app <name|bundle|pid:N> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'app']
  },
  {
    path: ['computer', 'get-app-state'],
    summary: 'Capture a compact accessibility snapshot of an app',
    usage:
      'hiveward computer get-app-state --app <name|bundle|pid:N> [--window-id <id> | --window-index <n>] [--worktree <selector> | --session <id>] [--query <text>] [--max-elements <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_OBSERVE_FLAGS, 'query', 'max-elements']
  },
  {
    path: ['computer', 'click'],
    summary: 'Click an app element or window coordinate, optionally with modifiers',
    usage:
      'hiveward computer click --app <app> (--element-index <n> | --x <x> --y <y>) [--window-id <id> | --window-index <n>] [--click-count <n>] [--mouse-button <left|right|middle>] [--modifiers <modifier-chord>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [
      ...COMPUTER_ACTION_FLAGS,
      'element-index',
      'x',
      'y',
      'click-count',
      'mouse-button',
      'modifiers'
    ]
  },
  {
    path: ['computer', 'perform-secondary-action'],
    summary: 'Perform an advertised secondary accessibility action',
    usage:
      'hiveward computer perform-secondary-action --app <app> --element-index <n> --action <name> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'action']
  },
  {
    path: ['computer', 'scroll'],
    summary: 'Scroll an app element or window coordinate',
    usage:
      'hiveward computer scroll --app <app> (--element-index <n> | --x <x> --y <y>) --direction <up|down|left|right> [--window-id <id> | --window-index <n>] [--pages <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'x', 'y', 'direction', 'pages']
  },
  {
    path: ['computer', 'drag'],
    summary: 'Drag between app elements or window coordinates',
    usage:
      'hiveward computer drag --app <app> (--from-element-index <n> --to-element-index <n> | --from-x <x> --from-y <y> --to-x <x> --to-y <y>) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [
      ...COMPUTER_ACTION_FLAGS,
      'from-element-index',
      'to-element-index',
      'from-x',
      'from-y',
      'to-x',
      'to-y'
    ]
  },
  {
    path: ['computer', 'type-text'],
    summary: 'Type literal text at the current app focus',
    usage:
      'hiveward computer type-text --app <app> (--text <text> | --text-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'text', 'text-stdin']
  },
  {
    path: ['computer', 'press-key'],
    summary: 'Press a single key such as Return or Escape',
    usage:
      'hiveward computer press-key --app <app> --key <key> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'key']
  },
  {
    path: ['computer', 'hotkey'],
    summary: 'Press a platform-aware key combination',
    usage:
      'hiveward computer hotkey --app <app> --key <key-combo> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'key']
  },
  {
    path: ['computer', 'paste-text'],
    summary: 'Paste exact text at the current app focus',
    usage:
      'hiveward computer paste-text --app <app> (--text <text> | --text-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'text', 'text-stdin']
  },
  {
    path: ['computer', 'set-value'],
    summary: 'Set the value of a settable app element',
    usage:
      'hiveward computer set-value --app <app> --element-index <n> (--value <text> | --value-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--full-tree] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'value', 'value-stdin']
  }
]
