// Split suites rewrite platform and agent-home environment; capture and restore the host values.
export function createPtyIpcProcessEnvScope() {
  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedHiveWardOpenCodeConfigDir = process.env.HIVEWARD_OPENCODE_CONFIG_DIR
  const savedHiveWardOpenCodeSourceConfigDir = process.env.HIVEWARD_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedHiveWardPiAgentDir = process.env.HIVEWARD_PI_CODING_AGENT_DIR
  const savedHiveWardPiSourceAgentDir = process.env.HIVEWARD_PI_SOURCE_AGENT_DIR
  const savedHiveWardCodexHome = process.env.HIVEWARD_CODEX_HOME
  const savedHiveWardOmpAgentDir = process.env.HIVEWARD_OMP_CODING_AGENT_DIR
  const savedHiveWardOmpSourceAgentDir = process.env.HIVEWARD_OMP_SOURCE_AGENT_DIR
  const savedHiveWardOmpStatusExtension = process.env.HIVEWARD_OMP_STATUS_EXTENSION
  const savedPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
  const savedHiveWardPrimeAgentSourceDir = process.env.HIVEWARD_PRIME_AGENT_SOURCE_AGENT_DIR
  const savedHiveWardPrimeAgentStatusExtension = process.env.HIVEWARD_PRIME_AGENT_STATUS_EXTENSION
  const savedHiveWardClaudeAgentStatusSettings = process.env.HIVEWARD_CLAUDE_AGENT_STATUS_SETTINGS
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.HIVEWARD_DISABLE_MACOS_LOGIN_SHELL
  const savedHiveWardUserDataPath = process.env.HIVEWARD_USER_DATA_PATH

  function applyTestEnvDefaults() {
    // POSIX is the default fixture; Windows cases explicitly opt in.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Disable the TCC argv wrapper except in its dedicated tests.
    process.env.HIVEWARD_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.HIVEWARD_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.HIVEWARD_OPENCODE_CONFIG_DIR
    delete process.env.HIVEWARD_AGENT_HOOK_ENDPOINT
    delete process.env.HIVEWARD_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.HIVEWARD_PI_SOURCE_AGENT_DIR
    delete process.env.HIVEWARD_PI_CODING_AGENT_DIR
    delete process.env.HIVEWARD_CODEX_HOME
    delete process.env.HIVEWARD_OMP_SOURCE_AGENT_DIR
    delete process.env.HIVEWARD_OMP_CODING_AGENT_DIR
    delete process.env.HIVEWARD_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.HIVEWARD_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.HIVEWARD_PRIME_AGENT_STATUS_EXTENSION
  }

  function restoreProcessEnv() {
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.HIVEWARD_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.HIVEWARD_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedHiveWardUserDataPath !== undefined) {
      process.env.HIVEWARD_USER_DATA_PATH = savedHiveWardUserDataPath
    } else {
      delete process.env.HIVEWARD_USER_DATA_PATH
    }
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedHiveWardOpenCodeConfigDir !== undefined) {
      process.env.HIVEWARD_OPENCODE_CONFIG_DIR = savedHiveWardOpenCodeConfigDir
    } else {
      delete process.env.HIVEWARD_OPENCODE_CONFIG_DIR
    }
    if (savedHiveWardOpenCodeSourceConfigDir !== undefined) {
      process.env.HIVEWARD_OPENCODE_SOURCE_CONFIG_DIR = savedHiveWardOpenCodeSourceConfigDir
    } else {
      delete process.env.HIVEWARD_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedHiveWardPiAgentDir !== undefined) {
      process.env.HIVEWARD_PI_CODING_AGENT_DIR = savedHiveWardPiAgentDir
    } else {
      delete process.env.HIVEWARD_PI_CODING_AGENT_DIR
    }
    if (savedHiveWardPiSourceAgentDir === undefined) {
      delete process.env.HIVEWARD_PI_SOURCE_AGENT_DIR
    } else {
      process.env.HIVEWARD_PI_SOURCE_AGENT_DIR = savedHiveWardPiSourceAgentDir
    }
    if (savedHiveWardCodexHome === undefined) {
      delete process.env.HIVEWARD_CODEX_HOME
    } else {
      process.env.HIVEWARD_CODEX_HOME = savedHiveWardCodexHome
    }
    if (savedHiveWardOmpAgentDir !== undefined) {
      process.env.HIVEWARD_OMP_CODING_AGENT_DIR = savedHiveWardOmpAgentDir
    } else {
      delete process.env.HIVEWARD_OMP_CODING_AGENT_DIR
    }
    if (savedHiveWardOmpSourceAgentDir !== undefined) {
      process.env.HIVEWARD_OMP_SOURCE_AGENT_DIR = savedHiveWardOmpSourceAgentDir
    } else {
      delete process.env.HIVEWARD_OMP_SOURCE_AGENT_DIR
    }
    if (savedHiveWardOmpStatusExtension !== undefined) {
      process.env.HIVEWARD_OMP_STATUS_EXTENSION = savedHiveWardOmpStatusExtension
    } else {
      delete process.env.HIVEWARD_OMP_STATUS_EXTENSION
    }
    if (savedPrimeAgentDir !== undefined) {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = savedPrimeAgentDir
    } else {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    }
    if (savedHiveWardPrimeAgentSourceDir !== undefined) {
      process.env.HIVEWARD_PRIME_AGENT_SOURCE_AGENT_DIR = savedHiveWardPrimeAgentSourceDir
    } else {
      delete process.env.HIVEWARD_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    if (savedHiveWardPrimeAgentStatusExtension !== undefined) {
      process.env.HIVEWARD_PRIME_AGENT_STATUS_EXTENSION = savedHiveWardPrimeAgentStatusExtension
    } else {
      delete process.env.HIVEWARD_PRIME_AGENT_STATUS_EXTENSION
    }
    if (savedHiveWardClaudeAgentStatusSettings === undefined) {
      delete process.env.HIVEWARD_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.HIVEWARD_CLAUDE_AGENT_STATUS_SETTINGS = savedHiveWardClaudeAgentStatusSettings
    }
  }

  return { applyTestEnvDefaults, restoreProcessEnv }
}
