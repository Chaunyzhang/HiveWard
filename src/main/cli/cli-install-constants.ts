export const DEFAULT_MAC_COMMAND_PATH = '/usr/local/bin/hiveward'
export const DEV_COMMAND_NAME = 'hiveward-dev'
// 一次性迁移：旧安装的 Linux 命令仍叫 orca，只用于识别并替换。
export const LEGACY_LINUX_COMMAND_NAME = 'orca'
export const DEV_LAUNCHER_DIR = ['cli', 'bin'] as const
// Cold PowerShell start plus the WM_SETTINGCHANGE broadcast exceeded 5 s on low-spec machines.
export const WINDOWS_PATH_WRITE_TIMEOUT_MS = 15_000
