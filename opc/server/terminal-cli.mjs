import { join, win32 } from 'node:path'

let cliDirectory
export function configureTerminalCli(directory) {
  cliDirectory = directory
}

export function terminalCliParams(params, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !cliDirectory) {
    return params
  }
  const path = env.Path ?? env.PATH ?? ''
  const home = env.USERPROFILE || ''
  const folders = [
    cliDirectory,
    path,
    env.APPDATA && win32.join(env.APPDATA, 'npm'),
    home && win32.join(home, '.local', 'bin'),
    home && win32.join(home, '.cargo', 'bin')
  ].filter(Boolean)
  return {
    ...params,
    shell: params.shell ?? 'powershell.exe',
    env: {
      ...params.env,
      Path: folders.join(';'),
      PATH: folders.join(';'),
      OPC_BRIDGE: env.OPC_BRIDGE || 'http://127.0.0.1:47615',
      HIVEWARD_EXECUTABLE: env.HIVEWARD_EXECUTABLE
    }
  }
}

export const packagedCliDirectory = (root) => join(root, 'bin')
