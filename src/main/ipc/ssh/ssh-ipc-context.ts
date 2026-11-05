import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type { HiveWardRuntimeService } from '../../runtime/hiveward-runtime'

export let connectionManager: SshConnectionManager | null = null
export let portForwardManager: SshPortForwardManager | null = null
export let persistedStore: Store | null = null
let currentGetMainWindow: () => BrowserWindow | null = () => null
export let currentRuntime: HiveWardRuntimeService | undefined

export function setConnectionManager(next: SshConnectionManager | null): void {
  connectionManager = next
}

export function setPortForwardManager(next: SshPortForwardManager | null): void {
  portForwardManager = next
}

export function setPersistedStore(next: Store | null): void {
  persistedStore = next
}

export function setCurrentGetMainWindow(next: () => BrowserWindow | null): void {
  currentGetMainWindow = next
}

export function setCurrentRuntime(next: HiveWardRuntimeService | undefined): void {
  currentRuntime = next
}

export function getCurrentMainWindow(): BrowserWindow | null {
  return currentGetMainWindow()
}
