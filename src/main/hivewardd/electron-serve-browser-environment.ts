/** Strip hivewardd-owned user-data and browser overrides from the helper environment. */
export function electronServeEnvironment(userDataPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of [
    'HIVEWARD_E2E_USER_DATA_DIR',
    'HIVEWARD_USER_DATA',
    'HIVEWARD_USER_DATA_PATH',
    'AGENT_BROWSER_ARGS',
    'AGENT_BROWSER_AUTO_CONNECT',
    'AGENT_BROWSER_CDP',
    'AGENT_BROWSER_ENGINE',
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_HEADED',
    'AGENT_BROWSER_PROFILE',
    'AGENT_BROWSER_PROVIDER',
    'AGENT_BROWSER_SESSION',
    'AGENT_BROWSER_SESSION_NAME',
    'AGENT_BROWSER_STATE'
  ]) {
    delete environment[key]
  }
  // Keep Electron's native home override active in isolated sidecars.
  if (process.env.HIVEWARD_E2E_USER_DATA_DIR || process.env.HIVEWARD_E2E_HOME_DIR) {
    environment.HIVEWARD_E2E_USER_DATA_DIR = userDataPath
  }
  // Older installed apps hide without forwarding opens if given HIVEWARD_BACKGROUND_LAUNCH.
  environment.HIVEWARD_HIVEWARDD_SIDECAR = '1'
  return environment
}
