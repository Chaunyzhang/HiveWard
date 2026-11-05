import { HIVEWARD_BROWSER_CLI_COMMAND_KEYS } from '../../shared/hiveward-browser-cli-commands'
import type { HandlerGroup } from '../handler-group-manifest'

export const BROWSER_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'browser-identity',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-identity'],
    load: async () => (await import('./browser-identity.js')).BROWSER_IDENTITY_HANDLERS
  },
  {
    name: 'browser-nav',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-nav'],
    load: async () => (await import('./browser-nav.js')).BROWSER_NAV_HANDLERS
  },
  {
    name: 'browser-interact',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-interact'],
    load: async () => (await import('./browser-interact.js')).BROWSER_INTERACT_HANDLERS
  },
  {
    name: 'browser-tab',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-tab'],
    load: async () => (await import('./browser-tab.js')).BROWSER_TAB_HANDLERS
  },
  {
    name: 'browser-profile',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-profile'],
    load: async () => (await import('./browser-profile.js')).BROWSER_PROFILE_HANDLERS
  },
  {
    name: 'browser-cookie',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-cookie'],
    load: async () => (await import('./browser-cookie.js')).BROWSER_COOKIE_HANDLERS
  },
  {
    name: 'browser-capture',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-capture'],
    load: async () => (await import('./browser-capture.js')).BROWSER_CAPTURE_HANDLERS
  },
  {
    name: 'browser-env',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-env'],
    load: async () => (await import('./browser-env.js')).BROWSER_ENV_HANDLERS
  },
  {
    name: 'browser-storage',
    keys: HIVEWARD_BROWSER_CLI_COMMAND_KEYS['browser-storage'],
    load: async () => (await import('./browser-storage.js')).BROWSER_STORAGE_HANDLERS
  }
]
