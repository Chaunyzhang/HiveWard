import { describe, expect, it } from 'vitest'
import { parseHiveWardBrowserCommand } from './hiveward-browser-cli-commands'

describe('parseHiveWardBrowserCommand', () => {
  it.each([
    ['hiveward click --element e3', null],
    ['hiveward snapshot --page p1', 'p1'],
    ['hiveward-dev fill --element e2 --text hi --page=p2', 'p2'],
    ["hiveward goto --url https://example.com --page='p3'", 'p3'],
    ['/Users/me/.local/bin/hiveward screenshot', null],
    ['C:\\Users\\me\\hiveward\\hiveward.cmd tab create', null],
    ['hiveward-ide mouse move --x 1 --y 2', null],
    ['cd app && hiveward click --element e3 --page p4', 'p4'],
    ['git status; HIVEWARD_DEBUG=1 hiveward tab list', null],
    ['hiveward snapshot | head -20', null],
    ['hiveward browser identity get', null]
  ])('matches %s', (command, pageId) => {
    expect(parseHiveWardBrowserCommand(command)).toEqual({ pageId })
  })

  it.each([
    'hiveward worktree ls',
    'hiveward terminal send --text "hiveward click"',
    'hivewardstra click',
    'hiveward',
    'echo hiveward click',
    'echo "docs; hiveward snapshot --page p1; text"',
    "git commit -m 'run hiveward click | hiveward snapshot'",
    'git log --oneline'
  ])('does not match %s', (command) => {
    expect(parseHiveWardBrowserCommand(command)).toBeNull()
  })
})
