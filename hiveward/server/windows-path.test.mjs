import test from 'node:test'
import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import { containsPath, pathKey, validProjectDir } from './workspace-path.mjs'
import { transcriptCwdMatches } from './transcripts.mjs'
import { configureTerminalCli, terminalCliParams } from './terminal-cli.mjs'

test('Windows drive, UNC, case and separator comparisons keep ownership inside a root', () => {
  assert.equal(pathKey('C:/Work/./Project', win32), 'c:\\work\\project')
  for (const child of ['c:\\WORK\\Project\\src', 'C:/Work/Project']) {
    assert.equal(containsPath('C:\\Work\\Project', child, win32), true)
  }
  for (const child of [
    'C:\\Work\\Project-other',
    'D:\\Work\\Project',
    'C:\\Work\\Project\\..\\secret'
  ]) {
    assert.equal(containsPath('C:\\Work\\Project', child, win32), false)
  }
  assert.equal(containsPath('\\\\host\\share\\root', '\\\\HOST\\share\\ROOT\\child', win32), true)
  assert.equal(containsPath('\\\\host\\share\\root', '\\\\host\\other\\root', win32), false)
})

test('project directories reject Windows absolute, drive-relative, ADS and traversal paths', () => {
  for (const dir of [
    '..',
    'a\\..\\b',
    'a/../b',
    'C:\\foo',
    'C:foo',
    '\\\\host\\share',
    '\\foo',
    '/foo',
    'a:stream',
    'a\0b'
  ]) {
    assert.equal(validProjectDir(dir, win32), false, dir)
  }
  assert.equal(validProjectDir('nested\\project', win32), true)
})

test('Codex metadata parses JSON escaped Windows paths and spaces', () => {
  const cwd = 'C:\\Users\\Owner\\My Project'
  assert.equal(transcriptCwdMatches(JSON.stringify({ payload: { cwd } }), cwd), true)
  assert.equal(
    transcriptCwdMatches(JSON.stringify({ payload: { cwd: `${cwd} Other` } }), cwd),
    false
  )
})

test('Windows agent terminals receive PowerShell, CLI shim and common user install locations', () => {
  configureTerminalCli('C:\\HiveWard\\resources\\hiveward\\bin')
  const p = terminalCliParams(
    {},
    {
      Path: 'C:\\Windows',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\me',
      HIVEWARD_EXECUTABLE: 'C:\\HiveWard\\HiveWard.exe'
    },
    'win32'
  )
  assert.equal(p.shell, 'powershell.exe')
  assert.equal(p.env.HIVEWARD_EXECUTABLE, 'C:\\HiveWard\\HiveWard.exe')
  assert.match(p.env.Path, /resources\\hiveward\\bin/)
  assert.match(p.env.Path, /Roaming\\npm/)
  assert.match(p.env.Path, /me\\.local\\bin/)
})
