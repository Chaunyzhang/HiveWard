import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FILE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['file', 'open'],
    summary:
      'Open a file as a tab in its worktree without changing your view; --focus brings you to it',
    usage:
      'hiveward file open <path> [--line <n> [--column <n>]] [--worktree <selector>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'line', 'column', 'worktree', 'focus'],
    positionalArgs: ['path'],
    notes: [
      '--line and --column use 1-based positions; --column requires --line. Without --focus, the position is applied when you select the file. Markdown opens in source view for positioning. Older hosts open the file without positioning.',
      'The file opens as a tab in that worktree without changing what you are looking at, even in the worktree on screen. --focus brings you to it; agents should pass --focus only when the user asked to see the file.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree. When --worktree is omitted, local CLI calls infer the current HiveWard worktree from cwd.',
      'A server with no app window (`hiveward serve`, hivewardd) cannot open tabs, so this fails with renderer_unavailable and opens nothing.'
    ],
    examples: [
      'hiveward file open src/App.tsx',
      'hiveward file open src/App.tsx --line 42 --column 7 --focus',
      'hiveward file open --path docs/readme.md --worktree active --focus'
    ]
  },
  {
    path: ['file', 'diff'],
    summary:
      'Open a file diff as a tab in its worktree without changing your view; --focus brings you to it',
    usage: 'hiveward file diff <path> [--staged] [--worktree <selector>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'staged', 'worktree', 'focus'],
    positionalArgs: ['path'],
    notes: [
      'The file opens as a tab in that worktree without changing what you are looking at, even in the worktree on screen. --focus brings you to it; agents should pass --focus only when the user asked to see the file.',
      'Diffs default to unstaged changes. Pass --staged to open the staged source-control diff.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree.'
    ],
    examples: [
      'hiveward file diff src/App.tsx',
      'hiveward file diff --path package.json --staged --worktree branch:feature'
    ]
  },
  {
    path: ['file', 'open-changed'],
    summary:
      'Open all git-changed files as tabs without changing your view; --focus brings you to them',
    usage:
      'hiveward file open-changed [--mode edit|diff|both] [--worktree <selector>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mode', 'worktree', 'focus'],
    notes: [
      'The files open as tabs in that worktree without changing what you are looking at, even in the worktree on screen. --focus brings you to them; agents should pass --focus only when the user asked to see the files.',
      'For v1, changed files come from git status for the selected worktree.',
      'The default mode is diff. Edit mode skips deleted files because there is no file to open.'
    ],
    examples: [
      'hiveward file open-changed',
      'hiveward file open-changed --mode both',
      'hiveward file open-changed --mode diff --worktree active'
    ]
  }
]
