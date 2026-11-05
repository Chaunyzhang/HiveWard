import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function escapeWindowsBatchValue(value) {
  // Why: cmd.exe expands %NAME% even inside quotes, so literal path percent signs must be doubled.
  return value.replaceAll('%', '%%')
}

export function prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath,
  electronExecutable,
  platform = process.platform
}) {
  const binDir = path.join(repoRoot, 'out', 'bin')
  const userDataBinDir = path.join(userDataPath, 'cli', 'bin')
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(userDataBinDir, { recursive: true })

  if (platform === 'win32') {
    const wrapperContent = `@echo off\r\nset "HIVEWARD_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"\r\nset "HIVEWARD_DEV_CLI_INVOCATION=1"\r\nset "HIVEWARD_APP_EXECUTABLE=${escapeWindowsBatchValue(electronExecutable)}"\r\nset "HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\nnode "${escapeWindowsBatchValue(cliPath)}" %*\r\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['hiveward-dev.cmd', 'hiveward.cmd']) {
        writeFileSync(path.join(targetDir, commandName), wrapperContent, 'utf8')
      }
    }
  } else {
    const wrapperContent = `#!/usr/bin/env bash\nexport HIVEWARD_USER_DATA_PATH=${JSON.stringify(userDataPath)}\nexport HIVEWARD_DEV_CLI_INVOCATION=1\nexport HIVEWARD_APP_EXECUTABLE=${JSON.stringify(electronExecutable)}\nexport HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT=1\nexec node ${JSON.stringify(cliPath)} "$@"\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['hiveward-dev', 'hiveward']) {
        const wrapperPath = path.join(targetDir, commandName)
        writeFileSync(wrapperPath, wrapperContent, 'utf8')
        chmodSync(wrapperPath, 0o755)
      }
    }
  }

  return { binDir, userDataBinDir }
}
