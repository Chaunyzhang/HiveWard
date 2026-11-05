import { afterEach, expect, it } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCodeTuiPluginDirName, writeOpenCodeTuiPlugin } from './opencode-tui-plugin-install'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function linkedEntry(): { plugins: string; entry: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-tui-install-'))
  roots.push(root)
  const plugins = join(root, 'plugins')
  const entry = join(plugins, openCodeTuiPluginDirName('hiveward-status.js'), 'tui.js')
  const target = join(root, 'user-plugin.js')
  mkdirSync(join(plugins, openCodeTuiPluginDirName('hiveward-status.js')), { recursive: true })
  writeFileSync(target, 'old')
  symlinkSync(target, entry)
  return { plugins, entry, target }
}

it.skipIf(process.platform === 'win32')(
  'updates a canonical TUI symlink target and preserves the link',
  () => {
    const { plugins, entry, target } = linkedEntry()
    writeOpenCodeTuiPlugin(plugins, 'hiveward-status.js', 'new')
    expect(lstatSync(entry).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('new')
  }
)

it.skipIf(process.platform === 'win32')(
  'detaches an overlay TUI link even when its user bytes match',
  () => {
    const { plugins, entry, target } = linkedEntry()
    writeOpenCodeTuiPlugin(plugins, 'hiveward-status.js', 'old', 'overlay')
    expect(lstatSync(entry).isFile()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('old')
  }
)

it('does not reload a current TUI plugin by changing its timestamp', () => {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-tui-install-'))
  roots.push(root)
  writeOpenCodeTuiPlugin(root, 'hiveward-status.js', 'current')
  const entry = join(root, openCodeTuiPluginDirName('hiveward-status.js'), 'tui.js')
  const before = statSync(entry).mtimeMs
  writeOpenCodeTuiPlugin(root, 'hiveward-status.js', 'current')
  expect(statSync(entry).mtimeMs).toBe(before)
})
